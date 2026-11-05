//! Call-scoped callbacks: script functions passed to a host binding.
//!
//! A host binding receives its arguments as JSON, so a script function cannot
//! arrive as itself. Wherever one appears in the arguments (top level, object
//! field, array element, any depth) the host finds a marker object instead,
//! `{ "$xriptCallback": "<token>" }`, and turns it into a [`Callback`] with
//! [`Callback::from_value`]. The callback is valid only while the binding call
//! that received it is running, and only on the thread running it. Calling it
//! runs the script function synchronously against the calling script's budget.
//! A callback found at a position the manifest marks `retain` can outlive the
//! call through [`Callback::retain`]; see [`crate::retained`].
//!
//! A host hands a callback back into the sandbox (as a binding's return, or in
//! a callback's arguments) with its marker, [`Callback::to_value`]. While its
//! binding call is running, a binding call nested inside it included, script
//! receives its own original function; once that call has ended, or in another
//! runtime, it receives `undefined`. A marker never reaches script as data, so
//! script never learns a token's nonce, and plain script data shaped like a
//! marker is never taken for a callback.

use std::cell::{Cell, RefCell};
use std::fmt;
use std::hash::{BuildHasher, RandomState};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rquickjs::function::Rest;
use rquickjs::{Ctx, Error as QjsError, Function, Value};

use crate::retained::{PathStep, RetainError, RetainedCallback, RetainedRegistry};

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
    /// The retained callback was released, by the host, with its mod, or with
    /// its runtime.
    Released { binding: String },
    /// A retained callback was used where it is not valid; reason `"expired"`.
    RetainedExpired { binding: String, cause: ExpiredCause },
}

/// Where a retained callback was used that made it fail as expired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpiredCause {
    /// Called from a thread other than the one it was retained on.
    OtherThread,
    /// Passed into a runtime, or a mod, other than the one that supplied it.
    Foreign,
}

impl CallbackError {
    /// The binding the callback was passed to.
    pub fn binding(&self) -> &str {
        match self {
            CallbackError::Threw { binding, .. }
            | CallbackError::Expired { binding }
            | CallbackError::Promise { binding }
            | CallbackError::Limit { binding }
            | CallbackError::Released { binding }
            | CallbackError::RetainedExpired { binding, .. } => binding,
        }
    }

    /// `"threw"`, `"expired"`, `"promise"`, `"limit"`, or `"released"`,
    /// matching the other runtimes.
    pub fn reason(&self) -> &'static str {
        match self {
            CallbackError::Threw { .. } => "threw",
            CallbackError::Expired { .. } | CallbackError::RetainedExpired { .. } => "expired",
            CallbackError::Promise { .. } => "promise",
            CallbackError::Limit { .. } => "limit",
            CallbackError::Released { .. } => "released",
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
            CallbackError::Released { binding } => write!(
                f,
                "{binding}(): callback released; the host released this retained callback"
            ),
            CallbackError::RetainedExpired {
                binding,
                cause: ExpiredCause::OtherThread,
            } => write!(
                f,
                "{binding}(): callback expired; a retained callback can only be called on its runtime's thread"
            ),
            CallbackError::RetainedExpired {
                binding,
                cause: ExpiredCause::Foreign,
            } => write!(
                f,
                "{binding}(): callback expired; a retained callback crosses back only into the runtime and mod that supplied it"
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

    /// The marker that hands this callback back into the sandbox, as a
    /// binding's return or inside a callback's arguments. While its binding
    /// call is running (a binding call nested inside it included), script
    /// receives its own original function; once the call has ended, or in
    /// another runtime, `undefined`.
    pub fn to_value(&self) -> serde_json::Value {
        let token = format!("{}:{}:{}:{}", self.scope, self.index, self.nonce, self.binding);
        serde_json::json!({ CALLBACK_MARKER: token })
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

    /// Retains the callback past the binding call, so the host can call it
    /// later. Succeeds only while the binding call is running, on its thread,
    /// for a callback at a position the manifest marks `retain`, or for a
    /// function this mod already retained (which yields that same
    /// [`RetainedCallback`]).
    pub fn retain(&self) -> Result<RetainedCallback, RetainError> {
        let Some(invoker) = find_scope(self.scope, self.nonce) else {
            return Err(RetainError::Expired {
                binding: self.binding.clone(),
            });
        };
        // SAFETY: as in `call`.
        unsafe { (*invoker).retain(self.index) }
    }
}

trait Invoke {
    fn invoke(&self, index: usize, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError>;
    fn retain(&self, index: usize) -> Result<RetainedCallback, RetainError>;
    fn registry_id(&self) -> Option<u64>;
    fn invoke_retained(
        &self,
        registry: &RetainedRegistry,
        id: u64,
        binding: &str,
        owner: Option<String>,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value, CallbackError>;
    /// The `index`th function, as one new reference, when this scope runs in
    /// `context`.
    fn function_raw(&self, context: *mut rquickjs::qjs::JSContext, index: usize) -> Option<rquickjs::qjs::JSValue>;
}

fn find_scope(scope: u64, nonce: u64) -> Option<*const (dyn Invoke + 'static)> {
    SCOPES.with(|scopes| {
        scopes
            .borrow()
            .iter()
            .rev()
            .find(|(id, n, _)| *id != 0 && *id == scope && *n == nonce)
            .map(|(_, _, invoker)| *invoker)
    })
}

/// Calls a retained callback from inside a binding call this runtime is
/// running on this thread, if there is one: through the innermost such call,
/// on its budget. `None` when no binding call of this runtime is running here.
pub(crate) fn invoke_retained_reentrant(
    registry: &Arc<RetainedRegistry>,
    id: u64,
    binding: &str,
    owner: Option<String>,
    args: &[serde_json::Value],
) -> Option<Result<serde_json::Value, CallbackError>> {
    let invoker = SCOPES.with(|scopes| {
        scopes
            .borrow()
            .iter()
            .rev()
            // SAFETY: every entry in `SCOPES` points at a live scope (see `call`).
            .find(|(_, _, invoker)| unsafe { (**invoker).registry_id() } == Some(registry.id()))
            .map(|(_, _, invoker)| *invoker)
    })?;
    // SAFETY: as above.
    Some(unsafe { (*invoker).invoke_retained(registry, id, binding, owner, args) })
}

/// Calls a retained callback between script calls, on the budget the caller
/// already armed (`interrupted` is its frame's flag).
pub(crate) fn call_detached<'js>(
    ctx: &Ctx<'js>,
    function: &Function<'js>,
    binding: &str,
    args: &[serde_json::Value],
    interrupted: &AtomicBool,
) -> Result<serde_json::Value, CallbackError> {
    let js_args = host_args(ctx, binding, args)?;
    let outcome: rquickjs::Result<Value> = {
        let _depth = DepthGuard::enter();
        function.call((Rest(js_args),))
    };
    let exception = match outcome {
        Ok(value) => match settled(ctx, binding, value) {
            Ok(json) => return Ok(json),
            Err(Unsettled::Error(error)) => return Err(error),
            Err(Unsettled::Threw(exception)) => exception,
        },
        Err(QjsError::Exception) => ctx.catch(),
        Err(other) => {
            return Err(CallbackError::Threw {
                binding: binding.to_string(),
                name: None,
                message: other.to_string(),
            })
        }
    };
    let (name, message) = describe_exception(&exception);
    if interrupted.load(Ordering::Relaxed) || message.contains("interrupted") {
        return Err(CallbackError::Limit {
            binding: binding.to_string(),
        });
    }
    Err(CallbackError::Threw {
        binding: binding.to_string(),
        name,
        message,
    })
}

/// What a callback called through [`call_settling`] or [`call_settling_async`]
/// returned: a promise to settle (a thenable adopted as one), or a value as it
/// stands.
enum Returned<'js> {
    Value(Value<'js>),
    Promise(rquickjs::Promise<'js>),
}

/// Calls `function` with nothing marking a callback in flight, so an async
/// binding it reaches may start, and turns a thenable return into a promise.
fn call_returning<'js>(
    ctx: &Ctx<'js>,
    function: &Function<'js>,
    binding: &str,
    args: &[serde_json::Value],
    interrupted: &AtomicBool,
) -> Result<Returned<'js>, CallbackError> {
    let js_args = host_args(ctx, binding, args)?;
    let value: Value = match function.call((Rest(js_args),)) {
        Ok(value) => value,
        Err(QjsError::Exception) => return Err(failure(binding, &ctx.catch(), interrupted)),
        Err(other) => return Err(threw_text(binding, other.to_string())),
    };
    match is_thenable(&value) {
        Ok(false) => return Ok(Returned::Value(value)),
        Ok(true) => {}
        Err(QjsError::Exception) => return Err(failure(binding, &ctx.catch(), interrupted)),
        Err(other) => return Err(threw_text(binding, other.to_string())),
    }
    if let Ok(promise) = rquickjs::Promise::from_value(value.clone()) {
        return Ok(Returned::Promise(promise));
    }
    let adopted = ctx
        .globals()
        .get::<_, rquickjs::Object>("Promise")
        .and_then(|constructor| {
            let resolve: Function = constructor.get("resolve")?;
            resolve.call::<_, rquickjs::Promise>((rquickjs::function::This(constructor), value))
        });
    match adopted {
        Ok(promise) => Ok(Returned::Promise(promise)),
        Err(QjsError::Exception) => Err(failure(binding, &ctx.catch(), interrupted)),
        Err(other) => Err(threw_text(binding, other.to_string())),
    }
}

/// Calls `function` and, when it returns a promise, runs the context's jobs
/// in place until the promise settles. An async binding the function reaches
/// settles in place too (see [`crate::reentry::inside`]), so the whole call
/// completes before this returns.
pub(crate) fn call_settling<'js>(
    ctx: &Ctx<'js>,
    function: &Function<'js>,
    binding: &str,
    args: &[serde_json::Value],
    interrupted: &AtomicBool,
) -> Result<serde_json::Value, CallbackError> {
    let promise = match call_returning(ctx, function, binding, args, interrupted)? {
        Returned::Value(value) => return read_result(ctx, binding, &value, interrupted),
        Returned::Promise(promise) => promise,
    };
    loop {
        match promise.state() {
            rquickjs::promise::PromiseState::Pending => {
                if !ctx.execute_pending_job() {
                    if interrupted.load(Ordering::Relaxed) {
                        return Err(CallbackError::Limit { binding: binding.to_string() });
                    }
                    return Err(threw_text(binding, format!("{binding}(): {UNSETTLED_MESSAGE}")));
                }
            }
            rquickjs::promise::PromiseState::Resolved => {
                let value = promise.result::<Value>().and_then(|r| r.ok()).unwrap_or_else(|| Value::new_undefined(ctx.clone()));
                return read_result(ctx, binding, &value, interrupted);
            }
            rquickjs::promise::PromiseState::Rejected => {
                let _ = promise.result::<Value>();
                return Err(failure(binding, &ctx.catch(), interrupted));
            }
        }
    }
}

/// [`call_settling`] for a runtime that yields: a promise is awaited, so the
/// executor driving the call also drives the host futures the promise waits
/// on, and gives up when `watch` says the budget is spent or the call was
/// cancelled.
pub(crate) async fn call_settling_async<'js>(
    ctx: &Ctx<'js>,
    function: &Function<'js>,
    binding: &str,
    args: &[serde_json::Value],
    interrupted: &AtomicBool,
    watch: Arc<crate::yielding::Watch>,
) -> Result<serde_json::Value, CallbackError> {
    let promise = match call_returning(ctx, function, binding, args, interrupted)? {
        Returned::Value(value) => return read_result(ctx, binding, &value, interrupted),
        Returned::Promise(promise) => promise,
    };
    crate::sandbox::drain_jobs(ctx);
    match crate::yielding::Abortable::new(promise.into_future::<Value>(), watch).await {
        Ok(Ok(value)) => read_result(ctx, binding, &value, interrupted),
        Ok(Err(_)) => Err(failure(binding, &ctx.catch(), interrupted)),
        Err(_) => Err(CallbackError::Limit { binding: binding.to_string() }),
    }
}

const UNSETTLED_MESSAGE: &str = "callback's promise never settled: it awaited something that never resolves, and no pending jobs remain";

fn read_result<'js>(
    ctx: &Ctx<'js>,
    binding: &str,
    value: &Value<'js>,
    interrupted: &AtomicBool,
) -> Result<serde_json::Value, CallbackError> {
    match crate::marshal::try_to_json(ctx, value) {
        Ok(json) => Ok(json),
        Err(crate::marshal::CrossError::Thrown(thrown)) => Err(failure(binding, &thrown, interrupted)),
        Err(crate::marshal::CrossError::Refused(message)) => Err(threw_text(
            binding,
            format!("{binding}(): callback returned a value that cannot cross: {message}"),
        )),
    }
}

/// The error a callback ends with when it threw `exception`: a budget stop
/// when the interrupt handler fired, the script's own error otherwise.
fn failure(binding: &str, exception: &Value<'_>, interrupted: &AtomicBool) -> CallbackError {
    let (name, message) = describe_exception(exception);
    if interrupted.load(Ordering::Relaxed) || message.contains("interrupted") {
        return CallbackError::Limit { binding: binding.to_string() };
    }
    CallbackError::Threw { binding: binding.to_string(), name, message }
}

fn threw_text(binding: &str, message: String) -> CallbackError {
    CallbackError::Threw { binding: binding.to_string(), name: None, message }
}

fn host_args<'js>(ctx: &Ctx<'js>, binding: &str, args: &[serde_json::Value]) -> Result<Vec<Value<'js>>, CallbackError> {
    let mut js_args = Vec::with_capacity(args.len());
    for arg in args {
        match crate::retained::host_value_to_js(ctx, arg) {
            Ok(value) => js_args.push(value),
            Err(crate::retained::HostValueError::Callback(error)) => return Err(error),
            Err(crate::retained::HostValueError::Marshal(message)) => {
                return Err(CallbackError::Threw {
                    binding: binding.to_string(),
                    name: None,
                    message: format!("{binding}(): {message}"),
                })
            }
        }
    }
    Ok(js_args)
}

/// The path from the arguments to step `at`, following each step's parent.
fn path_to(steps: &[(Option<usize>, PathStep)], at: usize) -> Vec<PathStep> {
    let mut path = Vec::new();
    let mut cursor = Some(at);
    while let Some(index) = cursor {
        let (parent, step) = &steps[index];
        path.push(step.clone());
        cursor = *parent;
    }
    path.reverse();
    path
}

/// Why a callback's return did not reach the host.
enum Unsettled<'js> {
    Error(CallbackError),
    /// Script threw while the return was read, as a getter on it can.
    Threw(Value<'js>),
}

fn settled<'js>(ctx: &Ctx<'js>, binding: &str, value: Value<'js>) -> Result<serde_json::Value, Unsettled<'js>> {
    match is_thenable(&value) {
        Ok(true) => {
            return Err(Unsettled::Error(CallbackError::Promise {
                binding: binding.to_string(),
            }))
        }
        Ok(false) => {}
        Err(QjsError::Exception) => return Err(Unsettled::Threw(ctx.catch())),
        Err(other) => {
            return Err(Unsettled::Error(CallbackError::Threw {
                binding: binding.to_string(),
                name: None,
                message: other.to_string(),
            }))
        }
    }
    match crate::marshal::try_to_json(ctx, &value) {
        Ok(json) => Ok(json),
        Err(crate::marshal::CrossError::Thrown(thrown)) => Err(Unsettled::Threw(thrown)),
        Err(crate::marshal::CrossError::Refused(message)) => Err(Unsettled::Error(CallbackError::Threw {
            binding: binding.to_string(),
            name: None,
            message: format!("{binding}(): callback returned a value that cannot cross: {message}"),
        })),
    }
}

thread_local! {
    static SCOPES: RefCell<Vec<(u64, u64, *const (dyn Invoke + 'static))>> = const { RefCell::new(Vec::new()) };
    static DEPTH: Cell<usize> = const { Cell::new(0) };
}

static NEXT_SCOPE: AtomicU64 = AtomicU64::new(1);

/// Whether a scope with this id and nonce is live on the calling thread.
fn scope_is_live(scope: u64, nonce: u64) -> bool {
    SCOPES.with(|scopes| scopes.borrow().iter().any(|(id, n, _)| *id != 0 && *id == scope && *n == nonce))
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
    registry: Option<Arc<RetainedRegistry>>,
    retainable: RefCell<Vec<bool>>,
}

/// The id and nonce a binding call's callback tokens carry, fixed before its
/// arguments are read so each function is spelled as its final token at once.
/// A random, process-local nonce makes a token unforgeable: script data shaped
/// like one cannot carry a live scope's nonce, so it never resolves, and a
/// token handed back into the sandbox reaches script as the function it names
/// (or `undefined`), never as the token.
#[derive(Clone, Copy)]
pub(crate) struct ScopeIdentity {
    id: u64,
    nonce: u64,
}

impl ScopeIdentity {
    /// The identity of a call passed no functions. It issues no tokens, and no
    /// token resolves against it, so it needs no nonce; its scope still lets a
    /// retained callback be called from inside the binding call.
    pub(crate) const EMPTY: ScopeIdentity = ScopeIdentity { id: 0, nonce: 0 };

    pub(crate) fn new() -> Self {
        let id = NEXT_SCOPE.fetch_add(1, Ordering::Relaxed);
        Self { id, nonce: RandomState::new().hash_one(id) }
    }

    /// The token for the `index`th function passed to `binding`.
    pub(crate) fn token(&self, index: usize, binding: &str) -> String {
        format!("{}:{}:{}:{}", self.id, index, self.nonce, binding)
    }
}

/// The script function a call-scoped token names, when its binding call is
/// running on this thread in this context. `None` for a token that no longer
/// resolves: its call has ended, or it belongs to another call or runtime.
pub(crate) fn live_function<'js>(ctx: &Ctx<'js>, token: &str) -> Option<Function<'js>> {
    let mut parts = token.splitn(4, ':');
    let scope: u64 = parts.next()?.parse().ok()?;
    let index: usize = parts.next()?.parse().ok()?;
    let nonce: u64 = parts.next()?.parse().ok()?;
    let invoker = find_scope(scope, nonce)?;
    // SAFETY: an entry in `SCOPES` points at a live scope (see `Callback::call`).
    let raw = unsafe { (*invoker).function_raw(ctx.as_raw().as_ptr(), index) }?;
    // SAFETY: `function_raw` handed over one reference to a value of this
    // context, which the new `Value` now owns.
    unsafe { Value::from_raw(ctx.clone(), raw) }.into_function()
}

impl<'js> CallScope<'js> {
    pub(crate) fn new(ctx: Ctx<'js>, binding: &str, functions: Vec<Function<'js>>, identity: ScopeIdentity) -> Self {
        let registry = crate::retained::registry_of(&ctx);
        let retainable = RefCell::new(vec![false; functions.len()]);
        Self {
            id: identity.id,
            nonce: identity.nonce,
            ctx,
            binding: binding.to_string(),
            functions,
            thrown: RefCell::new(Vec::new()),
            fatal: RefCell::new(None),
            registry,
            retainable,
        }
    }

    /// Notes which of this call's callbacks sit at a position the manifest
    /// marks `retain`. Only tokens carrying this call's own id and nonce count;
    /// anything else shaped like a marker is the script's plain data.
    pub(crate) fn note_retainable(&self, args: &[serde_json::Value]) {
        self.mark_retainable(args)
    }

    /// The function index a token names, when it is one of this call's own.
    fn own_index(&self, token: &str) -> Option<usize> {
        let mut parts = token.splitn(4, ':');
        let id: u64 = parts.next()?.parse().ok()?;
        let index: usize = parts.next()?.parse().ok()?;
        let nonce: u64 = parts.next()?.parse().ok()?;
        (id == self.id && nonce == self.nonce && index < self.functions.len()).then_some(index)
    }

    fn mark_retainable(&self, args: &[serde_json::Value]) {
        if self.functions.is_empty() {
            return;
        }
        let mut steps: Vec<(Option<usize>, PathStep)> = Vec::new();
        let mut pending: Vec<(&serde_json::Value, usize)> = Vec::new();
        for (index, arg) in args.iter().enumerate() {
            steps.push((None, PathStep::Index(index)));
            pending.push((arg, steps.len() - 1));
        }
        while let Some((value, at)) = pending.pop() {
            match value {
                serde_json::Value::Array(items) => {
                    for (index, item) in items.iter().enumerate() {
                        steps.push((Some(at), PathStep::Index(index)));
                        pending.push((item, steps.len() - 1));
                    }
                }
                serde_json::Value::Object(map) => {
                    if map.len() == 1
                        && let Some(index) = map.get(CALLBACK_MARKER).and_then(|v| v.as_str()).and_then(|t| self.own_index(t))
                    {
                        if let Some(registry) = &self.registry
                            && registry.is_retainable(&self.binding, &path_to(&steps, at))
                        {
                            self.retainable.borrow_mut()[index] = true;
                        }
                        continue;
                    }
                    for (key, item) in map.iter() {
                        steps.push((Some(at), PathStep::Key(key.clone())));
                        pending.push((item, steps.len() - 1));
                    }
                }
                _ => {}
            }
        }
    }

    /// Calls a script function on this binding call's budget, recording a
    /// budget stop as fatal and a throw for pass-through.
    fn call_function(
        &self,
        function: &Function<'js>,
        binding: &str,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value, CallbackError> {
        if self.fatal.borrow().is_some() {
            return Err(CallbackError::Limit {
                binding: binding.to_string(),
            });
        }
        let js_args = host_args(&self.ctx, binding, args)?;

        let outcome: rquickjs::Result<Value> = {
            let _depth = DepthGuard::enter();
            function.call((Rest(js_args),))
        };

        let exception = match outcome {
            Ok(value) => match settled(&self.ctx, binding, value) {
                Ok(json) => return Ok(json),
                Err(Unsettled::Error(error)) => return Err(error),
                Err(Unsettled::Threw(exception)) => exception,
            },
            Err(QjsError::Exception) => self.ctx.catch(),
            Err(other) => {
                return Err(CallbackError::Threw {
                    binding: binding.to_string(),
                    name: None,
                    message: other.to_string(),
                })
            }
        };
        let (name, message) = describe_exception(&exception);
        if message.contains("interrupted") {
            *self.fatal.borrow_mut() = Some(exception);
            return Err(CallbackError::Limit {
                binding: binding.to_string(),
            });
        }
        let error = CallbackError::Threw {
            binding: binding.to_string(),
            name,
            message,
        };
        self.thrown.borrow_mut().push((error.to_string(), exception));
        Err(error)
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
    fn function_raw(&self, context: *mut rquickjs::qjs::JSContext, index: usize) -> Option<rquickjs::qjs::JSValue> {
        if self.ctx.as_raw().as_ptr() != context {
            return None;
        }
        let function = self.functions.get(index)?;
        // SAFETY: `context` is this scope's live context and the function is
        // a live value of it; the duplicate is the one reference handed over.
        Some(unsafe { rquickjs::qjs::JS_DupValue(context, function.as_raw()) })
    }

    fn invoke(&self, index: usize, args: &[serde_json::Value]) -> Result<serde_json::Value, CallbackError> {
        if self.fatal.borrow().is_some() {
            return Err(CallbackError::Limit {
                binding: self.binding.clone(),
            });
        }
        let Some(function) = self.functions.get(index) else {
            return Err(CallbackError::Expired {
                binding: self.binding.clone(),
            });
        };
        self.call_function(function, &self.binding, args)
    }

    fn retain(&self, index: usize) -> Result<RetainedCallback, RetainError> {
        let (Some(registry), Some(function)) = (&self.registry, self.functions.get(index)) else {
            return Err(RetainError::Expired {
                binding: self.binding.clone(),
            });
        };
        let retainable = self.retainable.borrow().get(index).copied().unwrap_or(false);
        registry.retain(&self.ctx, function, &self.binding, retainable)
    }

    fn registry_id(&self) -> Option<u64> {
        self.registry.as_ref().map(|r| r.id())
    }

    fn invoke_retained(
        &self,
        registry: &RetainedRegistry,
        id: u64,
        binding: &str,
        owner: Option<String>,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value, CallbackError> {
        if self.fatal.borrow().is_some() {
            return Err(CallbackError::Limit {
                binding: binding.to_string(),
            });
        }
        let Some(function) = registry.restore(&self.ctx, id) else {
            return Err(CallbackError::Released {
                binding: binding.to_string(),
            });
        };
        let _caller = registry.caller().enter(owner);
        self.call_function(&function, binding, args)
    }
}

/// Whether `value` is a promise or has a callable `then`. Reading `then` can
/// throw (a getter, a revoked proxy); that throw is the caller's to report.
fn is_thenable(value: &Value<'_>) -> rquickjs::Result<bool> {
    if value.is_promise() {
        return Ok(true);
    }
    let Some(object) = value.as_object() else {
        return Ok(false);
    };
    object.get::<_, Value>("then").map(|then| then.is_function())
}

/// What a script threw, as the JavaScript runtimes describe it: an object's
/// `name` and its `message` as text (`"callback threw"` when it has none), and
/// anything else, a function included, as `String(value)`.
fn describe_exception(exception: &Value<'_>) -> (Option<String>, String) {
    const NO_MESSAGE: &str = "callback threw";
    if let Some(object) = exception.as_object().filter(|_| !exception.is_function()) {
        let name = object
            .get::<_, Value>("name")
            .ok()
            .and_then(|v| v.as_string().and_then(|s| s.to_string().ok()));
        let message = match object.get::<_, Value>("message") {
            Ok(message) if !message.is_undefined() && !message.is_null() => {
                js_string(&message).unwrap_or_else(|| NO_MESSAGE.to_string())
            }
            Ok(_) => NO_MESSAGE.to_string(),
            Err(_) => {
                let _ = exception.ctx().catch();
                NO_MESSAGE.to_string()
            }
        };
        return (name, message);
    }
    (None, js_string(exception).unwrap_or_else(|| NO_MESSAGE.to_string()))
}

/// `String(value)`; `None` when that throws.
fn js_string(value: &Value<'_>) -> Option<String> {
    if let Some(symbol) = value.as_symbol() {
        let description = symbol.description().ok()?;
        let description = description.as_string().and_then(|s| s.to_string().ok()).unwrap_or_default();
        return Some(format!("Symbol({description})"));
    }
    match value.get::<rquickjs::convert::Coerced<String>>() {
        Ok(text) => Some(text.0),
        Err(_) => {
            let _ = value.ctx().catch();
            None
        }
    }
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
                optional: param.required == Some(false) || param.optional == Some(true) || param.default.is_some(),
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
