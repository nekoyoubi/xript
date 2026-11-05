//! Retained callbacks: script functions a host keeps past the binding call
//! that received them.
//!
//! A callback is call-scoped unless the manifest marks its position
//! `"retain": true`. A callback found at such a position can be retained with
//! [`Callback::retain`](crate::Callback::retain), which hands back a
//! [`RetainedCallback`]. The host calls it later, either re-entrantly from
//! inside a binding call (spending that script call's budget) or between
//! script calls (on a fresh budget), and releases it when done. A retained
//! callback passed back into the sandbox as its marker
//! ([`RetainedCallback::to_value`]) arrives as the original script function.
//!
//! [`RetainedCallback::call`] is synchronous and refuses a callback that
//! returns a promise. [`RetainedCallback::call_async`] accepts one (an `async`
//! function, say) and returns a future that drives the runtime's jobs until the
//! promise settles. It is safe anywhere `call` is, nested inside a binding of
//! the same runtime included:
//!
//! ```ignore
//! // script: keep(async function (id) { const row = await db.load(id); return row.name; })
//! let name = retained.call_async(&[serde_json::json!(7)]).await?;
//! ```

use std::collections::HashMap;
use std::fmt;
use std::hash::{BuildHasher, Hash, Hasher, RandomState};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use rquickjs::{Ctx, Function, JsLifetime, Persistent, Value};

use crate::callback::{CallbackError, ExpiredCause, CALLBACK_MARKER};
use crate::caller_context::CallerContext;
use crate::manifest::{Binding, Manifest, Parameter, TypeDefinition};

/// The default for `limits.max_retained_callbacks`.
pub const DEFAULT_MAX_RETAINED_CALLBACKS: usize = 10_000;

/// Why [`Callback::retain`](crate::Callback::retain) refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetainError {
    /// The callback is not at a parameter or field the manifest marks `retain`.
    Undeclared { binding: String },
    /// The runtime already holds `max_retained_callbacks` retained callbacks.
    Limit { binding: String, limit: usize },
    /// The binding call that received the callback has already returned, or
    /// `retain` was called from another thread.
    Expired { binding: String },
}

impl RetainError {
    /// The binding the callback was passed to.
    pub fn binding(&self) -> &str {
        match self {
            RetainError::Undeclared { binding }
            | RetainError::Limit { binding, .. }
            | RetainError::Expired { binding } => binding,
        }
    }

    /// `"undeclared"`, `"limit"`, or `"expired"`, matching the other runtimes.
    pub fn reason(&self) -> &'static str {
        match self {
            RetainError::Undeclared { .. } => "undeclared",
            RetainError::Limit { .. } => "limit",
            RetainError::Expired { .. } => "expired",
        }
    }
}

impl fmt::Display for RetainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RetainError::Undeclared { binding } => write!(
                f,
                "{binding}(): callback cannot be retained; only a callback at a parameter or field the manifest marks \"retain\": true can be retained"
            ),
            RetainError::Limit { binding, limit } => write!(
                f,
                "{binding}(): callback cannot be retained; the runtime already holds max_retained_callbacks ({limit}) retained callbacks"
            ),
            RetainError::Expired { binding } => write!(
                f,
                "{}",
                CallbackError::Expired {
                    binding: binding.clone(),
                }
            ),
        }
    }
}

impl std::error::Error for RetainError {}

impl From<RetainError> for String {
    fn from(error: RetainError) -> String {
        error.to_string()
    }
}

/// A script function the host retained. Cheap to clone; every clone names the
/// same retained callback and compares equal to it. It stays callable until
/// released, until the mod that supplied it is released, or until the runtime
/// is dropped.
#[derive(Clone)]
pub struct RetainedCallback {
    registry: Weak<RetainedRegistry>,
    registry_id: u64,
    nonce: u64,
    id: u64,
    binding: String,
}

impl RetainedCallback {
    /// The binding the callback was retained from.
    pub fn binding(&self) -> &str {
        &self.binding
    }

    /// The token inside this callback's marker.
    pub fn token(&self) -> String {
        format!("r:{}:{}:{}", self.id, self.nonce, self.binding)
    }

    /// The marker object, `{ "$xriptCallback": "<token>" }`, that stands for
    /// this callback in JSON. Passed back into the sandbox (a binding's return
    /// value, hook data, an event payload, export arguments, callback
    /// arguments) it arrives as the original script function.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::json!({ CALLBACK_MARKER: self.token() })
    }

    /// Calls the script function with `args` and returns what it returned,
    /// both marshalled as JSON. From inside a binding call it runs on that
    /// script call's budget; between script calls it runs on a fresh one.
    /// Fails with [`CallbackError::Released`] once released and with
    /// [`CallbackError::RetainedExpired`] from another thread.
    pub fn call(&self, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError> {
        let Some(registry) = self.registry.upgrade() else {
            return Err(CallbackError::Released {
                binding: self.binding.clone(),
            });
        };
        registry.call(self, args)
    }

    /// Calls the script function with `args`, as [`call`](Self::call) does,
    /// except that a promise it returns (an `async` function's, say) is not
    /// refused: the returned future drives the runtime's jobs until that
    /// promise settles, then resolves to its value, or fails with
    /// [`CallbackError::Threw`] carrying its rejection.
    ///
    /// It is safe to call nested, as `call` is: from inside a host binding
    /// running in this same runtime (where `call` refuses a promise with
    /// [`CallbackError::Promise`]), from inside another retained callback, or
    /// between script calls. Nested, it runs in place on the calling script's
    /// budget and settles before the future is first polled to completion,
    /// with any async binding the callback awaits settled in place, as on a
    /// sync runtime. Between script calls it runs on a fresh budget, which
    /// bounds the whole call, time spent waiting on the promise included. On
    /// an async-mode runtime the future then yields while the promise waits
    /// on an async binding, releasing the runtime to other calls; on a
    /// sync-mode runtime it completes on its first poll.
    ///
    /// Fails like `call` once released and from another thread.
    pub async fn call_async(&self, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError> {
        let Some(registry) = self.registry.upgrade() else {
            return Err(CallbackError::Released {
                binding: self.binding.clone(),
            });
        };
        registry.call_async(self, args).await
    }

    /// Releases the callback. Releasing twice does nothing.
    pub fn release(&self) {
        if let Some(registry) = self.registry.upgrade() {
            registry.release(self.id);
        }
    }

    /// Whether the callback has been released (or its runtime dropped).
    pub fn is_released(&self) -> bool {
        match self.registry.upgrade() {
            Some(registry) => !registry.is_live(self.id),
            None => true,
        }
    }
}

impl PartialEq for RetainedCallback {
    fn eq(&self, other: &Self) -> bool {
        self.registry_id == other.registry_id && self.id == other.id && self.nonce == other.nonce
    }
}

impl Eq for RetainedCallback {}

impl Hash for RetainedCallback {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.registry_id.hash(state);
        self.id.hash(state);
    }
}

impl fmt::Debug for RetainedCallback {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RetainedCallback")
            .field("id", &self.id)
            .field("binding", &self.binding)
            .finish_non_exhaustive()
    }
}

/// A script function kept alive past its call. QuickJS values are not
/// thread-safe, so one is only ever cloned, restored, or dropped while the
/// runtime lock is held; the registry defers drops it cannot make under the
/// lock to the next time it holds it.
struct Held(Persistent<Function<'static>>);

// SAFETY: see `Held`. Every touch of the inner value happens inside a context
// lock, which serializes access to the QuickJS runtime across threads.
unsafe impl Send for Held {}
unsafe impl Sync for Held {}

struct Entry {
    function: Option<Held>,
    owner: Option<String>,
    binding: String,
    thread: ThreadId,
    identity: u64,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<u64, Entry>,
    by_identity: HashMap<(u64, Option<String>), u64>,
    live: usize,
    graveyard: Vec<Held>,
    disposed: bool,
}

/// How a retained callback enters the context between script calls.
pub(crate) enum ContextHandle {
    Sync(rquickjs::Context),
    Async(rquickjs::AsyncContext),
}

impl ContextHandle {
    fn with<R>(&self, f: impl for<'js> FnOnce(Ctx<'js>) -> R) -> R {
        match self {
            ContextHandle::Sync(ctx) => ctx.with(|ctx| {
                let _held = crate::reentry::Holding::new(&ctx);
                let _entry = crate::stack_guard::enter(&ctx);
                f(ctx.clone())
            }),
            ContextHandle::Async(ctx) => {
                let f = crate::yielding::AssertSend(f);
                pollster::block_on(ctx.with(move |ctx| {
                    let f = f;
                    let _held = crate::reentry::Holding::new(&ctx);
                    let _entry = crate::stack_guard::enter(&ctx);
                    crate::yielding::AssertSend(f.into_inner()(ctx.clone()))
                }))
                .into_inner()
            }
        }
    }
}

/// What a retained callback needs to run between script calls: the context,
/// and the runtime's interrupt frames and budget so it gets a fresh one.
pub(crate) struct Attachment {
    pub(crate) context: ContextHandle,
    /// The context's identity, to recognize it as already held on this thread.
    pub(crate) key: usize,
    pub(crate) frames: crate::sandbox::InterruptFrames,
    pub(crate) timeout_ms: u64,
    pub(crate) cancellation: Option<crate::sandbox::CancellationToken>,
}

static NEXT_REGISTRY: AtomicU64 = AtomicU64::new(1);
static NEXT_RETAINED: AtomicU64 = AtomicU64::new(1);

/// One runtime's retained callbacks.
pub(crate) struct RetainedRegistry {
    id: u64,
    nonce: u64,
    limit: usize,
    positions: RetainPositions,
    caller: CallerContext,
    inner: Mutex<Inner>,
    attached: OnceLock<Attachment>,
}

impl RetainedRegistry {
    pub(crate) fn new(manifest: &Manifest, caller: CallerContext) -> Arc<Self> {
        let id = NEXT_REGISTRY.fetch_add(1, Ordering::Relaxed);
        Arc::new(Self {
            id,
            // A random, process-local nonce makes a retained token unforgeable:
            // nothing a script can spell carries it, and tokens never enter the
            // sandbox.
            nonce: RandomState::new().hash_one(("retained", id)),
            limit: manifest
                .limits
                .as_ref()
                .and_then(|l| l.max_retained_callbacks)
                .unwrap_or(DEFAULT_MAX_RETAINED_CALLBACKS),
            positions: RetainPositions::from_manifest(manifest),
            caller,
            inner: Mutex::new(Inner::default()),
            attached: OnceLock::new(),
        })
    }

    pub(crate) fn attach(&self, attachment: Attachment) {
        let _ = self.attached.set(attachment);
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    pub(crate) fn caller(&self) -> &CallerContext {
        &self.caller
    }

    pub(crate) fn is_retainable(&self, binding: &str, path: &[PathStep]) -> bool {
        self.positions.is_retainable(binding, path)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn handle(self: &Arc<Self>, id: u64, binding: &str) -> RetainedCallback {
        RetainedCallback {
            registry: Arc::downgrade(self),
            registry_id: self.id,
            nonce: self.nonce,
            id,
            binding: binding.to_string(),
        }
    }

    fn is_live(&self, id: u64) -> bool {
        let inner = self.lock();
        !inner.disposed && inner.entries.get(&id).is_some_and(|e| e.function.is_some())
    }

    /// Retains `function`, received by `binding` at a position that is
    /// `retainable` or not. Runs inside the binding call, under the runtime
    /// lock.
    pub(crate) fn retain<'js>(
        self: &Arc<Self>,
        ctx: &Ctx<'js>,
        function: &Function<'js>,
        binding: &str,
        retainable: bool,
    ) -> Result<RetainedCallback, RetainError> {
        let owner = self.caller.current();
        let identity = identity_of(function.as_value());
        let mut inner = self.lock();
        inner.graveyard.clear();
        if inner.disposed {
            return Err(RetainError::Expired {
                binding: binding.to_string(),
            });
        }
        if let Some(&id) = inner.by_identity.get(&(identity, owner.clone())) {
            let existing = inner.entries[&id].binding.clone();
            return Ok(self.handle(id, &existing));
        }
        if !retainable {
            return Err(RetainError::Undeclared {
                binding: binding.to_string(),
            });
        }
        if inner.live >= self.limit {
            return Err(RetainError::Limit {
                binding: binding.to_string(),
                limit: self.limit,
            });
        }
        let id = NEXT_RETAINED.fetch_add(1, Ordering::Relaxed);
        inner.entries.insert(
            id,
            Entry {
                function: Some(Held(Persistent::save(ctx, function.clone()))),
                owner: owner.clone(),
                binding: binding.to_string(),
                thread: std::thread::current().id(),
                identity,
            },
        );
        inner.by_identity.insert((identity, owner), id);
        inner.live += 1;
        Ok(self.handle(id, binding))
    }

    pub(crate) fn release(&self, id: u64) {
        let mut inner = self.lock();
        release_entry(&mut inner, id);
    }

    /// Releases every callback `mod_name` supplied; returns how many.
    pub(crate) fn release_mod(&self, mod_name: &str) -> usize {
        let mut inner = self.lock();
        let ids: Vec<u64> = inner
            .entries
            .iter()
            .filter(|(_, e)| e.function.is_some() && e.owner.as_deref() == Some(mod_name))
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            release_entry(&mut inner, *id);
        }
        ids.len()
    }

    /// The live function behind `id`, restored into `ctx`. Must run under the
    /// runtime lock, which `ctx` proves.
    pub(crate) fn restore<'js>(&self, ctx: &Ctx<'js>, id: u64) -> Option<Function<'js>> {
        let held = {
            let mut inner = self.lock();
            inner.graveyard.clear();
            if inner.disposed {
                return None;
            }
            inner.entries.get(&id)?.function.as_ref()?.0.clone()
        };
        held.restore(ctx).ok()
    }

    fn call(self: &Arc<Self>, handle: &RetainedCallback, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError> {
        let binding = handle.binding.clone();
        let (thread, owner) = {
            let inner = self.lock();
            match inner.entries.get(&handle.id) {
                Some(entry) if !inner.disposed && entry.function.is_some() => (entry.thread, entry.owner.clone()),
                _ => return Err(CallbackError::Released { binding }),
            }
        };
        if thread != std::thread::current().id() {
            return Err(CallbackError::RetainedExpired {
                binding,
                cause: ExpiredCause::OtherThread,
            });
        }
        if let Some(result) = crate::callback::invoke_retained_reentrant(self, handle.id, &binding, owner.clone(), args) {
            return result;
        }
        let Some(attached) = self.attached.get() else {
            return Err(CallbackError::Released { binding });
        };
        if let Some(raw) = crate::reentry::held(attached.key) {
            let interrupted = AtomicBool::new(false);
            let _caller = self.caller.enter(owner);
            // SAFETY: `held` found the context on this thread's record, so its
            // lock is held further up this thread's stack for the whole call.
            return unsafe {
                crate::reentry::with_held(raw, |ctx| {
                    let Some(function) = self.restore(&ctx, handle.id) else {
                        return Err(CallbackError::Released { binding: binding.clone() });
                    };
                    crate::callback::call_detached(&ctx, &function, &binding, args, &interrupted)
                })
            };
        }
        if crate::sandbox::frames_live_on_this_thread(&attached.frames) {
            // An execution region is live on this thread without its context
            // recorded as held, so taking the lock could wait on that region.
            return Err(CallbackError::RetainedExpired {
                binding,
                cause: ExpiredCause::OtherThread,
            });
        }

        let interrupted = Arc::new(AtomicBool::new(false));
        let _frame = crate::sandbox::push_frame(
            &attached.frames,
            crate::sandbox::InterruptFrame {
                deadline: Instant::now() + Duration::from_millis(attached.timeout_ms),
                token: attached.cancellation.clone(),
                call_token: None,
                debug_clock: None,
                interrupted: interrupted.clone(),
                cancelled: Arc::new(AtomicBool::new(false)),
                lane: None,
            },
        );
        let _caller = self.caller.enter(owner);
        attached.context.with(|ctx| {
            let Some(function) = self.restore(&ctx, handle.id) else {
                return Err(CallbackError::Released { binding: binding.clone() });
            };
            crate::callback::call_detached(&ctx, &function, &binding, args, &interrupted)
        })
    }

    async fn call_async(
        self: &Arc<Self>,
        handle: &RetainedCallback,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value, CallbackError> {
        let binding = handle.binding.clone();
        let (thread, owner) = {
            let inner = self.lock();
            match inner.entries.get(&handle.id) {
                Some(entry) if !inner.disposed && entry.function.is_some() => (entry.thread, entry.owner.clone()),
                _ => return Err(CallbackError::Released { binding }),
            }
        };
        if thread != std::thread::current().id() {
            return Err(CallbackError::RetainedExpired {
                binding,
                cause: ExpiredCause::OtherThread,
            });
        }
        let Some(attached) = self.attached.get() else {
            return Err(CallbackError::Released { binding });
        };

        let interrupted = Arc::new(AtomicBool::new(false));
        if let Some(raw) = crate::reentry::held(attached.key) {
            let _caller = self.caller.enter(owner);
            // SAFETY: `held` found the context on this thread's record, so its
            // lock is held further up this thread's stack for the whole call.
            return unsafe {
                crate::reentry::with_held(raw, |ctx| {
                    let Some(function) = self.restore(&ctx, handle.id) else {
                        return Err(CallbackError::Released { binding: binding.clone() });
                    };
                    crate::callback::call_settling(&ctx, &function, &binding, args, &interrupted)
                })
            };
        }

        let frame = crate::sandbox::InterruptFrame {
            deadline: Instant::now() + Duration::from_millis(attached.timeout_ms),
            token: attached.cancellation.clone(),
            call_token: None,
            debug_clock: None,
            interrupted: interrupted.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
            lane: None,
        };
        let _caller = self.caller.enter(owner);
        match &attached.context {
            ContextHandle::Sync(_) => {
                let _frame = crate::sandbox::push_frame(&attached.frames, frame);
                attached.context.with(|ctx| {
                    let Some(function) = self.restore(&ctx, handle.id) else {
                        return Err(CallbackError::Released { binding: binding.clone() });
                    };
                    crate::callback::call_settling(&ctx, &function, &binding, args, &interrupted)
                })
            }
            ContextHandle::Async(context) => {
                let watch = crate::yielding::Watch::new(&frame);
                let lane = self.caller.fork();
                let registry = self.clone();
                let id = handle.id;
                let args = args.to_vec();
                let body_watch = watch.clone();
                let body_binding = binding.clone();
                let body_interrupted = interrupted.clone();
                let call = rquickjs::async_with!(context => |ctx| {
                    crate::stack_guard::fit(&ctx);
                    let Some(function) = registry.restore(&ctx, id) else {
                        return Err(CallbackError::Released { binding: body_binding });
                    };
                    crate::callback::call_settling_async(&ctx, &function, &body_binding, &args, &body_interrupted, body_watch).await
                });
                let outcome = PerPoll {
                    frames: &attached.frames,
                    frame,
                    key: attached.key,
                    caller: &self.caller,
                    lane: lane.id(),
                    inner: Box::pin(call),
                    started: false,
                    done: false,
                }
                .await;
                watch.finish();
                outcome
            }
        }
    }

    /// Resolves a marker token crossing into the sandbox to the function it
    /// names. A token this runtime never issued is not its business: it
    /// resolves to `None` and the marker crosses as the plain data it is.
    fn resolve<'js>(&self, ctx: &Ctx<'js>, token: &str) -> Result<Option<Function<'js>>, CallbackError> {
        let Some((id, nonce, binding)) = parse_token(token) else {
            return Ok(None);
        };
        if nonce != self.nonce {
            return Ok(None);
        }
        let owner = {
            let inner = self.lock();
            match inner.entries.get(&id) {
                None => return Ok(None),
                Some(_) if inner.disposed => return Err(CallbackError::Released { binding }),
                Some(entry) if entry.function.is_none() => return Err(CallbackError::Released { binding }),
                Some(entry) => entry.owner.clone(),
            }
        };
        if let Some(current) = self.caller.current()
            && owner.as_deref() != Some(current.as_str())
        {
            return Err(CallbackError::RetainedExpired {
                binding,
                cause: ExpiredCause::Foreign,
            });
        }
        self.restore(ctx, id)
            .map(Some)
            .ok_or(CallbackError::Released { binding })
    }
}

/// Drives an async-mode [`RetainedCallback::call_async`] between script calls:
/// each poll runs inside the call's interrupt frame, in the call's own caller
/// lane, with the context recorded as held. Dropped before it completes, it
/// cancels the call and drives it to that point here, because the suspended
/// body owns JS values that may only be released under the runtime lock.
struct PerPoll<'a, F: std::future::Future> {
    frames: &'a crate::sandbox::InterruptFrames,
    frame: crate::sandbox::InterruptFrame,
    key: usize,
    caller: &'a CallerContext,
    lane: u64,
    inner: std::pin::Pin<Box<F>>,
    started: bool,
    done: bool,
}

impl<F: std::future::Future> PerPoll<'_, F> {
    fn poll_inner(&mut self, cx: &mut std::task::Context<'_>) -> std::task::Poll<F::Output> {
        let _frame = crate::sandbox::push_frame(self.frames, self.frame.clone());
        let _lane = self.caller.activate(self.lane);
        let _held = crate::reentry::Holding::of(self.key);
        self.started = true;
        let polled = self.inner.as_mut().poll(cx);
        self.done = polled.is_ready();
        polled
    }
}

impl<F: std::future::Future> std::future::Future for PerPoll<'_, F> {
    type Output = F::Output;

    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<F::Output> {
        // SAFETY: nothing is moved out of `self`; `inner` is pinned on the heap.
        unsafe { self.get_unchecked_mut() }.poll_inner(cx)
    }
}

impl<F: std::future::Future> Drop for PerPoll<'_, F> {
    fn drop(&mut self) {
        if !self.started || self.done {
            return;
        }
        self.frame.cancelled.store(true, Ordering::Relaxed);
        let _ = pollster::block_on(std::future::poll_fn(|cx| self.poll_inner(cx)));
    }
}

impl Drop for RetainedRegistry {
    fn drop(&mut self) {
        let held: Vec<Held> = {
            let mut inner = self.lock();
            inner.disposed = true;
            inner.by_identity.clear();
            let mut held: Vec<Held> = inner.entries.values_mut().filter_map(|e| e.function.take()).collect();
            held.append(&mut inner.graveyard);
            held
        };
        match self.attached.get() {
            Some(attached) => attached.context.with(move |_ctx| drop(held)),
            None => drop(held),
        }
    }
}

fn release_entry(inner: &mut Inner, id: u64) {
    let Some(entry) = inner.entries.get_mut(&id) else {
        return;
    };
    let Some(function) = entry.function.take() else {
        return;
    };
    let key = (entry.identity, entry.owner.clone());
    inner.graveyard.push(function);
    inner.by_identity.remove(&key);
    inner.live -= 1;
}

fn parse_token(token: &str) -> Option<(u64, u64, String)> {
    let mut parts = token.splitn(4, ':');
    if parts.next()? != "r" {
        return None;
    }
    let id = parts.next()?.parse().ok()?;
    let nonce = parts.next()?.parse().ok()?;
    let binding = parts.next()?.to_string();
    Some((id, nonce, binding))
}

/// A script function's identity: QuickJS objects never move, so the pointer
/// bits identify one for as long as it is alive, and a retained one is.
fn identity_of(value: &Value<'_>) -> u64 {
    #[derive(Default)]
    struct Bits(u64);
    impl Hasher for Bits {
        fn finish(&self) -> u64 {
            self.0
        }
        fn write(&mut self, _bytes: &[u8]) {}
        fn write_u64(&mut self, n: u64) {
            self.0 = n;
        }
    }
    let mut bits = Bits::default();
    value.hash(&mut bits);
    bits.finish()
}

/// The token of a marker object, if `value` is one.
pub(crate) fn marker_token(value: &serde_json::Value) -> Option<&str> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.get(CALLBACK_MARKER)?.as_str()
}


/// Ties a context to its runtime's registry, so a binding call can find the
/// retain positions and the registry from the context alone.
struct RegistrySlot(Weak<RetainedRegistry>);

// SAFETY: `RegistrySlot` holds no JS values, so it has no `'js` lifetime to change.
unsafe impl<'js> JsLifetime<'js> for RegistrySlot {
    type Changed<'to> = RegistrySlot;
}

/// The registry of the runtime that owns `ctx`.
pub(crate) fn registry_of(ctx: &Ctx<'_>) -> Option<Arc<RetainedRegistry>> {
    ctx.userdata::<RegistrySlot>()?.0.upgrade()
}

/// Links `ctx` to `registry`.
pub(crate) fn install(ctx: &Ctx<'_>, registry: &Arc<RetainedRegistry>) {
    let _ = ctx.store_userdata(RegistrySlot(Arc::downgrade(registry)));
}

/// Turns host JSON into a sandbox value, reviving any retained marker in it
/// into its function. A marker that does not resolve fails with its reason.
pub(crate) fn host_value_to_js<'js>(ctx: &Ctx<'js>, value: &serde_json::Value) -> Result<Value<'js>, HostValueError> {
    let resolve = |token: &str| match registry_of(ctx) {
        Some(registry) => registry.resolve(ctx, token),
        None => Ok(None),
    };
    crate::marshal::build(ctx, value, Some(&resolve)).map_err(|error| match error {
        crate::marshal::BuildError::Engine(error) => HostValueError::Marshal(error.to_string()),
        crate::marshal::BuildError::Refused(message) => HostValueError::Marshal(message),
        crate::marshal::BuildError::Callback(error) => HostValueError::Callback(error),
    })
}

/// [`host_value_to_js`] for a list of values, built as one sandbox array.
pub(crate) fn host_list_to_js<'js>(
    ctx: &Ctx<'js>,
    items: &[serde_json::Value],
) -> Result<rquickjs::Array<'js>, HostValueError> {
    let resolve = |token: &str| match registry_of(ctx) {
        Some(registry) => registry.resolve(ctx, token),
        None => Ok(None),
    };
    crate::marshal::build_list(ctx, items, Some(&resolve)).map_err(|error| match error {
        crate::marshal::BuildError::Engine(error) => HostValueError::Marshal(error.to_string()),
        crate::marshal::BuildError::Refused(message) => HostValueError::Marshal(message),
        crate::marshal::BuildError::Callback(error) => HostValueError::Callback(error),
    })
}

/// Why a host value could not cross into the sandbox.
pub(crate) enum HostValueError {
    Marshal(String),
    Callback(CallbackError),
}

/// One step of where a callback was found in a binding's arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PathStep {
    Index(usize),
    Key(String),
}

/// One declared parameter, as far as retain positions care.
#[derive(Debug, Clone)]
struct ParamShape {
    node: TypeNode,
    retain: bool,
    variadic: bool,
}

/// Which positions in each binding's arguments the manifest marks `retain`.
/// A callback's path is checked by walking the declared types along it, so a
/// recursive type (a tree whose every node holds a retained action) is covered
/// at any depth.
#[derive(Debug, Clone, Default)]
pub(crate) struct RetainPositions {
    bindings: HashMap<String, Vec<ParamShape>>,
    types: HashMap<String, HashMap<String, (TypeNode, bool)>>,
}

impl RetainPositions {
    pub(crate) fn from_manifest(manifest: &Manifest) -> Self {
        let mut positions = RetainPositions::default();
        if let Some(types) = manifest.types.as_ref() {
            positions.types = types_table(types);
        }
        if let Some(bindings) = manifest.bindings.as_ref() {
            collect_bindings(bindings, "", &mut positions.bindings);
        }
        positions
    }

    /// Whether the callback found at `path` in `binding`'s arguments sits at a
    /// retain-marked position.
    pub(crate) fn is_retainable(&self, binding: &str, path: &[PathStep]) -> bool {
        let Some(params) = self.bindings.get(binding) else {
            return false;
        };
        let Some((PathStep::Index(index), rest)) = path.split_first() else {
            return false;
        };
        let param = match params.get(*index) {
            Some(param) => param,
            None => match params.last() {
                Some(last) if last.variadic => last,
                _ => return false,
            },
        };
        self.matches(&param.node, param.retain, rest)
    }

    fn matches(&self, node: &TypeNode, retain: bool, path: &[PathStep]) -> bool {
        match node {
            TypeNode::Optional(inner) => self.matches(inner, retain, path),
            TypeNode::Function => retain && path.is_empty(),
            TypeNode::Array(inner) => {
                matches!(path.first(), Some(PathStep::Index(_))) && self.matches(inner, false, &path[1..])
            }
            TypeNode::Map(inner) => {
                matches!(path.first(), Some(PathStep::Key(_))) && self.matches(inner, false, &path[1..])
            }
            TypeNode::Union(branches) => branches.iter().any(|branch| self.matches(branch, false, path)),
            TypeNode::Name(name) => match path.split_first() {
                Some((PathStep::Key(key), rest)) => self
                    .types
                    .get(name)
                    .and_then(|fields| fields.get(key))
                    .is_some_and(|(field, field_retain)| self.matches(field, *field_retain, rest)),
                _ => false,
            },
        }
    }
}

/// A parsed type reference, as far as retain positions care.
#[derive(Debug, Clone, PartialEq)]
enum TypeNode {
    Function,
    Name(String),
    Optional(Box<TypeNode>),
    Array(Box<TypeNode>),
    Map(Box<TypeNode>),
    Union(Vec<TypeNode>),
}

fn type_node(type_ref: &serde_json::Value) -> Option<TypeNode> {
    match type_ref {
        serde_json::Value::String(text) => parse_type_text(text),
        serde_json::Value::Object(map) => {
            if map.contains_key("function") {
                Some(TypeNode::Function)
            } else if let Some(inner) = map.get("optional") {
                Some(TypeNode::Optional(Box::new(type_node(inner)?)))
            } else if let Some(inner) = map.get("array") {
                Some(TypeNode::Array(Box::new(type_node(inner)?)))
            } else if let Some(inner) = map.get("map") {
                Some(TypeNode::Map(Box::new(type_node(inner)?)))
            } else if let Some(serde_json::Value::Array(branches)) = map.get("union") {
                Some(TypeNode::Union(branches.iter().filter_map(type_node).collect()))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Parses `union := postfix ('|' postfix)*`, `postfix := primary ('[]' | '?')*`,
/// `primary := name | '(' union ')'`.
fn parse_type_text(text: &str) -> Option<TypeNode> {
    struct Parser<'a> {
        chars: std::iter::Peekable<std::str::CharIndices<'a>>,
        text: &'a str,
    }
    impl Parser<'_> {
        fn skip_ws(&mut self) {
            while self.chars.peek().is_some_and(|(_, c)| c.is_whitespace()) {
                self.chars.next();
            }
        }
        fn union(&mut self) -> Option<TypeNode> {
            let mut branches = vec![self.postfix()?];
            loop {
                self.skip_ws();
                if self.chars.peek().is_some_and(|(_, c)| *c == '|') {
                    self.chars.next();
                    branches.push(self.postfix()?);
                } else {
                    break;
                }
            }
            Some(if branches.len() == 1 { branches.pop()? } else { TypeNode::Union(branches) })
        }
        fn postfix(&mut self) -> Option<TypeNode> {
            let mut node = self.primary()?;
            loop {
                self.skip_ws();
                match self.chars.peek().map(|(_, c)| *c) {
                    Some('?') => {
                        self.chars.next();
                        node = TypeNode::Optional(Box::new(node));
                    }
                    Some('[') => {
                        self.chars.next();
                        self.skip_ws();
                        if self.chars.next().map(|(_, c)| c) != Some(']') {
                            return None;
                        }
                        node = TypeNode::Array(Box::new(node));
                    }
                    _ => return Some(node),
                }
            }
        }
        fn primary(&mut self) -> Option<TypeNode> {
            self.skip_ws();
            let (start, first) = *self.chars.peek()?;
            if first == '(' {
                self.chars.next();
                let inner = self.union()?;
                self.skip_ws();
                return (self.chars.next().map(|(_, c)| c) == Some(')')).then_some(inner);
            }
            let mut end = start;
            while let Some(&(at, c)) = self.chars.peek() {
                if c.is_alphanumeric() || c == '_' || c == '$' || c == '.' {
                    end = at + c.len_utf8();
                    self.chars.next();
                } else {
                    break;
                }
            }
            let name = &self.text[start..end];
            if name.is_empty() {
                return None;
            }
            Some(if name == "function" { TypeNode::Function } else { TypeNode::Name(name.to_string()) })
        }
    }
    let mut parser = Parser {
        chars: text.char_indices().peekable(),
        text,
    };
    let node = parser.union()?;
    parser.skip_ws();
    parser.chars.peek().is_none().then_some(node)
}

fn types_table(types: &HashMap<String, TypeDefinition>) -> HashMap<String, HashMap<String, (TypeNode, bool)>> {
    types
        .iter()
        .filter_map(|(name, def)| {
            let fields = def.fields.as_ref()?;
            let table = fields
                .iter()
                .filter_map(|(field, def)| Some((field.clone(), (type_node(&def.r#type)?, def.retain))))
                .collect();
            Some((name.clone(), table))
        })
        .collect()
}

fn param_shapes(params: &[Parameter]) -> Vec<ParamShape> {
    params
        .iter()
        .map(|param| ParamShape {
            node: type_node(&param.r#type).unwrap_or(TypeNode::Name(String::new())),
            retain: param.retain,
            variadic: param.variadic,
        })
        .collect()
}

fn collect_bindings(bindings: &HashMap<String, Binding>, prefix: &str, out: &mut HashMap<String, Vec<ParamShape>>) {
    for (name, binding) in bindings {
        let qualified = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        match binding {
            Binding::Function(def) => {
                if let Some(params) = def.params.as_deref()
                    && !params.is_empty()
                {
                    out.insert(qualified, param_shapes(params));
                }
            }
            Binding::Namespace(ns) => collect_bindings(&ns.members, &qualified, out),
            Binding::Accessor(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_type_text_grammar() {
        assert_eq!(parse_type_text("function"), Some(TypeNode::Function));
        assert_eq!(
            parse_type_text("function?"),
            Some(TypeNode::Optional(Box::new(TypeNode::Function)))
        );
        assert_eq!(
            parse_type_text("(A | B)[]"),
            Some(TypeNode::Array(Box::new(TypeNode::Union(vec![
                TypeNode::Name("A".into()),
                TypeNode::Name("B".into())
            ]))))
        );
        assert_eq!(parse_type_text("A |"), None);
        assert_eq!(parse_type_text("(A"), None);
    }

    fn manifest(bindings: serde_json::Value) -> Manifest {
        serde_json::from_value(json!({
            "xript": "0.10",
            "name": "positions",
            "bindings": bindings,
            "types": {
                "Opts": { "description": "d", "fields": {
                    "onDone": { "type": "function", "retain": true },
                    "onError": { "type": "function" },
                    "nested": { "type": "Opts?" }
                } }
            }
        }))
        .unwrap()
    }

    fn path(steps: serde_json::Value) -> Vec<PathStep> {
        steps
            .as_array()
            .unwrap()
            .iter()
            .map(|s| match s {
                serde_json::Value::String(k) => PathStep::Key(k.clone()),
                n => PathStep::Index(n.as_u64().unwrap() as usize),
            })
            .collect()
    }

    fn positions(params: serde_json::Value) -> RetainPositions {
        RetainPositions::from_manifest(&manifest(json!({
            "ns": { "description": "d", "members": { "f": { "description": "d", "params": params } } }
        })))
    }

    #[test]
    fn finds_retain_positions_through_declared_types() {
        let positions = positions(json!([
            { "name": "fn", "type": "function", "retain": true },
            { "name": "opts", "type": "Opts" },
            { "name": "list", "type": { "array": "Opts" } },
            { "name": "plain", "type": "function" },
            { "name": "maybe", "type": { "optional": "function" }, "retain": true },
            { "name": "rest", "type": "function", "variadic": true, "retain": true }
        ]));
        let at = |steps| positions.is_retainable("ns.f", &path(steps));
        assert!(at(json!([0])));
        assert!(at(json!([1, "onDone"])));
        assert!(!at(json!([1, "onError"])));
        assert!(at(json!([1, "nested", "nested", "nested", "onDone"])));
        assert!(at(json!([2, 3, "onDone"])));
        assert!(!at(json!([2, "x", "onDone"])));
        assert!(!at(json!([3])));
        assert!(at(json!([4])));
        assert!(at(json!([5])));
        assert!(at(json!([9])));
        assert!(!at(json!([0, "x"])));
        assert!(!positions.is_retainable("ns.other", &path(json!([0]))));
    }

    #[test]
    fn retain_does_not_pass_through_arrays_or_unions() {
        let positions = positions(json!([
            { "name": "fns", "type": "function[]", "retain": true },
            { "name": "either", "type": "function | string", "retain": true },
            { "name": "opts", "type": "(Opts | string)[]" }
        ]));
        let at = |steps| positions.is_retainable("ns.f", &path(steps));
        assert!(!at(json!([0, 0])));
        assert!(!at(json!([1])));
        assert!(at(json!([2, 0, "onDone"])));
    }
}
