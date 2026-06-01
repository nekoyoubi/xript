use rquickjs::function::Rest;
use rquickjs::loader::{Loader, Resolver};
use rquickjs::module::{Declared, Evaluated, Module};
use rquickjs::promise::{Promise, PromiseState};
use rquickjs::{Context, Ctx, Error as QjsError, Function, Object, Runtime, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{Result, XriptError};
use crate::manifest::{Binding, Manifest, NamespaceBinding};

pub type HostFn =
    Arc<dyn Fn(&[serde_json::Value]) -> std::result::Result<serde_json::Value, String> + Send + Sync>;

pub type AsyncHostFn = Arc<
    dyn Fn(
            &[serde_json::Value],
        ) -> Pin<
            Box<dyn Future<Output = std::result::Result<serde_json::Value, String>> + Send>,
        > + Send
        + Sync,
>;

/// A cloneable cooperative-cancellation handle. The host creates a token,
/// passes a clone into `RuntimeOptions`, and flips it via [`CancellationToken::cancel`]
/// to interrupt an in-flight execution at the next interrupt-check point.
/// Cancellation is sticky and idempotent; dropping the token does not cancel.
#[derive(Clone, Default)]
pub struct CancellationToken {
    flag: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// A single host-binding-invocation audit record. `at_ms` is wall-clock
/// epoch-milliseconds for cross-runtime identity. `capability` is `None` when
/// the binding declares no gating capability.
#[derive(Debug, Clone)]
pub struct AuditEvent {
    pub binding: String,
    pub capability: Option<String>,
    pub at_ms: f64,
}

/// An opt-in sink invoked once per allowed host-binding invocation, before the
/// host function runs. Emission is best-effort and never propagates errors into
/// the sandbox.
pub type AuditSink = Arc<dyn Fn(AuditEvent) + Send + Sync>;

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Five-level log severity matching `tracing::Level`. `console.log` and
/// `console.info` both map to `Info`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSeverity {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// Host-imposed resource ceilings the manifest cannot exceed. The effective
/// limit per field is `min(manifest, hard)`; an over-requesting manifest is
/// clamped silently rather than rejected.
#[derive(Debug, Clone, Default)]
pub struct HardLimits {
    pub timeout_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub max_stack_depth: Option<usize>,
}

pub struct HostBindings {
    bindings: HashMap<String, HostBinding>,
}

/// A member of a nested host namespace. `Namespace` recurses to arbitrary depth.
pub enum HostNamespaceMember {
    Function(HostFn),
    AsyncFunction(AsyncHostFn),
    Property(serde_json::Value),
    Namespace(HashMap<String, HostNamespaceMember>),
}

enum HostBinding {
    Function(HostFn),
    AsyncFunction(AsyncHostFn),
    Namespace(HashMap<String, HostFn>),
    AsyncNamespace(HashMap<String, AsyncHostFn>),
    MixedNamespace {
        properties: serde_json::Map<String, serde_json::Value>,
        functions: HashMap<String, HostFn>,
    },
    NestedNamespace(HashMap<String, HostNamespaceMember>),
}

impl HostBindings {
    pub fn new() -> Self {
        Self {
            bindings: HashMap::new(),
        }
    }

    pub fn add_function<F>(&mut self, name: impl Into<String>, f: F)
    where
        F: Fn(&[serde_json::Value]) -> std::result::Result<serde_json::Value, String>
            + Send
            + Sync
            + 'static,
    {
        self.bindings
            .insert(name.into(), HostBinding::Function(Arc::new(f)));
    }

    pub fn add_namespace(&mut self, name: impl Into<String>, members: HashMap<String, HostFn>) {
        self.bindings
            .insert(name.into(), HostBinding::Namespace(members));
    }

    pub fn add_async_function<F, Fut>(&mut self, name: impl Into<String>, f: F)
    where
        F: Fn(&[serde_json::Value]) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<serde_json::Value, String>> + Send + 'static,
    {
        self.bindings.insert(
            name.into(),
            HostBinding::AsyncFunction(Arc::new(move |args| Box::pin(f(args)))),
        );
    }

    pub fn add_async_namespace(
        &mut self,
        name: impl Into<String>,
        members: HashMap<String, AsyncHostFn>,
    ) {
        self.bindings
            .insert(name.into(), HostBinding::AsyncNamespace(members));
    }

    /// Register a namespace whose members include plain JS property values
    /// (eagerly known at namespace-build time) alongside callable functions.
    /// Use when accessors like `run.id` / `run.inputs` should read as
    /// properties (`run.inputs`) rather than require invocation
    /// (`run.inputs()`), while sibling members like `run.tag(name)` remain
    /// real functions.
    pub fn add_mixed_namespace(
        &mut self,
        name: impl Into<String>,
        properties: serde_json::Map<String, serde_json::Value>,
        functions: HashMap<String, HostFn>,
    ) {
        self.bindings.insert(
            name.into(),
            HostBinding::MixedNamespace {
                properties,
                functions,
            },
        );
    }

    /// Register a namespace whose members may themselves be namespaces, to
    /// arbitrary depth. Leaf functions carry capability gating via the manifest;
    /// intermediate namespace nodes are plain frozen objects.
    pub fn add_nested_namespace(
        &mut self,
        name: impl Into<String>,
        members: HashMap<String, HostNamespaceMember>,
    ) {
        self.bindings
            .insert(name.into(), HostBinding::NestedNamespace(members));
    }

    /// Fluent entry point for building a namespace. Accumulate members via
    /// [`NamespaceBuilder::bind`], [`NamespaceBuilder::bind_sync`], and
    /// [`NamespaceBuilder::property`], then [`NamespaceBuilder::finish`] to
    /// register. Sugar over `add_async_namespace`/`add_mixed_namespace`.
    pub fn namespace(&mut self, name: impl Into<String>) -> NamespaceBuilder<'_> {
        NamespaceBuilder {
            owner: self,
            name: name.into(),
            async_members: HashMap::new(),
            sync_members: HashMap::new(),
            properties: serde_json::Map::new(),
        }
    }
}

/// A fluent combinator for registering a namespace on [`HostBindings`].
pub struct NamespaceBuilder<'a> {
    owner: &'a mut HostBindings,
    name: String,
    async_members: HashMap<String, AsyncHostFn>,
    sync_members: HashMap<String, HostFn>,
    properties: serde_json::Map<String, serde_json::Value>,
}

impl<'a> NamespaceBuilder<'a> {
    /// Add an async member. The closure is boxed and pinned internally.
    pub fn bind<F, Fut>(mut self, name: impl Into<String>, f: F) -> Self
    where
        F: Fn(&[serde_json::Value]) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<serde_json::Value, String>> + Send + 'static,
    {
        let arc: AsyncHostFn = Arc::new(move |args| Box::pin(f(args)));
        self.async_members.insert(name.into(), arc);
        self
    }

    /// Add a synchronous member.
    pub fn bind_sync<F>(mut self, name: impl Into<String>, f: F) -> Self
    where
        F: Fn(&[serde_json::Value]) -> std::result::Result<serde_json::Value, String>
            + Send
            + Sync
            + 'static,
    {
        self.sync_members.insert(name.into(), Arc::new(f));
        self
    }

    /// Add an eager property value.
    pub fn property(mut self, name: impl Into<String>, value: serde_json::Value) -> Self {
        self.properties.insert(name.into(), value);
        self
    }

    /// Register the accumulated members on the owning [`HostBindings`]. A
    /// pure-async namespace registers as an async namespace; any sync member or
    /// property produces a mixed/nested namespace registration.
    pub fn finish(self) {
        let NamespaceBuilder {
            owner,
            name,
            async_members,
            sync_members,
            properties,
        } = self;

        if sync_members.is_empty() && properties.is_empty() {
            owner.add_async_namespace(name, async_members);
            return;
        }

        if async_members.is_empty() {
            owner.add_mixed_namespace(name, properties, sync_members);
            return;
        }

        let mut members: HashMap<String, HostNamespaceMember> = HashMap::new();
        for (k, v) in async_members {
            members.insert(k, HostNamespaceMember::AsyncFunction(v));
        }
        for (k, v) in sync_members {
            members.insert(k, HostNamespaceMember::Function(v));
        }
        for (k, v) in properties {
            members.insert(k, HostNamespaceMember::Property(v));
        }
        owner.add_nested_namespace(name, members);
    }
}

impl Default for HostBindings {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ConsoleHandler {
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    pub warn: Box<dyn Fn(&str) + Send + Sync>,
    pub error: Box<dyn Fn(&str) + Send + Sync>,
    /// Unified severity sink that all six sandbox console methods route through.
    /// `None` falls back to dispatching the legacy `log`/`warn`/`error` boxes
    /// (`Info`/`Debug`/`Trace` -> log, `Warn` -> warn, `Error` -> error).
    pub on: Option<Box<dyn Fn(LogSeverity, &str) + Send + Sync>>,
}

impl Default for ConsoleHandler {
    fn default() -> Self {
        Self {
            log: Box::new(|_| {}),
            warn: Box::new(|_| {}),
            error: Box::new(|_| {}),
            on: None,
        }
    }
}

impl ConsoleHandler {
    fn dispatch(&self, severity: LogSeverity, msg: &str) {
        if let Some(ref on) = self.on {
            on(severity, msg);
            return;
        }
        match severity {
            LogSeverity::Warn => (self.warn)(msg),
            LogSeverity::Error => (self.error)(msg),
            _ => (self.log)(msg),
        }
    }
}

#[derive(Default)]
pub struct RuntimeOptions {
    pub host_bindings: HostBindings,
    pub capabilities: Vec<String>,
    pub console: ConsoleHandler,
    pub cancellation: Option<CancellationToken>,
    pub audit: Option<AuditSink>,
    pub hard_limits: Option<HardLimits>,
    pub role_preferences: HashMap<String, String>,
    pub debug: Option<crate::debug::DebugOptions>,
}

impl RuntimeOptions {
    /// Wraps an `mpsc::Sender<AuditEvent>` in an [`AuditSink`] so a host can use
    /// a channel directly. Send failures (dropped receiver) are swallowed.
    pub fn with_audit_channel(mut self, tx: std::sync::mpsc::Sender<AuditEvent>) -> Self {
        let sink: AuditSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        self.audit = Some(sink);
        self
    }
}


#[derive(Debug)]
pub struct ExecutionResult {
    pub value: serde_json::Value,
    pub duration_ms: f64,
}

/// A lightweight handle to a loaded fragment contribution targeting a slot.
/// Full content is reachable via the owning mod's `FragmentInstance`.
#[derive(Debug, Clone, PartialEq)]
pub struct SlotContribution {
    pub mod_name: String,
    pub fragment_id: String,
    pub slot: String,
    pub format: String,
    pub priority: i32,
}

/// The result of resolving a logical role: the providing mod's `name` and the
/// logical->concrete fn map declared in its winning contribution. xript never
/// invokes the named fns — the host calls them through its own export/binding
/// path. `fns` uses a `BTreeMap` for stable ordering across runs.
#[derive(Debug, Clone, PartialEq)]
pub struct RoleResolution {
    pub addon: String,
    pub role: String,
    pub fns: std::collections::BTreeMap<String, String>,
}

/// A module resolver that rejects every specifier. xript mods are
/// single-entry self-contained modules; no import (bare, absolute, URL, or
/// relative) is satisfiable from inside the sandbox. Combined with the
/// pre-evaluation import scan, this is the runtime-side defense-in-depth that
/// also catches dynamic `import(...)` at call time.
struct DenyAllResolver;

impl Resolver for DenyAllResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        _base: &str,
        name: &str,
    ) -> std::result::Result<String, QjsError> {
        Err(QjsError::new_resolving_message(
            "<sandbox>",
            name.to_string(),
            format!(
                "import of \"{name}\" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)"
            ),
        ))
    }
}

struct DenyAllLoader;

impl Loader for DenyAllLoader {
    fn load<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        name: &str,
    ) -> std::result::Result<Module<'js, Declared>, QjsError> {
        Err(QjsError::new_loading_message(
            name,
            "xript mods cannot import external modules",
        ))
    }
}

pub struct XriptRuntime {
    rt: Runtime,
    ctx: Context,
    manifest: Manifest,
    cancellation: Option<CancellationToken>,
    effective_timeout_ms: u64,
    loaded_mods: std::sync::Mutex<Vec<crate::fragment::ModInstance>>,
    export_caps: std::sync::Mutex<HashMap<String, Option<String>>>,
    granted: HashSet<String>,
    role_preferences: HashMap<String, String>,
    debug: Option<crate::debug::DebugSession>,
}

impl std::fmt::Debug for XriptRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("XriptRuntime")
            .field("manifest_name", &self.manifest.name)
            .finish_non_exhaustive()
    }
}

fn effective_limit(manifest: Option<u64>, hard: Option<u64>) -> Option<u64> {
    match (manifest, hard) {
        (Some(m), Some(h)) => Some(m.min(h)),
        (Some(m), None) => Some(m),
        (None, Some(h)) => Some(h),
        (None, None) => None,
    }
}

fn effective_stack(manifest: Option<usize>, hard: Option<usize>) -> Option<usize> {
    match (manifest, hard) {
        (Some(m), Some(h)) => Some(m.min(h)),
        (Some(m), None) => Some(m),
        (None, Some(h)) => Some(h),
        (None, None) => None,
    }
}

impl XriptRuntime {
    pub fn new(manifest: Manifest, options: RuntimeOptions) -> Result<Self> {
        crate::manifest::validate_structure(&manifest)?;

        let rt = Runtime::new().map_err(|e| XriptError::Engine(e.to_string()))?;
        rt.set_loader(DenyAllResolver, DenyAllLoader);

        let manifest_mem = manifest.limits.as_ref().and_then(|l| l.memory_mb);
        let manifest_stack = manifest.limits.as_ref().and_then(|l| l.max_stack_depth);
        let hard = options.hard_limits.clone().unwrap_or_default();

        if let Some(memory_mb) = effective_limit(manifest_mem, hard.memory_mb) {
            rt.set_memory_limit(memory_mb as usize * 1024 * 1024);
        }
        if let Some(stack) = effective_stack(manifest_stack, hard.max_stack_depth) {
            rt.set_max_stack_size(stack * 1024);
        }

        let manifest_timeout = manifest.limits.as_ref().and_then(|l| l.timeout_ms);
        let effective_timeout_ms =
            effective_limit(manifest_timeout, hard.timeout_ms).unwrap_or(5000);

        let ctx = Context::full(&rt).map_err(|e| XriptError::Engine(e.to_string()))?;

        let granted: HashSet<String> = options.capabilities.into_iter().collect();
        let audit = options.audit.clone();
        let cancellation = options.cancellation.clone();
        let role_preferences = options.role_preferences;

        let debug = options
            .debug
            .map(crate::debug::DebugSession::new);

        ctx.with(|ctx| -> Result<()> {
            remove_dangerous_globals(&ctx)?;
            register_console(&ctx, options.console)?;
            register_bindings(&ctx, &manifest, options.host_bindings, &granted, &audit)?;
            register_hooks(&ctx, &manifest, &granted)?;
            register_fragment_hooks(&ctx)?;
            register_exports_surface(&ctx)?;
            if let Some(ref session) = debug {
                crate::debug::register_debug_probe(&ctx, session)?;
            }
            Ok(())
        })?;

        Ok(Self {
            rt,
            ctx,
            manifest,
            cancellation,
            effective_timeout_ms,
            loaded_mods: std::sync::Mutex::new(Vec::new()),
            export_caps: std::sync::Mutex::new(HashMap::new()),
            granted,
            role_preferences,
            debug,
        })
    }

    pub fn execute(&self, code: &str) -> Result<ExecutionResult> {
        if let Some(ref token) = self.cancellation
            && token.is_cancelled()
        {
            return Err(XriptError::Cancelled);
        }

        let timeout_ms = self.effective_timeout_ms;

        let interrupted = Arc::new(AtomicBool::new(false));
        let interrupted_clone = interrupted.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_clone = cancelled.clone();
        let token = self.cancellation.clone();
        let start = Instant::now();
        let deadline = start + Duration::from_millis(timeout_ms);
        let debug_clock = self.debug.as_ref().map(|d| d.paused_clock());

        self.rt
            .set_interrupt_handler(Some(Box::new(move || {
                if token.as_ref().map(|t| t.is_cancelled()).unwrap_or(false) {
                    cancelled_clone.store(true, Ordering::Relaxed);
                    return true;
                }
                let paused = debug_clock
                    .as_ref()
                    .map(|c| Duration::from_millis(c.load(Ordering::Relaxed)))
                    .unwrap_or_default();
                if Instant::now() >= deadline + paused {
                    interrupted_clone.store(true, Ordering::Relaxed);
                    true
                } else {
                    false
                }
            }) as Box<dyn FnMut() -> bool + Send>));

        let result = self.ctx.with(|ctx| {
            let res: std::result::Result<Value, _> = ctx.eval(code);
            match res {
                Ok(val) => {
                    while ctx.execute_pending_job() {}
                    match resolve_if_promise(&ctx, val) {
                        PromiseOutcome::NotPromise(v) | PromiseOutcome::Resolved(v) => {
                            Ok(js_value_to_json(&ctx, &v))
                        }
                        PromiseOutcome::Rejected(v) => {
                            Err(XriptError::Script(format_rejection(&ctx, &v)))
                        }
                        PromiseOutcome::Pending => Err(XriptError::Script(
                            "workflow promise never resolved (no pending jobs left)".into(),
                        )),
                    }
                }
                Err(_) => {
                    if cancelled.load(Ordering::Relaxed) {
                        Err(XriptError::Cancelled)
                    } else if interrupted.load(Ordering::Relaxed) {
                        Err(XriptError::ExecutionLimit {
                            limit: "timeout_ms".into(),
                        })
                    } else {
                        let caught = ctx.catch();
                        Err(XriptError::Script(format_rejection(&ctx, &caught)))
                    }
                }
            }
        });

        self.rt
            .set_interrupt_handler(None::<Box<dyn FnMut() -> bool + Send>>);

        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

        result.map(|value| ExecutionResult { value, duration_ms })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Result<crate::fragment::ModInstance> {
        let mod_instance = crate::fragment::load_mod(
            mod_manifest_json,
            &self.manifest,
            granted_capabilities,
            &fragment_sources,
        )?;

        let mod_manifest: crate::manifest::ModManifest =
            serde_json::from_str(mod_manifest_json).map_err(XriptError::Json)?;
        let entry = mod_manifest.entry_block();
        if let Some(ref entry) = entry {
            let mut caps = self.export_caps.lock().unwrap();
            for (export_name, decl) in &entry.exports {
                caps.insert(export_name.clone(), decl.capability.clone());
            }
        }

        let is_module = entry
            .as_ref()
            .map(|e| e.format == "module")
            .unwrap_or(false);

        if let Some(source) = entry_source {
            let mod_name = mod_instance.name.clone();
            crate::module::check_entry_source(&mod_name, source, is_module)?;

            if is_module {
                self.eval_module_entry(&mod_name, source)?;
            } else {
                self.ctx.with(|ctx| {
                    let res: std::result::Result<Value, _> = ctx.eval(source);
                    if res.is_err() {
                        let caught = ctx.catch();
                        return Err(XriptError::ModEntry {
                            mod_name,
                            message: format_rejection(&ctx, &caught),
                        });
                    }
                    Ok(())
                })?;
            }
        }

        self.loaded_mods.lock().unwrap().push(mod_instance.clone());

        Ok(mod_instance)
    }

    fn eval_module_entry(&self, mod_name: &str, source: &str) -> Result<()> {
        let timeout_ms = self.effective_timeout_ms;
        let interrupted = Arc::new(AtomicBool::new(false));
        let interrupted_clone = interrupted.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_clone = cancelled.clone();
        let token = self.cancellation.clone();
        let start = Instant::now();
        let deadline = start + Duration::from_millis(timeout_ms);

        self.rt
            .set_interrupt_handler(Some(Box::new(move || {
                if token.as_ref().map(|t| t.is_cancelled()).unwrap_or(false) {
                    cancelled_clone.store(true, Ordering::Relaxed);
                    return true;
                }
                if Instant::now() >= deadline {
                    interrupted_clone.store(true, Ordering::Relaxed);
                    true
                } else {
                    false
                }
            }) as Box<dyn FnMut() -> bool + Send>));

        let result = self.ctx.with(|ctx| -> Result<()> {
            let declared = match Module::declare(ctx.clone(), "xript:mod-entry", source) {
                Ok(m) => m,
                Err(_) => {
                    return Err(module_eval_error(&ctx, mod_name, &cancelled, &interrupted));
                }
            };

            let (evaluated, promise) = match declared.eval() {
                Ok(pair) => pair,
                Err(_) => {
                    return Err(module_eval_error(&ctx, mod_name, &cancelled, &interrupted));
                }
            };

            loop {
                match promise.state() {
                    PromiseState::Pending => {
                        if !ctx.execute_pending_job() {
                            if cancelled.load(Ordering::Relaxed) {
                                return Err(XriptError::Cancelled);
                            }
                            if interrupted.load(Ordering::Relaxed) {
                                return Err(XriptError::ExecutionLimit {
                                    limit: "timeout_ms".into(),
                                });
                            }
                            return Err(XriptError::ModEntry {
                                mod_name: mod_name.to_string(),
                                message: "module top-level await never settled (no pending jobs left)".into(),
                            });
                        }
                    }
                    PromiseState::Resolved => break,
                    PromiseState::Rejected => {
                        let _ = promise.result::<Value>();
                        let rejection = ctx.catch();
                        return Err(XriptError::ModEntry {
                            mod_name: mod_name.to_string(),
                            message: format_rejection(&ctx, &rejection),
                        });
                    }
                }
            }

            harvest_named_exports(&ctx, &evaluated)
        });

        self.rt
            .set_interrupt_handler(None::<Box<dyn FnMut() -> bool + Send>>);

        result
    }

    /// Invokes a host-invokable export the entry script registered via
    /// `xript.exports.register(name, fn)`. Args are JSON-serializable; the
    /// return value is honored. An undeclared/unregistered export, or one that
    /// throws, surfaces as [`XriptError::Invoke`]. A declared export whose
    /// capability is not granted surfaces as [`XriptError::CapabilityDenied`].
    pub fn invoke_export(
        &self,
        name: &str,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        if let Some(Some(cap)) = self.export_caps.lock().unwrap().get(name)
            && !self.granted.contains(cap)
        {
            return Err(XriptError::CapabilityDenied {
                binding: name.to_string(),
                capability: cap.clone(),
            });
        }

        let args_json = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
        let escaped_name = name.replace('\\', "\\\\").replace('\'', "\\'");
        let escaped_args = args_json.replace('\\', "\\\\").replace('`', "\\`");
        let code = format!(
            r#"(function() {{
                var registry = globalThis.__xript_exports || {{}};
                var fn = registry['{name}'];
                if (typeof fn !== 'function') {{
                    return JSON.stringify({{ __xript_err: "export {name} not found" }});
                }}
                try {{
                    var args = JSON.parse(`{args}`);
                    var result = fn.apply(null, args);
                    return JSON.stringify({{ __xript_ok: result === undefined ? null : result }});
                }} catch (e) {{
                    return JSON.stringify({{ __xript_err: (e && e.message) ? e.message : String(e) }});
                }}
            }})()"#,
            name = escaped_name,
            args = escaped_args,
        );

        let result = self.execute(&code)?;
        let raw = result.value.as_str().unwrap_or("{}");
        let envelope: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
        if let Some(err) = envelope.get("__xript_err").and_then(|v| v.as_str()) {
            return Err(XriptError::Invoke {
                export: name.to_string(),
                message: err.to_string(),
            });
        }
        Ok(envelope
            .get("__xript_ok")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    /// Returns the loaded fragment contributions targeting `slot_id`, ordered by
    /// priority descending then fragment id ascending. When the slot's
    /// `multiple` is false (default), at most one contribution (the winner) is
    /// returned. An undeclared slot id returns an empty vec.
    pub fn resolve_slot(&self, slot_id: &str) -> Vec<SlotContribution> {
        let multiple = self
            .manifest
            .slots
            .as_ref()
            .and_then(|slots| slots.iter().find(|s| s.id == slot_id))
            .and_then(|s| s.multiple)
            .unwrap_or(false);

        let mods = self.loaded_mods.lock().unwrap();
        let mut contributions: Vec<SlotContribution> = Vec::new();
        for m in mods.iter() {
            for frag in &m.fragments {
                if frag.slot == slot_id {
                    contributions.push(SlotContribution {
                        mod_name: m.name.clone(),
                        fragment_id: frag.id.clone(),
                        slot: frag.slot.clone(),
                        format: frag.format.clone(),
                        priority: frag.priority,
                    });
                }
            }
        }

        contributions.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.fragment_id.cmp(&b.fragment_id))
        });

        if !multiple {
            contributions.truncate(1);
        }
        contributions
    }

    /// Convenience for single-cardinality slots: returns the winning
    /// contribution, or `None` when the slot has no contributions.
    pub fn resolve_slot_single(&self, slot_id: &str) -> Option<SlotContribution> {
        self.resolve_slot(slot_id).into_iter().next()
    }

    /// Returns every loaded mod that provides `role`, in load order. The host
    /// uses this ordered candidate set to build its own picker UI. An
    /// unprovided role returns an empty vec.
    pub fn resolve_role_all(&self, role: &str) -> Vec<RoleResolution> {
        let mods = self.loaded_mods.lock().unwrap();
        let mut out = Vec::new();
        for m in mods.iter() {
            for provided in &m.provides {
                if provided.role == role {
                    out.push(RoleResolution {
                        addon: m.name.clone(),
                        role: provided.role.clone(),
                        fns: provided.fns.clone(),
                    });
                }
            }
        }
        out
    }

    /// Resolves the winning provider for `role`. Policy is first-installed-wins
    /// (load order) unless `role_preferences[role]` names a candidate present in
    /// the loaded set, in which case that addon wins. A role with no provider
    /// resolves to `None`. xript never invokes the returned fns.
    pub fn resolve_role(&self, role: &str) -> Option<RoleResolution> {
        let candidates = self.resolve_role_all(role);
        if candidates.is_empty() {
            return None;
        }
        if let Some(preferred) = self.role_preferences.get(role) {
            if let Some(hit) = candidates.iter().find(|c| &c.addon == preferred) {
                return Some(hit.clone());
            }
        }
        candidates.into_iter().next()
    }

    /// Returns the attached DAP debug session, or `None` when the runtime was
    /// built without a `debug` option. Default off, zero overhead when absent.
    pub fn debug_session(&self) -> Option<&crate::debug::DebugSession> {
        self.debug.as_ref()
    }

    pub fn fire_fragment_hook(
        &self,
        fragment_id: &str,
        lifecycle: &str,
        bindings: Option<&serde_json::Value>,
    ) -> Result<Vec<serde_json::Value>> {
        let bindings_json = match bindings {
            Some(b) => serde_json::to_string(b).unwrap_or("{}".into()),
            None => "{}".into(),
        };

        let code = format!(
            r#"(function() {{
                var handlers = globalThis.__xript_fragment_handlers || {{}};
                var key = "fragment:{lifecycle}:{fid}";
                var list = handlers[key] || [];
                var results = [];
                var bindingsObj = JSON.parse('{bindings_json}');
                for (var i = 0; i < list.length; i++) {{
                    var ops = [];
                    var proxy = {{
                        toggle: function(sel, cond) {{ ops.push({{ op: "toggle", selector: sel, value: !!cond }}); }},
                        addClass: function(sel, cls) {{ ops.push({{ op: "addClass", selector: sel, value: cls }}); }},
                        removeClass: function(sel, cls) {{ ops.push({{ op: "removeClass", selector: sel, value: cls }}); }},
                        setText: function(sel, txt) {{ ops.push({{ op: "setText", selector: sel, value: txt }}); }},
                        setAttr: function(sel, attr, val) {{ ops.push({{ op: "setAttr", selector: sel, attr: attr, value: val }}); }},
                        replaceChildren: function(sel, html) {{ ops.push({{ op: "replaceChildren", selector: sel, value: html }}); }}
                    }};
                    list[i](bindingsObj, proxy);
                    results.push(ops);
                }}
                return JSON.stringify(results);
            }})()"#,
            lifecycle = lifecycle,
            fid = fragment_id,
            bindings_json = bindings_json.replace('\'', "\\'"),
        );

        let result = self.execute(&code)?;
        match serde_json::from_str::<Vec<serde_json::Value>>(
            result.value.as_str().unwrap_or("[]"),
        ) {
            Ok(ops) => Ok(ops),
            Err(_) => Ok(vec![]),
        }
    }
}

fn module_eval_error(
    ctx: &Ctx<'_>,
    mod_name: &str,
    cancelled: &Arc<AtomicBool>,
    interrupted: &Arc<AtomicBool>,
) -> XriptError {
    if cancelled.load(Ordering::Relaxed) {
        return XriptError::Cancelled;
    }
    if interrupted.load(Ordering::Relaxed) {
        return XriptError::ExecutionLimit {
            limit: "timeout_ms".into(),
        };
    }
    let caught = ctx.catch();
    XriptError::ModEntry {
        mod_name: mod_name.to_string(),
        message: format_rejection(ctx, &caught),
    }
}

/// Copies the module's top-level function-valued named exports into the shared
/// `globalThis.__xript_exports` registry, the same registry
/// `xript.exports.register` feeds. An explicit `register()` call wins on name
/// collision: names already present from a register call during evaluation are
/// left untouched. Non-function exports and the default export are ignored.
fn harvest_named_exports<'js>(
    ctx: &Ctx<'js>,
    module: &Module<'js, Evaluated>,
) -> Result<()> {
    let namespace = module
        .namespace()
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    let registry: Object = ctx
        .globals()
        .get("__xript_exports")
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    for entry in namespace.props::<String, Value>() {
        let (name, value) = entry.map_err(|e| XriptError::Engine(e.to_string()))?;
        if name == "default" {
            continue;
        }
        if value.as_function().is_none() {
            continue;
        }
        let already: bool = registry
            .get::<_, Value>(name.as_str())
            .map(|v| v.as_function().is_some())
            .unwrap_or(false);
        if already {
            continue;
        }
        registry
            .set(name.as_str(), value)
            .map_err(|e| XriptError::Engine(e.to_string()))?;
    }

    Ok(())
}

fn remove_dangerous_globals(ctx: &Ctx<'_>) -> Result<()> {
    let script = r#"
        delete globalThis.eval;
        if (typeof globalThis.Function !== 'undefined') {
            Object.defineProperty(globalThis, 'Function', {
                get: function() { throw new Error("Function constructor is not permitted. Dynamic code generation is disabled in xript."); },
                configurable: false
            });
        }
    "#;
    ctx.eval::<(), _>(script)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    Ok(())
}

fn register_console(ctx: &Ctx<'_>, console: ConsoleHandler) -> Result<()> {
    let console_obj = Object::new(ctx.clone()).map_err(|e| XriptError::Engine(e.to_string()))?;

    let handler = Arc::new(console);

    let methods: [(&str, LogSeverity); 6] = [
        ("trace", LogSeverity::Trace),
        ("debug", LogSeverity::Debug),
        ("log", LogSeverity::Info),
        ("info", LogSeverity::Info),
        ("warn", LogSeverity::Warn),
        ("error", LogSeverity::Error),
    ];

    for (method, severity) in methods {
        let handler_clone = handler.clone();
        let f = Function::new(ctx.clone(), move |args: Rest<String>| {
            let msg = args.0.join(" ");
            handler_clone.dispatch(severity, &msg);
        })
        .map_err(|e| XriptError::Engine(e.to_string()))?;
        console_obj
            .set(method, f)
            .map_err(|e| XriptError::Engine(e.to_string()))?;
    }

    ctx.globals()
        .set("console", console_obj)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn register_exports_surface(ctx: &Ctx<'_>) -> Result<()> {
    let script = r#"
        globalThis.__xript_exports = {};
        var exportsNs = {
            register: function(name, fn) {
                if (typeof name !== 'string') {
                    throw new Error("xript.exports.register: name must be a string");
                }
                if (typeof fn !== 'function') {
                    throw new Error("xript.exports.register: fn must be a function");
                }
                globalThis.__xript_exports[name] = fn;
            }
        };
        Object.freeze(exportsNs);
        var xriptNs = (typeof globalThis.xript === 'object' && globalThis.xript !== null) ? globalThis.xript : {};
        xriptNs.exports = exportsNs;
        globalThis.xript = xriptNs;
    "#;
    ctx.eval::<(), _>(script)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    Ok(())
}

fn make_throwing_function<'js>(ctx: &Ctx<'js>, message: &str) -> Result<Function<'js>> {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("(function() {{ throw new Error(\"{}\"); }})", escaped);
    ctx.eval::<Function, _>(script.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))
}

/// Wraps a [`HostFn`] so each invocation emits an audit event (binding name +
/// gating capability) before the host function runs. Emission is best-effort.
fn audited_sync(f: HostFn, audit: &Option<AuditSink>, binding: &str, capability: Option<String>) -> HostFn {
    let Some(sink) = audit.clone() else {
        return f;
    };
    let binding = binding.to_string();
    Arc::new(move |args| {
        sink(AuditEvent {
            binding: binding.clone(),
            capability: capability.clone(),
            at_ms: now_ms(),
        });
        f(args)
    })
}

fn audited_async(
    f: AsyncHostFn,
    audit: &Option<AuditSink>,
    binding: &str,
    capability: Option<String>,
) -> AsyncHostFn {
    let Some(sink) = audit.clone() else {
        return f;
    };
    let binding = binding.to_string();
    Arc::new(move |args| {
        sink(AuditEvent {
            binding: binding.clone(),
            capability: capability.clone(),
            at_ms: now_ms(),
        });
        f(args)
    })
}

fn register_bindings(
    ctx: &Ctx<'_>,
    manifest: &Manifest,
    host_bindings: HostBindings,
    granted: &HashSet<String>,
    audit: &Option<AuditSink>,
) -> Result<()> {
    let Some(ref bindings) = manifest.bindings else {
        return Ok(());
    };

    for (name, binding) in bindings {
        match binding {
            Binding::Function(func_def) => {
                if let Some(ref cap) = func_def.capability {
                    if !granted.contains(cap) {
                        let msg = format!(
                            "{}() requires the \"{}\" capability, which hasn't been granted to this script",
                            name, cap
                        );
                        let deny_fn = make_throwing_function(ctx, &msg)?;
                        ctx.globals()
                            .set(name.as_str(), deny_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                        continue;
                    }
                }

                let cap = func_def.capability.clone();
                match host_bindings.bindings.get(name) {
                    Some(HostBinding::Function(f)) => {
                        let wrapped = audited_sync(f.clone(), audit, name, cap);
                        let js_fn = create_host_function(ctx, name, wrapped)?;
                        ctx.globals()
                            .set(name.as_str(), js_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                    }
                    Some(HostBinding::AsyncFunction(f)) => {
                        let wrapped = audited_async(f.clone(), audit, name, cap);
                        let js_fn = create_async_host_function(ctx, name, wrapped)?;
                        ctx.globals()
                            .set(name.as_str(), js_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                    }
                    _ => {
                        let msg = format!("host binding '{}' is not provided", name);
                        let missing_fn = make_throwing_function(ctx, &msg)?;
                        ctx.globals()
                            .set(name.as_str(), missing_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                    }
                }
            }
            Binding::Namespace(ns_def) => {
                register_namespace_binding(ctx, name, ns_def, &host_bindings, granted, audit)?;
            }
        }
    }

    Ok(())
}

enum HostNsView<'a> {
    Sync(&'a HashMap<String, HostFn>),
    Async(&'a HashMap<String, AsyncHostFn>),
    Mixed {
        properties: &'a serde_json::Map<String, serde_json::Value>,
        functions: &'a HashMap<String, HostFn>,
    },
    Nested(&'a HashMap<String, HostNamespaceMember>),
    None,
}

fn register_namespace_binding(
    ctx: &Ctx<'_>,
    name: &str,
    ns_def: &NamespaceBinding,
    host_bindings: &HostBindings,
    granted: &HashSet<String>,
    audit: &Option<AuditSink>,
) -> Result<()> {
    let host_view = match host_bindings.bindings.get(name) {
        Some(HostBinding::Namespace(m)) => HostNsView::Sync(m),
        Some(HostBinding::AsyncNamespace(m)) => HostNsView::Async(m),
        Some(HostBinding::MixedNamespace {
            properties,
            functions,
        }) => HostNsView::Mixed {
            properties,
            functions,
        },
        Some(HostBinding::NestedNamespace(m)) => HostNsView::Nested(m),
        _ => HostNsView::None,
    };

    let ns_obj = build_namespace_object(ctx, name, &ns_def.members, &host_view, granted, audit)?;

    ctx.globals()
        .set(name, ns_obj)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    deep_freeze(ctx, name)?;

    Ok(())
}

fn build_namespace_object<'js>(
    ctx: &Ctx<'js>,
    path: &str,
    members: &HashMap<String, Binding>,
    host_view: &HostNsView<'_>,
    granted: &HashSet<String>,
    audit: &Option<AuditSink>,
) -> Result<Object<'js>> {
    let ns_obj = Object::new(ctx.clone()).map_err(|e| XriptError::Engine(e.to_string()))?;

    for (member_name, member_binding) in members {
        let full_name = format!("{}.{}", path, member_name);

        match member_binding {
            Binding::Namespace(sub_ns) => {
                let sub_view = nested_host_view(host_view, member_name);
                let sub_obj =
                    build_namespace_object(ctx, &full_name, &sub_ns.members, &sub_view, granted, audit)?;
                ns_obj
                    .set(member_name.as_str(), sub_obj)
                    .map_err(|e| XriptError::Engine(e.to_string()))?;
            }
            Binding::Function(func_def) => {
                if let Some(ref cap) = func_def.capability {
                    if !granted.contains(cap) {
                        let msg = format!(
                            "{}() requires the \"{}\" capability, which hasn't been granted to this script",
                            full_name, cap
                        );
                        let deny_fn = make_throwing_function(ctx, &msg)?;
                        ns_obj
                            .set(member_name.as_str(), deny_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                        continue;
                    }
                }

                let cap = func_def.capability.clone();
                let value = resolve_namespace_member(
                    ctx,
                    &full_name,
                    member_name,
                    host_view,
                    cap,
                    audit,
                )?;
                ns_obj
                    .set(member_name.as_str(), value)
                    .map_err(|e| XriptError::Engine(e.to_string()))?;
            }
        }
    }

    Ok(ns_obj)
}

fn nested_host_view<'a>(view: &HostNsView<'a>, member: &str) -> HostNsView<'a> {
    if let HostNsView::Nested(map) = view
        && let Some(HostNamespaceMember::Namespace(sub)) = map.get(member)
    {
        return HostNsView::Nested(sub);
    }
    HostNsView::None
}

fn resolve_namespace_member<'js>(
    ctx: &Ctx<'js>,
    full_name: &str,
    member_name: &str,
    host_view: &HostNsView<'_>,
    capability: Option<String>,
    audit: &Option<AuditSink>,
) -> Result<Value<'js>> {
    match host_view {
        HostNsView::Mixed {
            properties,
            functions,
        } => {
            if let Some(value) = properties.get(member_name) {
                return json_to_js(ctx, value);
            }
            if let Some(f) = functions.get(member_name) {
                let wrapped = audited_sync(f.clone(), audit, full_name, capability);
                return Ok(create_host_function(ctx, full_name, wrapped)?.into_value());
            }
        }
        HostNsView::Sync(map) => {
            if let Some(f) = map.get(member_name) {
                let wrapped = audited_sync(f.clone(), audit, full_name, capability);
                return Ok(create_host_function(ctx, full_name, wrapped)?.into_value());
            }
        }
        HostNsView::Async(map) => {
            if let Some(f) = map.get(member_name) {
                let wrapped = audited_async(f.clone(), audit, full_name, capability);
                return Ok(create_async_host_function(ctx, full_name, wrapped)?.into_value());
            }
        }
        HostNsView::Nested(map) => match map.get(member_name) {
            Some(HostNamespaceMember::Function(f)) => {
                let wrapped = audited_sync(f.clone(), audit, full_name, capability);
                return Ok(create_host_function(ctx, full_name, wrapped)?.into_value());
            }
            Some(HostNamespaceMember::AsyncFunction(f)) => {
                let wrapped = audited_async(f.clone(), audit, full_name, capability);
                return Ok(create_async_host_function(ctx, full_name, wrapped)?.into_value());
            }
            Some(HostNamespaceMember::Property(value)) => {
                return json_to_js(ctx, value);
            }
            Some(HostNamespaceMember::Namespace(_)) => {
                return Err(XriptError::Binding {
                    binding: full_name.to_string(),
                    message: format!(
                        "manifest declares '{}' as a function but the host registered a namespace at the same path",
                        full_name
                    ),
                });
            }
            None => {}
        },
        HostNsView::None => {}
    }

    let msg = format!("host binding '{}' is not provided", full_name);
    Ok(make_throwing_function(ctx, &msg)?.into_value())
}

fn deep_freeze(ctx: &Ctx<'_>, name: &str) -> Result<()> {
    let escaped = name.replace('\'', "\\'");
    let script = format!(
        r#"(function() {{
            var seen = [];
            function freeze(o) {{
                if (o === null || typeof o !== 'object') return;
                if (seen.indexOf(o) !== -1) return;
                seen.push(o);
                var keys = Object.getOwnPropertyNames(o);
                for (var i = 0; i < keys.length; i++) {{
                    freeze(o[keys[i]]);
                }}
                Object.freeze(o);
            }}
            freeze(globalThis['{}']);
        }})()"#,
        escaped
    );
    ctx.eval::<(), _>(script.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    Ok(())
}

fn register_hooks(ctx: &Ctx<'_>, manifest: &Manifest, granted: &HashSet<String>) -> Result<()> {
    let Some(ref hooks) = manifest.hooks else {
        return Ok(());
    };

    if hooks.is_empty() {
        return Ok(());
    }

    let mut hook_setup = String::from("globalThis.__xript_hooks = {};\n");
    hook_setup.push_str("globalThis.hooks = {};\n");

    for (hook_name, hook_def) in hooks {
        hook_setup.push_str(&format!(
            "globalThis.__xript_hooks['{}'] = [];\n",
            hook_name
        ));

        if let Some(ref phases) = hook_def.phases {
            if !phases.is_empty() {
                hook_setup.push_str(&format!("globalThis.hooks['{}'] = {{}};\n", hook_name));
                for phase in phases {
                    let registration = if let Some(ref cap) = hook_def.capability {
                        if !granted.contains(cap) {
                            format!(
                                "globalThis.hooks['{hook}']['{phase}'] = function() {{ throw new Error(\"{hook}.{phase}() requires the \\\"{cap}\\\" capability\"); }};",
                                hook = hook_name, phase = phase, cap = cap
                            )
                        } else {
                            format!(
                                "globalThis.hooks['{hook}']['{phase}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ phase: '{phase}', handler: handler }}); }};",
                                hook = hook_name, phase = phase
                            )
                        }
                    } else {
                        format!(
                            "globalThis.hooks['{hook}']['{phase}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ phase: '{phase}', handler: handler }}); }};",
                            hook = hook_name, phase = phase
                        )
                    };
                    hook_setup.push_str(&registration);
                    hook_setup.push('\n');
                }
            }
        } else {
            let registration = if let Some(ref cap) = hook_def.capability {
                if !granted.contains(cap) {
                    format!(
                        "globalThis.hooks['{hook}'] = function() {{ throw new Error(\"{hook}() requires the \\\"{cap}\\\" capability\"); }};",
                        hook = hook_name, cap = cap
                    )
                } else {
                    format!(
                        "globalThis.hooks['{hook}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ handler: handler }}); }};",
                        hook = hook_name
                    )
                }
            } else {
                format!(
                    "globalThis.hooks['{hook}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ handler: handler }}); }};",
                    hook = hook_name
                )
            };
            hook_setup.push_str(&registration);
            hook_setup.push('\n');
        }
    }

    hook_setup.push_str("Object.freeze(globalThis.hooks);\n");

    ctx.eval::<(), _>(hook_setup.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn register_fragment_hooks(ctx: &Ctx<'_>) -> Result<()> {
    let script = r#"
        globalThis.__xript_fragment_handlers = {};

        var existingHooks = {};
        if (typeof globalThis.hooks === 'object' && globalThis.hooks !== null) {
            var hookKeys = Object.getOwnPropertyNames(globalThis.hooks);
            for (var i = 0; i < hookKeys.length; i++) {
                existingHooks[hookKeys[i]] = globalThis.hooks[hookKeys[i]];
            }
        }

        var fragmentNs = {};
        var lifecycles = ['mount', 'unmount', 'update', 'suspend', 'resume'];
        for (var j = 0; j < lifecycles.length; j++) {
            (function(lifecycle) {
                fragmentNs[lifecycle] = function(fragmentId, handler) {
                    var key = "fragment:" + lifecycle + ":" + fragmentId;
                    if (!globalThis.__xript_fragment_handlers[key]) {
                        globalThis.__xript_fragment_handlers[key] = [];
                    }
                    globalThis.__xript_fragment_handlers[key].push(handler);
                };
            })(lifecycles[j]);
        }
        Object.freeze(fragmentNs);
        existingHooks.fragment = fragmentNs;

        globalThis.hooks = existingHooks;
        Object.freeze(globalThis.hooks);
    "#;

    ctx.eval::<(), _>(script)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn create_host_function<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: HostFn,
) -> Result<Function<'js>> {
    let bridge_fn = Function::new(ctx.clone(), move |args_json: String| -> String {
        let args: Vec<serde_json::Value> = match serde_json::from_str(&args_json) {
            Ok(a) => a,
            Err(e) => {
                let err = serde_json::json!({"__xript_err": format!("invalid args: {}", e)});
                return serde_json::to_string(&err).unwrap();
            }
        };
        match f(&args) {
            Ok(result) => {
                let wrapped = serde_json::json!({"__xript_ok": result});
                serde_json::to_string(&wrapped).unwrap_or("{\"__xript_ok\":null}".into())
            }
            Err(msg) => {
                let err = serde_json::json!({"__xript_err": msg});
                serde_json::to_string(&err).unwrap()
            }
        }
    })
    .map_err(|e| {
        XriptError::Engine(format!("failed to create host function '{}': {}", name, e))
    })?;

    ctx.globals()
        .set("__xript_tmp_bridge", bridge_fn)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    let wrapper: Function = ctx.eval(
        "(function(bridge) { return function() { var args = Array.prototype.slice.call(arguments); var raw = bridge(JSON.stringify(args)); var envelope = JSON.parse(raw); if (envelope.__xript_err !== undefined) { throw new Error(envelope.__xript_err); } return envelope.__xript_ok; }; })(__xript_tmp_bridge)",
    )
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    ctx.eval::<(), _>("delete globalThis.__xript_tmp_bridge")
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(wrapper)
}

fn create_async_host_function<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: AsyncHostFn,
) -> Result<Function<'js>> {
    let bridge_fn = Function::new(ctx.clone(), move |args_json: String| -> String {
        let args: Vec<serde_json::Value> = match serde_json::from_str(&args_json) {
            Ok(a) => a,
            Err(e) => {
                let err = serde_json::json!({"__xript_err": format!("invalid args: {}", e)});
                return serde_json::to_string(&err).unwrap();
            }
        };
        match pollster::block_on(f(&args)) {
            Ok(result) => {
                let wrapped = serde_json::json!({"__xript_ok": result});
                serde_json::to_string(&wrapped).unwrap_or("{\"__xript_ok\":null}".into())
            }
            Err(msg) => {
                let err = serde_json::json!({"__xript_err": msg});
                serde_json::to_string(&err).unwrap()
            }
        }
    })
    .map_err(|e| {
        XriptError::Engine(format!(
            "failed to create async host function '{}': {}",
            name, e
        ))
    })?;

    ctx.globals()
        .set("__xript_tmp_bridge", bridge_fn)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    let wrapper: Function = ctx.eval(
        "(function(bridge) { return function() { var args = Array.prototype.slice.call(arguments); var raw = bridge(JSON.stringify(args)); var envelope = JSON.parse(raw); if (envelope.__xript_err !== undefined) { return Promise.reject(new Error(envelope.__xript_err)); } return Promise.resolve(envelope.__xript_ok); }; })(__xript_tmp_bridge)",
    )
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    ctx.eval::<(), _>("delete globalThis.__xript_tmp_bridge")
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(wrapper)
}

/// Outcome of awaiting a top-level promise. Distinguishing rejection
/// from resolution is the load-bearing change — the previous code
/// returned `Value` and silently treated `throw` inside an async
/// workflow as a successful return of `undefined`.
enum PromiseOutcome<'js> {
    NotPromise(Value<'js>),
    Resolved(Value<'js>),
    Rejected(Value<'js>),
    Pending,
}

fn resolve_if_promise<'js>(ctx: &Ctx<'js>, val: Value<'js>) -> PromiseOutcome<'js> {
    let Ok(promise) = Promise::from_value(val.clone()) else {
        return PromiseOutcome::NotPromise(val);
    };
    loop {
        match promise.state() {
            PromiseState::Pending => {
                if !ctx.execute_pending_job() {
                    return PromiseOutcome::Pending;
                }
            }
            PromiseState::Resolved => {
                let resolved = match promise.result::<Value>() {
                    Some(Ok(v)) => v,
                    _ => Value::new_undefined(ctx.clone()),
                };
                return PromiseOutcome::Resolved(resolved);
            }
            PromiseState::Rejected => {
                // `Promise::result` returns `Some(Err(Error::Exception))` for
                // a rejected promise and side-effects the rejection value
                // into the context where `ctx.catch()` retrieves it.
                let _ = promise.result::<Value>();
                let rejection = ctx.catch();
                return PromiseOutcome::Rejected(rejection);
            }
        }
    }
}

/// Best-effort string for a rejection value. Errors get `name: message`;
/// strings pass through; everything else is JSON-stringified so the user
/// sees something diagnosable rather than `[object Object]`.
fn format_rejection<'js>(ctx: &Ctx<'js>, val: &Value<'js>) -> String {
    if let Some(s) = val.as_string().and_then(|s| s.to_string().ok()) {
        return s;
    }
    if let Some(obj) = val.as_object() {
        let name: Option<String> = obj
            .get::<_, Value>("name")
            .ok()
            .and_then(|v| v.as_string().and_then(|s| s.to_string().ok()));
        let message: Option<String> = obj
            .get::<_, Value>("message")
            .ok()
            .and_then(|v| v.as_string().and_then(|s| s.to_string().ok()));
        if let Some(msg) = message {
            return match name {
                Some(n) if !n.is_empty() && n != "Error" => format!("{n}: {msg}"),
                _ => msg,
            };
        }
    }
    let json = js_value_to_json(ctx, val);
    if matches!(json, serde_json::Value::Null) {
        "(rejected with non-serializable value)".to_string()
    } else {
        json.to_string()
    }
}

fn json_to_js<'js>(ctx: &Ctx<'js>, value: &serde_json::Value) -> Result<Value<'js>> {
    let serialized = serde_json::to_string(value)
        .map_err(|e| XriptError::Engine(format!("json_to_js serialize: {e}")))?;
    let escaped = serialized.replace('\\', "\\\\").replace('`', "\\`");
    let script = format!("JSON.parse(`{}`)", escaped);
    ctx.eval::<Value, _>(script.as_str())
        .map_err(|e| XriptError::Engine(format!("json_to_js eval: {e}")))
}

fn js_value_to_json<'a>(ctx: &Ctx<'a>, val: &Value<'a>) -> serde_json::Value {
    if val.is_undefined() || val.is_null() {
        return serde_json::Value::Null;
    }

    if let Some(b) = val.as_bool() {
        return serde_json::Value::Bool(b);
    }

    if let Some(n) = val.as_int() {
        return serde_json::json!(n);
    }

    if let Some(n) = val.as_float() {
        if n.is_finite() {
            return serde_json::json!(n);
        }
        return serde_json::Value::Null;
    }

    if let Some(s) = val.as_string() {
        if let Ok(s) = s.to_string() {
            return serde_json::Value::String(s);
        }
    }

    let json_global: std::result::Result<Object, _> = ctx.globals().get("JSON");
    if let Ok(json_obj) = json_global {
        let stringify: std::result::Result<Function, _> = json_obj.get("stringify");
        if let Ok(func) = stringify {
            let result: std::result::Result<String, _> = func.call((val.clone(),));
            if let Ok(json_str) = result {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    return v;
                }
            }
        }
    }

    serde_json::Value::Null
}
