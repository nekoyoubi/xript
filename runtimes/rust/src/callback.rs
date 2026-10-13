//! Call-scoped callbacks: script functions passed to a host binding.
//!
//! A host binding receives its arguments as JSON, so a script function cannot
//! arrive as itself. Wherever one appears in the arguments (top level, object
//! field, array element, any depth) the host finds a marker object instead,
//! `{ "$xriptCallback": "<token>" }`, and turns it into a [`Callback`] with
//! [`Callback::from_value`]. The callback is valid only while the binding call
//! that received it is running, and only on the thread running it. Calling it
//! runs the script function synchronously against the calling script's budget.

use std::cell::{Cell, RefCell};
use std::fmt;
use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicU64, Ordering};

use rquickjs::function::Rest;
use rquickjs::{Ctx, Error as QjsError, Function, Object, Value};

/// The key of the marker object that stands in for a script function in a
/// binding's JSON arguments.
pub const CALLBACK_MARKER: &str = "$xriptCallback";

/// Why a callback did not produce a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackError {
    /// The script function threw. `message` is the thrown error's own message.
    Threw {
        binding: String,
        name: Option<String>,
        message: String,
    },
    /// The binding call that received the callback has already returned (or
    /// the callback was called from another thread).
    Expired { binding: String },
    /// The script function returned a promise; callbacks are synchronous.
    Promise { binding: String },
    /// The calling script ran out of its execution budget inside the callback.
    Limit { binding: String },
}

impl CallbackError {
    /// The binding the callback was passed to.
    pub fn binding(&self) -> &str {
        match self {
            CallbackError::Threw { binding, .. }
            | CallbackError::Expired { binding }
            | CallbackError::Promise { binding }
            | CallbackError::Limit { binding } => binding,
        }
    }

    /// `"threw"`, `"expired"`, `"promise"`, or `"limit"`, matching the other runtimes.
    pub fn reason(&self) -> &'static str {
        match self {
            CallbackError::Threw { .. } => "threw",
            CallbackError::Expired { .. } => "expired",
            CallbackError::Promise { .. } => "promise",
            CallbackError::Limit { .. } => "limit",
        }
    }
}

impl fmt::Display for CallbackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CallbackError::Threw { message, .. } => write!(f, "{message}"),
            CallbackError::Expired { binding } => write!(
                f,
                "{binding}(): callback expired; a callback passed to a binding can only be called while that binding call is running"
            ),
            CallbackError::Promise { binding } => write!(
                f,
                "{binding}(): callback returned a promise; callbacks passed to a binding are synchronous and must return a settled value"
            ),
            CallbackError::Limit { binding } => write!(
                f,
                "{binding}(): callback stopped by the calling script's execution limit"
            ),
        }
    }
}

impl std::error::Error for CallbackError {}

impl From<CallbackError> for String {
    fn from(error: CallbackError) -> String {
        error.to_string()
    }
}

/// A script function passed to the binding currently running. Cheap to clone;
/// every clone expires together when the binding call ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Callback {
    scope: u64,
    index: usize,
    nonce: u64,
    binding: String,
}

impl Callback {
    /// Resolves a marker object from a binding's arguments. Returns `None` for
    /// anything that is not a marker the runtime itself produced for a live
    /// callback: a token the script spelled into plain data (it cannot know a
    /// live scope's random nonce) resolves to nothing, exactly as the same data
    /// shape is inert in the runtimes that pass functions directly.
    pub fn from_value(value: &serde_json::Value) -> Option<Callback> {
        let object = value.as_object()?;
        if object.len() != 1 {
            return None;
        }
        let token = object.get(CALLBACK_MARKER)?.as_str()?;
        let mut parts = token.splitn(4, ':');
        let scope = parts.next()?.parse().ok()?;
        let index = parts.next()?.parse().ok()?;
        let nonce = parts.next()?.parse().ok()?;
        let binding = parts.next()?.to_string();
        if !scope_is_live(scope, nonce) {
            return None;
        }
        Some(Callback { scope, index, nonce, binding })
    }

    /// The binding this callback was passed to.
    pub fn binding(&self) -> &str {
        &self.binding
    }

    /// Calls the script function with `args` and returns what it returned, both
    /// marshalled as JSON. Fails with [`CallbackError::Expired`] once the
    /// binding call has returned.
    pub fn call(&self, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError> {
        let invoker = SCOPES.with(|scopes| {
            scopes
                .borrow()
                .iter()
                .rev()
                .find(|(id, nonce, _)| *id == self.scope && *nonce == self.nonce)
                .map(|(_, _, invoker)| *invoker)
        });
        let Some(invoker) = invoker else {
            return Err(CallbackError::Expired {
                binding: self.binding.clone(),
            });
        };
        // SAFETY: an entry stays in `SCOPES` only while the `ScopeGuard` that
        // registered it is alive, and the guard is dropped before the scope
        // state it points at. The pointer is therefore valid here.
        unsafe { (*invoker).invoke(self.index, args) }
    }
}

trait Invoke {
    fn invoke(&self, index: usize, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError>;
}

thread_local! {
    static SCOPES: RefCell<Vec<(u64, u64, *const (dyn Invoke + 'static))>> = const { RefCell::new(Vec::new()) };
    static DEPTH: Cell<usize> = const { Cell::new(0) };
}

static NEXT_SCOPE: AtomicU64 = AtomicU64::new(1);

/// Whether a scope with this id and nonce is live on the calling thread.
fn scope_is_live(scope: u64, nonce: u64) -> bool {
    SCOPES.with(|scopes| scopes.borrow().iter().any(|(id, n, _)| *id == scope && *n == nonce))
}

/// True while a callback is running on this thread; an async binding refuses
/// to start inside one.
pub(crate) fn inside_callback() -> bool {
    DEPTH.with(|d| d.get() > 0)
}

/// One binding call's callbacks on the sandbox side.
pub(crate) struct CallScope<'js> {
    id: u64,
    nonce: u64,
    ctx: Ctx<'js>,
    binding: String,
    functions: Vec<Function<'js>>,
    thrown: RefCell<Vec<(String, Value<'js>)>>,
    fatal: RefCell<Option<Value<'js>>>,
}

impl<'js> CallScope<'js> {
    pub(crate) fn new(ctx: Ctx<'js>, binding: &str, functions: Vec<Function<'js>>) -> Self {
        let id = NEXT_SCOPE.fetch_add(1, Ordering::Relaxed);
        Self {
            id,
            // A random, process-local nonce makes a callback token unforgeable: script data
            // shaped like a token cannot carry a live scope's nonce, so it never resolves.
            nonce: RandomState::new().hash_one(id),
            ctx,
            binding: binding.to_string(),
            functions,
            thrown: RefCell::new(Vec::new()),
            fatal: RefCell::new(None),
        }
    }

    /// Rewrites the numeric markers the sandbox emitted into resolvable tokens.
    pub(crate) fn resolve_markers(&self, args: &mut [serde_json::Value]) {
        if self.functions.is_empty() {
            return;
        }
        for arg in args.iter_mut() {
            self.resolve_value(arg);
        }
    }

    fn resolve_value(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    self.resolve_value(item);
                }
            }
            serde_json::Value::Object(map) => {
                if map.len() == 1
                    && let Some(index) = map.get(CALLBACK_MARKER).and_then(|v| v.as_u64())
                    && (index as usize) < self.functions.len()
                {
                    map.insert(
                        CALLBACK_MARKER.to_string(),
                        serde_json::Value::String(format!("{}:{}:{}:{}", self.id, index, self.nonce, self.binding)),
                    );
                    return;
                }
                for item in map.values_mut() {
                    self.resolve_value(item);
                }
            }
            _ => {}
        }
    }

    /// Runs `body` with this scope's callbacks callable, then expires them.
    pub(crate) fn run<R>(&self, body: impl FnOnce() -> R) -> R {
        let invoker: *const (dyn Invoke + '_) = self;
        // SAFETY: the lifetime is erased only for storage in `SCOPES`; the
        // guard below removes the entry before `self` can be dropped.
        let invoker: *const (dyn Invoke + 'static) = unsafe { std::mem::transmute(invoker) };
        SCOPES.with(|scopes| scopes.borrow_mut().push((self.id, self.nonce, invoker)));
        let _guard = ScopeGuard(self.id);
        body()
    }

    /// The exception the binding call must end with, if any: a budget stop
    /// from any callback (the host may not swallow it), else the script's own
    /// error when the host returned a callback's throw unchanged.
    pub(crate) fn outcome(&self, host_error: Option<&str>) -> Option<Value<'js>> {
        if let Some(fatal) = self.fatal.borrow_mut().take() {
            return Some(fatal);
        }
        let message = host_error?;
        let thrown = self.thrown.borrow();
        thrown
            .iter()
            .rev()
            .find(|(display, _)| display == message)
            .map(|(_, value)| value.clone())
    }
}

struct ScopeGuard(u64);

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        SCOPES.with(|scopes| {
            let mut scopes = scopes.borrow_mut();
            if let Some(position) = scopes.iter().rposition(|(id, _, _)| *id == self.0) {
                scopes.remove(position);
            }
        });
    }
}

struct DepthGuard;

impl DepthGuard {
    fn enter() -> Self {
        DEPTH.with(|d| d.set(d.get() + 1));
        DepthGuard
    }
}

impl Drop for DepthGuard {
    fn drop(&mut self) {
        DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
    }
}

impl Invoke for CallScope<'_> {
    fn invoke(&self, index: usize, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError> {
        let binding = self.binding.clone();
        if self.fatal.borrow().is_some() {
            return Err(CallbackError::Limit { binding });
        }
        let Some(function) = self.functions.get(index) else {
            return Err(CallbackError::Expired { binding });
        };

        let mut js_args = Vec::with_capacity(args.len());
        for arg in args {
            match crate::sandbox::json_to_js(&self.ctx, arg) {
                Ok(value) => js_args.push(value),
                Err(e) => {
                    return Err(CallbackError::Threw {
                        binding,
                        name: None,
                        message: e.to_string(),
                    })
                }
            }
        }

        let outcome: rquickjs::Result<Value> = {
            let _depth = DepthGuard::enter();
            function.call((Rest(js_args),))
        };

        match outcome {
            Ok(value) => {
                if is_thenable(&value) {
                    return Err(CallbackError::Promise { binding });
                }
                Ok(crate::sandbox::js_value_to_json(&self.ctx, &value))
            }
            Err(QjsError::Exception) => {
                let exception = self.ctx.catch();
                let (name, message) = describe_exception(&exception);
                if message.contains("interrupted") {
                    *self.fatal.borrow_mut() = Some(exception);
                    return Err(CallbackError::Limit { binding });
                }
                let error = CallbackError::Threw {
                    binding,
                    name,
                    message,
                };
                self.thrown.borrow_mut().push((error.to_string(), exception));
                Err(error)
            }
            Err(other) => Err(CallbackError::Threw {
                binding,
                name: None,
                message: other.to_string(),
            }),
        }
    }
}

fn is_thenable(value: &Value<'_>) -> bool {
    if value.is_promise() {
        return true;
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    object
        .get::<_, Value>("then")
        .map(|then| then.is_function())
        .unwrap_or(false)
}

fn describe_exception(exception: &Value<'_>) -> (Option<String>, String) {
    if let Some(text) = exception.as_string().and_then(|s| s.to_string().ok()) {
        return (None, text);
    }
    if let Some(object) = exception.as_object() {
        let read = |object: &Object<'_>, key: &str| -> Option<String> {
            object
                .get::<_, Value>(key)
                .ok()
                .and_then(|v| v.as_string().and_then(|s| s.to_string().ok()))
        };
        let name = read(object, "name");
        let message = read(object, "message").unwrap_or_default();
        return (name, message);
    }
    (None, String::from("callback threw a non-error value"))
}

/// A parameter the manifest declares as a function, checked before the host runs.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct FunctionParamCheck {
    pub index: usize,
    pub name: String,
    pub optional: bool,
}

fn is_function_type(type_ref: &serde_json::Value) -> bool {
    match type_ref {
        serde_json::Value::String(s) => s == "function",
        serde_json::Value::Object(map) => map.contains_key("function"),
        _ => false,
    }
}

/// The parameters of `params` declared as `function`, bare, with a signature,
/// or wrapped in `optional`.
pub(crate) fn function_param_checks(params: Option<&Vec<crate::manifest::Parameter>>) -> Vec<FunctionParamCheck> {
    let Some(params) = params else {
        return Vec::new();
    };
    let mut checks = Vec::new();
    for (index, param) in params.iter().enumerate() {
        let wrapped = param.r#type.as_object().and_then(|m| m.get("optional"));
        if is_function_type(&param.r#type) {
            checks.push(FunctionParamCheck {
                index,
                name: param.name.clone(),
                optional: param.required == Some(false) || param.default.is_some(),
            });
        } else if wrapped.is_some_and(is_function_type) {
            checks.push(FunctionParamCheck {
                index,
                name: param.name.clone(),
                optional: true,
            });
        }
    }
    checks
}
