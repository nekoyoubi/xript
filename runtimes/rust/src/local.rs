//! Host bindings whose closures are not `Send`.
//!
//! [`HostFn`] and [`AsyncHostFn`] are `Send + Sync` because the same binding
//! set can serve an [`XriptHandle`](crate::XriptHandle) or an
//! [`XriptPool`](crate::XriptPool), which run the runtime on threads of their
//! own. A host whose objects are not `Send` (an `Rc`, a `RefCell`, a handle
//! into a single-threaded engine) and that only ever drives an
//! [`XriptRuntime`] on its own thread would otherwise have to park every such
//! object in a `thread_local` and reach it from inside each binding.
//!
//! [`LocalHostBindings`] takes closures with no `Send` or `Sync` bound. It is
//! not part of [`RuntimeOptions`], which is what a handle and a pool are built
//! from, so the type system keeps local bindings off both: the only way in is
//! [`XriptRuntime::with_local_bindings`] (or [`create_local_runtime`]).
//!
//! ```compile_fail
//! let local = xript_runtime::LocalHostBindings::new();
//! let options = xript_runtime::RuntimeOptions { host_bindings: local, ..Default::default() };
//! ```
//!
//! An `XriptRuntime` is itself `Send`, so a local binding stays bound to the
//! thread that registered it: called from any other thread it throws in the
//! script instead of running, and if the runtime is dropped on another thread
//! the closure is leaked rather than dropped there.
//!
//! ```
//! use std::cell::RefCell;
//! use std::rc::Rc;
//! use xript_runtime::{create_local_runtime, LocalHostBindings, RuntimeOptions};
//!
//! let log = Rc::new(RefCell::new(Vec::new()));
//! let sink = log.clone();
//! let mut local = LocalHostBindings::new();
//! local.add_function("note", move |args| {
//!     sink.borrow_mut().push(args[0].as_str().unwrap_or("").to_string());
//!     Ok(serde_json::Value::Null)
//! });
//!
//! let manifest = r#"{ "xript": "0.10", "name": "app", "bindings": { "note": { "description": "notes" } } }"#;
//! let rt = create_local_runtime(manifest, RuntimeOptions::default(), local).unwrap();
//! rt.execute("note('hello')").unwrap();
//! assert_eq!(*log.borrow(), ["hello"]);
//! ```

use std::collections::HashMap;
use std::future::Future;
use std::mem::ManuallyDrop;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::thread::ThreadId;

use crate::error::Result;
use crate::manifest::Manifest;
use crate::sandbox::{AsyncHostFn, HostBindings, HostFn, HostNamespaceMember, RuntimeOptions, XriptRuntime};

type HostResult = std::result::Result<serde_json::Value, String>;

/// A value usable and droppable only on the thread that created it.
struct ThreadBound<T> {
    owner: ThreadId,
    value: ManuallyDrop<T>,
}

// SAFETY: the inner value is reached only through `get`, which refuses every
// thread but the owner, and `Drop` drops it only on the owner (leaking it
// anywhere else), so no thread but the owner ever touches it.
unsafe impl<T> Send for ThreadBound<T> {}
unsafe impl<T> Sync for ThreadBound<T> {}

impl<T> ThreadBound<T> {
    fn new(value: T) -> Self {
        Self { owner: std::thread::current().id(), value: ManuallyDrop::new(value) }
    }

    fn get(&self) -> Option<&T> {
        (std::thread::current().id() == self.owner).then(|| &*self.value)
    }

    fn get_mut(&mut self) -> Option<&mut T> {
        (std::thread::current().id() == self.owner).then(|| &mut *self.value)
    }
}

impl<T> Drop for ThreadBound<T> {
    fn drop(&mut self) {
        if std::thread::current().id() == self.owner {
            // SAFETY: dropped exactly once, here, on the owning thread.
            unsafe { ManuallyDrop::drop(&mut self.value) }
        }
    }
}

const OFF_THREAD: &str = "is a local binding and can only be called on the thread that registered it";

fn bind_sync<F>(name: &str, f: F) -> HostFn
where
    F: Fn(&[serde_json::Value]) -> HostResult + 'static,
{
    let name = name.to_string();
    let f = ThreadBound::new(f);
    Arc::new(move |args| match f.get() {
        Some(f) => f(args),
        None => Err(format!("{name}() {OFF_THREAD}")),
    })
}

fn bind_async<F, Fut>(name: &str, f: F) -> AsyncHostFn
where
    F: Fn(&[serde_json::Value]) -> Fut + 'static,
    Fut: Future<Output = HostResult> + 'static,
{
    let name = name.to_string();
    let f = ThreadBound::new(f);
    Arc::new(move |args| {
        let future: Pin<Box<dyn Future<Output = HostResult> + Send>> = match f.get() {
            Some(f) => Box::pin(LocalFuture { name: name.clone(), inner: ThreadBound::new(Box::pin(f(args))) }),
            None => {
                let message = format!("{name}() {OFF_THREAD}");
                Box::pin(async move { Err(message) })
            }
        };
        future
    })
}

/// A non-`Send` future that may be polled only on the thread that made it.
struct LocalFuture<Fut> {
    name: String,
    inner: ThreadBound<Pin<Box<Fut>>>,
}

impl<Fut: Future<Output = HostResult>> Future for LocalFuture<Fut> {
    type Output = HostResult;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<HostResult> {
        let this = self.get_mut();
        match this.inner.get_mut() {
            Some(inner) => inner.as_mut().poll(cx),
            None => Poll::Ready(Err(format!("{}() {OFF_THREAD}", this.name))),
        }
    }
}

/// Host bindings whose closures need not be `Send` or `Sync`, for an
/// [`XriptRuntime`] driven on one thread. See the [module docs](self).
#[derive(Default)]
pub struct LocalHostBindings {
    bindings: HostBindings,
}

impl LocalHostBindings {
    pub fn new() -> Self {
        Self::default()
    }

    /// A synchronous binding.
    pub fn add_function<F>(&mut self, name: impl Into<String>, f: F)
    where
        F: Fn(&[serde_json::Value]) -> HostResult + 'static,
    {
        let name = name.into();
        let bound = bind_sync(&name, f);
        self.bindings.add_function(name, move |args| bound(args));
    }

    /// An async binding. Its future need not be `Send`.
    pub fn add_async_function<F, Fut>(&mut self, name: impl Into<String>, f: F)
    where
        F: Fn(&[serde_json::Value]) -> Fut + 'static,
        Fut: Future<Output = HostResult> + 'static,
    {
        let name = name.into();
        let bound = bind_async(&name, f);
        self.bindings.add_async_function(name, move |args| bound(args));
    }

    /// Starts a namespace, mirroring [`HostBindings::namespace`].
    pub fn namespace(&mut self, name: impl Into<String>) -> LocalNamespaceBuilder<'_> {
        LocalNamespaceBuilder { owner: self, name: name.into(), members: HashMap::new() }
    }

    pub(crate) fn into_host_bindings(self) -> HostBindings {
        self.bindings
    }
}

/// A fluent combinator for a namespace on [`LocalHostBindings`].
pub struct LocalNamespaceBuilder<'a> {
    owner: &'a mut LocalHostBindings,
    name: String,
    members: HashMap<String, HostNamespaceMember>,
}

impl LocalNamespaceBuilder<'_> {
    /// Adds a synchronous member.
    pub fn bind_sync<F>(mut self, name: impl Into<String>, f: F) -> Self
    where
        F: Fn(&[serde_json::Value]) -> HostResult + 'static,
    {
        let name = name.into();
        let qualified = format!("{}.{}", self.name, name);
        self.members.insert(name, HostNamespaceMember::Function(bind_sync(&qualified, f)));
        self
    }

    /// Adds an async member. Its future need not be `Send`.
    pub fn bind<F, Fut>(mut self, name: impl Into<String>, f: F) -> Self
    where
        F: Fn(&[serde_json::Value]) -> Fut + 'static,
        Fut: Future<Output = HostResult> + 'static,
    {
        let name = name.into();
        let qualified = format!("{}.{}", self.name, name);
        self.members.insert(name, HostNamespaceMember::AsyncFunction(bind_async(&qualified, f)));
        self
    }

    /// Adds an eager property value.
    pub fn property(mut self, name: impl Into<String>, value: serde_json::Value) -> Self {
        self.members.insert(name.into(), HostNamespaceMember::Property(value));
        self
    }

    /// Registers the namespace on the owning [`LocalHostBindings`].
    pub fn finish(self) {
        self.owner.bindings.add_nested_namespace(self.name, self.members);
    }
}

impl XriptRuntime {
    /// Builds a runtime whose bindings include `local`, closures with no
    /// `Send` bound. A name in both `options.host_bindings` and `local` takes
    /// the local binding.
    ///
    /// Only an `XriptRuntime` accepts local bindings: an
    /// [`XriptHandle`](crate::XriptHandle) or [`XriptPool`](crate::XriptPool)
    /// is built from [`RuntimeOptions`] alone. Drive the runtime from the
    /// thread that built `local`; see the [module docs](self).
    pub fn with_local_bindings(manifest: Manifest, mut options: RuntimeOptions, local: LocalHostBindings) -> Result<Self> {
        options.host_bindings.absorb(local.into_host_bindings());
        XriptRuntime::new(manifest, options)
    }
}

/// [`create_runtime`](crate::create_runtime) with local bindings. See
/// [`XriptRuntime::with_local_bindings`].
pub fn create_local_runtime(manifest_json: &str, options: RuntimeOptions, local: LocalHostBindings) -> Result<XriptRuntime> {
    let raw: serde_json::Value = serde_json::from_str(manifest_json)?;
    crate::manifest::check_raw_shape(&raw)?;
    let manifest: Manifest = serde_json::from_value(raw).map_err(crate::error::XriptError::Json)?;
    XriptRuntime::with_local_bindings(manifest, options, local)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_bound_value_refuses_other_threads() {
        let bound = Arc::new(ThreadBound::new(std::rc::Rc::new(5)));
        assert_eq!(bound.get().map(|v| **v), Some(5));
        let elsewhere = bound.clone();
        let seen = std::thread::spawn(move || elsewhere.get().is_some()).join().unwrap();
        assert!(!seen);
    }
}
