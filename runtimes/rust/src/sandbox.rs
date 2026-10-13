use rquickjs::function::Rest;
use rquickjs::loader::{Loader, Resolver};
use rquickjs::module::{Declared, Evaluated, Module};
use rquickjs::promise::{Promise, PromiseState};
use rquickjs::{AsyncContext, AsyncRuntime, Context, Ctx, Error as QjsError, Function, Object, Runtime, Value};
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

/// Whether an audit record describes an allowed invocation or a refusal on
/// capability grounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AuditDecision {
    #[default]
    Invoke,
    Denied,
}

/// A single capability-decision audit record. `at_ms` is wall-clock
/// epoch-milliseconds for cross-runtime identity. `capability` is `None` when
/// the binding declares no gating capability. `mod_name` and `hook` are set
/// only on [`AuditDecision::Denied`] records raised for a mod's hook fill.
///
/// Under a pool, `worker` names the runtime that raised the record and `seq`
/// is that worker's own monotonic counter. Audit order is **total per worker
/// and only partial across the pool**: `at_ms` is wall-clock, so a host that
/// wants a stable order should sort by `(worker, seq)` and accept that the
/// true cross-worker interleaving is not recoverable. Both are `None`/`0` for
/// a runtime that is not pooled.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct AuditEvent {
    pub binding: String,
    pub capability: Option<String>,
    pub at_ms: f64,
    pub decision: AuditDecision,
    pub mod_name: Option<String>,
    pub hook: Option<String>,
    pub worker: Option<usize>,
    pub seq: u64,
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
    /// Whether a top-level name is supplied at all, and (for a namespace) whether
    /// a member path beneath it resolves to something callable.
    fn supplies(&self, path: &[String]) -> bool {
        let Some((head, rest)) = path.split_first() else {
            return false;
        };
        let Some(binding) = self.bindings.get(head) else {
            return false;
        };
        match binding {
            HostBinding::Function(_) | HostBinding::AsyncFunction(_) => rest.is_empty(),
            HostBinding::Namespace(members) => rest.len() == 1 && members.contains_key(&rest[0]),
            HostBinding::AsyncNamespace(members) => rest.len() == 1 && members.contains_key(&rest[0]),
            HostBinding::MixedNamespace { functions, .. } => {
                rest.len() == 1 && functions.contains_key(&rest[0])
            }
            HostBinding::NestedNamespace(members) => nested_supplies(members, rest),
        }
    }
}

/// Every binding the manifest declares that `host_bindings` does not supply, fully
/// qualified and sorted.
///
/// A declared-but-unsupplied binding still installs — as a stub that throws when a mod
/// calls it — so the manifest and the host's actual wiring could disagree indefinitely
/// with nothing to catch it. A mod author reads the manifest, ships against a binding
/// that is documented and absent, and the failure lands on a user.
pub fn missing_binding_names(
    manifest: &crate::manifest::Manifest,
    host_bindings: &HostBindings,
) -> Vec<String> {
    let mut missing = Vec::new();
    if let Some(bindings) = manifest.bindings.as_ref() {
        collect_missing(bindings, host_bindings, &mut Vec::new(), &mut missing);
    }
    missing.sort();
    missing
}

fn collect_missing(
    bindings: &HashMap<String, Binding>,
    host: &HostBindings,
    path: &mut Vec<String>,
    out: &mut Vec<String>,
) {
    for (name, binding) in bindings {
        path.push(name.clone());
        match binding {
            Binding::Namespace(ns) => collect_missing(&ns.members, host, path, out),
            _ => {
                if !host.supplies(path) {
                    out.push(path.join("."));
                }
            }
        }
        path.pop();
    }
}

fn nested_supplies(members: &HashMap<String, HostNamespaceMember>, path: &[String]) -> bool {
    let Some((head, rest)) = path.split_first() else {
        return false;
    };
    match members.get(head) {
        Some(HostNamespaceMember::Function(_)) | Some(HostNamespaceMember::AsyncFunction(_)) => {
            rest.is_empty()
        }
        Some(HostNamespaceMember::Namespace(inner)) => nested_supplies(inner, rest),
        _ => false,
    }
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
    pub libraries: HashMap<String, String>,
    pub console: ConsoleHandler,
    pub cancellation: Option<CancellationToken>,
    pub audit: Option<AuditSink>,
    pub hard_limits: Option<HardLimits>,
    pub role_preferences: HashMap<String, String>,
    /// Preferred owning mod for a bare command id, or for every command in a
    /// slot, keyed by command id or slot id.
    pub command_preferences: HashMap<String, String>,
    pub debug: Option<crate::debug::DebugOptions>,
    /// Promotes an unknown node under the built-in HTML vocabulary from a
    /// warning to an error, refusing the fragment instead of dropping the tag.
    pub strict_html_vocabulary: bool,
    /// Refuse to construct the runtime when the manifest declares a binding the
    /// host did not supply, instead of installing a stub that throws only once a
    /// mod calls it.
    ///
    /// Off by default: a host may under-supply deliberately. The missing set is
    /// available from `missing_bindings()` either way.
    pub strict_bindings: bool,
    /// Called for every vocabulary diagnostic a loaded fragment produces and for
    /// every diagnostic raised while finalizing a fragment's command buffer.
    pub on_fragment_diagnostic: Option<FragmentDiagnosticSink>,
    /// What `load_mod` does when a mod's entry cannot run. Defaults to
    /// [`EntryErrorPolicy::Throw`](crate::EntryErrorPolicy::Throw).
    pub entry_errors: crate::mod_load::EntryErrorPolicy,
    /// Receives every load-time [`ModDiagnostic`](crate::ModDiagnostic), under
    /// either entry error policy. The same findings land on
    /// `ModInstance::diagnostics`.
    pub on_mod_diagnostic: Option<crate::mod_load::ModDiagnosticSink>,
    /// Which engine the runtime is built on. [`RuntimeMode::Sync`], the
    /// default, settles an async host binding on the interpreter thread before
    /// script sees it; [`RuntimeMode::Async`] hands script a pending promise
    /// and lets other work on the runtime proceed while it waits.
    pub mode: RuntimeMode,
}

/// The engine a runtime is built on, and with it what `await` on an async
/// host binding means.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RuntimeMode {
    /// A synchronous QuickJS runtime. An async host binding is driven to
    /// completion on the interpreter thread (`pollster::block_on`) and script
    /// receives an already-settled promise: `await` never suspends, and a slow
    /// binding holds the interpreter for its full duration.
    #[default]
    Sync,
    /// An rquickjs `AsyncRuntime`. An async host binding returns a genuinely
    /// pending promise whose host future runs on the runtime's own executor;
    /// a script awaiting it yields, and other calls on the same runtime run in
    /// the meantime. Use the `*_async` methods to interleave calls; the plain
    /// methods still work and drive one call to completion on the calling
    /// thread.
    Async,
}

/// Receives a fragment diagnostic along with the id of the fragment that raised
/// it.
pub type FragmentDiagnosticSink =
    Arc<dyn Fn(&str, &crate::fragment::vocabulary::FragmentDiagnostic) + Send + Sync>;

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

/// The runtime's approved-library registry: the manifest's `libraries`
/// declarations, the sources the host registered, and the granted capability
/// set. Imports stay default-deny; an entry here, with its capability
/// satisfied, is the only thing that lifts the deny — and only while a mod
/// entry module is being linked (`load_phase`), so dynamic `import(...)`
/// after load gains nothing.
struct LibraryRegistry {
    declarations: HashMap<String, Option<String>>,
    sources: HashMap<String, String>,
    granted: HashSet<String>,
    load_phase: AtomicBool,
}

impl LibraryRegistry {
    fn approve(&self, mod_name: &str, specifier: &str) -> std::result::Result<(), XriptError> {
        let Some(capability) = self.declarations.get(specifier) else {
            return Err(XriptError::ImportDenied {
                mod_name: mod_name.to_string(),
                specifier: specifier.to_string(),
            });
        };
        if let Some(cap) = capability {
            if !crate::cap_match::granted_satisfies(&self.granted, cap) {
                return Err(XriptError::CapabilityDenied {
                    binding: specifier.to_string(),
                    capability: cap.clone(),
                });
            }
        }
        if !self.sources.contains_key(specifier) {
            return Err(XriptError::LibraryUnavailable {
                specifier: specifier.to_string(),
            });
        }
        Ok(())
    }

    fn importable(&self, specifier: &str) -> bool {
        self.load_phase.load(Ordering::Relaxed) && self.approve("", specifier).is_ok()
    }
}

/// A module resolver that satisfies only approved, registered,
/// capability-granted library specifiers, and only while a mod entry module
/// is being linked. Everything else — every other specifier, and every
/// request outside the load phase (i.e. dynamic `import(...)` at call time) —
/// is rejected. Combined with the pre-evaluation import scan, this is the
/// runtime-side defense-in-depth.
struct LibraryResolver {
    registry: Arc<LibraryRegistry>,
}

impl Resolver for LibraryResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        _base: &str,
        name: &str,
    ) -> std::result::Result<String, QjsError> {
        if self.registry.importable(name) {
            return Ok(name.to_string());
        }
        Err(QjsError::new_resolving_message(
            "<sandbox>",
            name.to_string(),
            format!(
                "import of \"{name}\" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)"
            ),
        ))
    }
}

struct LibraryLoader {
    registry: Arc<LibraryRegistry>,
}

impl Loader for LibraryLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
    ) -> std::result::Result<Module<'js, Declared>, QjsError> {
        if !self.registry.importable(name) {
            return Err(QjsError::new_loading_message(
                name,
                "xript mods cannot import external modules",
            ));
        }
        let source = self.registry.sources.get(name).cloned().unwrap_or_default();
        Module::declare(ctx.clone(), name, source)
    }
}

/// One live execution region's interrupt state. Frames stack, and the
/// tightest deadline across every live frame governs, so nesting can only
/// narrow an execution budget, never extend an outer region's.
#[derive(Clone)]
pub(crate) struct InterruptFrame {
    pub(crate) deadline: Instant,
    pub(crate) token: Option<CancellationToken>,
    /// The per-call token scoped to the thread when the frame was pushed.
    /// Populated by [`XriptRuntime::push_interrupt_frame`], never by hand.
    pub(crate) call_token: Option<crate::pending::CallToken>,
    pub(crate) debug_clock: Option<Arc<std::sync::atomic::AtomicU64>>,
    pub(crate) interrupted: Arc<AtomicBool>,
    pub(crate) cancelled: Arc<AtomicBool>,
}

/// Interrupt frames are keyed by the thread that pushed them. QuickJS calls
/// the interrupt handler on whichever thread is running bytecode, so a thread
/// must only ever observe its own frames: `XriptRuntime` is `Send + Sync`, and
/// a shared runtime executed from two threads would otherwise let one thread's
/// deadline govern (or its guard pop) the other's live region.
type InterruptFrames = Arc<std::sync::Mutex<HashMap<std::thread::ThreadId, Vec<InterruptFrame>>>>;

/// Recovers the frame map even if a prior holder panicked. The map carries no
/// invariant a panic could break, and treating poisoning as fatal would leave
/// the handler permanently disarmed for the rest of the runtime's life.
fn lock_frames(
    frames: &InterruptFrames,
) -> std::sync::MutexGuard<'_, HashMap<std::thread::ThreadId, Vec<InterruptFrame>>> {
    frames.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Pops the frame it pushed when dropped, including on unwind, so a panic
/// inside an execution region cannot leave an armed handler behind. The pop is
/// scoped to the pushing thread's own stack.
pub(crate) struct InterruptGuard {
    frames: InterruptFrames,
    thread: std::thread::ThreadId,
}

impl Drop for InterruptGuard {
    fn drop(&mut self) {
        let mut frames = lock_frames(&self.frames);
        if let Some(stack) = frames.get_mut(&self.thread) {
            stack.pop();
            if stack.is_empty() {
                frames.remove(&self.thread);
            }
        }
    }
}

/// Reads the shared mod table, recovering it if a prior holder panicked. The
/// table carries no invariant a panic could break, and a poisoned lock would
/// otherwise make every later slot and role read fail.
fn read_mods(mods: &SharedMods) -> std::sync::RwLockReadGuard<'_, Vec<crate::fragment::ModInstance>> {
    mods.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The fragment contributions filling `slot_id`, ordered by priority descending
/// then fragment id ascending, truncated to one unless the slot declares
/// `multiple`. Free-standing because it reads only the manifest and the mod
/// table, so it can run on any thread rather than on the runtime's.
pub fn resolve_slot_from(
    manifest: &Manifest,
    mods: &SharedMods,
    slot_id: &str,
) -> Vec<SlotContribution> {
    let multiple = manifest
        .slots
        .as_ref()
        .and_then(|slots| slots.iter().find(|s| s.id == slot_id))
        .and_then(|s| s.multiple)
        .unwrap_or(false);

    let mods = read_mods(mods);
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

/// Every loaded mod providing `role`, ordered by owning mod name ascending.
pub fn resolve_role_all_from(mods: &SharedMods, role: &str) -> Vec<RoleResolution> {
    let mods = read_mods(mods);
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
    out.sort_by(|a, b| a.addon.cmp(&b.addon));
    out
}

/// The winning provider for `role`: `role_preferences` when it names a loaded
/// candidate, otherwise the first of the deterministic ordering.
pub fn resolve_role_from(
    mods: &SharedMods,
    role_preferences: &HashMap<String, String>,
    role: &str,
) -> Option<RoleResolution> {
    let candidates = resolve_role_all_from(mods, role);
    if candidates.is_empty() {
        return None;
    }
    if let Some(preferred) = role_preferences.get(role)
        && let Some(hit) = candidates.iter().find(|c| &c.addon == preferred)
    {
        return Some(hit.clone());
    }
    candidates.into_iter().next()
}

/// The loaded-mod table, shared between a runtime and whoever spawned it.
///
/// An `RwLock` rather than a `Mutex`, and the write lock is taken only to push
/// a fully-built [`ModInstance`](crate::fragment::ModInstance) — never across a
/// mod's entry evaluation. The window a concurrent slot or role read can block
/// on is therefore a vector push, not a mod load, which is the whole point of
/// answering those reads off the runtime thread.
pub type SharedMods = Arc<std::sync::RwLock<Vec<crate::fragment::ModInstance>>>;

// The per-call cancellation token governing the calling thread, if any. A
// `CallToken` is scoped to one command rather than to the runtime, so it is
// carried on the thread that dispatches the command rather than threaded
// through every runtime method. Every interrupt frame pushed inside the scope
// picks it up, which covers execution, mod loading, exports, hooks and events
// alike.
thread_local! {
    static CURRENT_CALL_TOKEN: std::cell::RefCell<Option<crate::pending::CallToken>> =
        const { std::cell::RefCell::new(None) };
}

/// Restores the previously scoped call token when dropped, so nesting is safe.
pub struct CallTokenScope {
    previous: Option<crate::pending::CallToken>,
}

impl CallTokenScope {
    /// Scopes `token` to the calling thread for the guard's lifetime.
    pub fn enter(token: crate::pending::CallToken) -> Self {
        let previous =
            CURRENT_CALL_TOKEN.with(|slot| slot.borrow_mut().replace(token));
        Self { previous }
    }
}

impl Drop for CallTokenScope {
    fn drop(&mut self) {
        let previous = self.previous.take();
        CURRENT_CALL_TOKEN.with(|slot| *slot.borrow_mut() = previous);
    }
}

pub(crate) fn current_call_token() -> Option<crate::pending::CallToken> {
    CURRENT_CALL_TOKEN.with(|slot| slot.borrow().clone())
}

/// True when the calling thread's scoped call token has been tripped.
pub(crate) fn call_cancelled() -> bool {
    current_call_token()
        .map(|token| token.is_cancelled())
        .unwrap_or(false)
}

/// One handler's result, tagged with who registered it.
///
/// `index` is the handler's position within its own mod's handlers for that
/// hook or event. Together with the mod's pool-wide load sequence this is what
/// lets segments returned by several workers be merged back into the order a
/// single runtime would have produced.
#[derive(Debug, Clone, PartialEq)]
pub struct TaggedResult {
    pub mod_id: String,
    pub index: u32,
    pub value: serde_json::Value,
}

/// The hook and event ids one mod's handlers answer to.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct HandlerIndex {
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
}

/// Per-runtime instrumentation a supervisor can read from another thread
/// without touching the interpreter.
///
/// The two fields answer the only question that distinguishes a slow call from
/// a wedged one. `heartbeat` is bumped by the interrupt handler, which QuickJS
/// calls **only while bytecode runs** — a script grinding for a minute advances
/// it, a thread parked inside a blocking host binding does not. `binding` names
/// what that thread is inside, if anything, so a stalled heartbeat can be
/// reported with the culprit rather than as a mystery.
///
/// Neither field changes call semantics and neither takes a lock on the hot
/// path: one relaxed increment per interrupt tick, one relaxed swap on binding
/// entry and one on exit.
pub struct RuntimeProbe {
    heartbeat: std::sync::atomic::AtomicU64,
    current: std::sync::atomic::AtomicUsize,
    names: std::sync::RwLock<Vec<String>>,
    yielding: AtomicBool,
}

const NO_BINDING: usize = usize::MAX;

impl Default for RuntimeProbe {
    fn default() -> Self {
        Self {
            heartbeat: std::sync::atomic::AtomicU64::new(0),
            current: std::sync::atomic::AtomicUsize::new(NO_BINDING),
            names: std::sync::RwLock::new(Vec::new()),
            yielding: AtomicBool::new(false),
        }
    }
}

impl RuntimeProbe {
    /// True when the runtime was built in [`RuntimeMode::Async`]. There, a
    /// call awaiting an async host binding parks without running bytecode or
    /// occupying the thread, so a stalled heartbeat means a wedge only while
    /// [`current_binding`](Self::current_binding) names a sync binding the
    /// thread is actually inside.
    pub fn yielding(&self) -> bool {
        self.yielding.load(Ordering::Relaxed)
    }

    /// Monotonic tick count. Advances only while the interpreter is running
    /// bytecode.
    pub fn heartbeat(&self) -> u64 {
        self.heartbeat.load(Ordering::Relaxed)
    }

    /// The host binding the runtime thread is inside right now, if any.
    pub fn current_binding(&self) -> Option<String> {
        let index = self.current.load(Ordering::Relaxed);
        if index == NO_BINDING {
            return None;
        }
        self.names
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(index)
            .cloned()
    }

    /// Interns a binding name at registration and returns its index.
    fn intern(&self, name: &str) -> usize {
        let mut names = self.names.write().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = names.iter().position(|n| n == name) {
            return existing;
        }
        names.push(name.to_string());
        names.len() - 1
    }
}

/// Marks a binding entered for the guard's lifetime, restoring whatever was
/// current before. Nesting (a binding whose callback re-enters script that
/// calls a second binding) restores rather than clears.
struct BindingScope {
    probe: Arc<RuntimeProbe>,
    previous: usize,
}

impl BindingScope {
    fn enter(probe: &Arc<RuntimeProbe>, index: usize) -> Self {
        let previous = probe.current.swap(index, Ordering::Relaxed);
        Self {
            probe: probe.clone(),
            previous,
        }
    }
}

impl Drop for BindingScope {
    fn drop(&mut self) {
        self.probe.current.store(self.previous, Ordering::Relaxed);
    }
}

/// The QuickJS runtime and context behind a sandbox, in whichever mode it was
/// built. Each owns the interrupt handler installed on it for the lifetime of
/// the sandbox.
enum Engine {
    Sync {
        #[allow(dead_code)]
        rt: Runtime,
        ctx: Context,
    },
    Async {
        rt: AsyncRuntime,
        ctx: AsyncContext,
    },
}

impl Engine {
    /// Runs `f` against the context. On an async engine this takes the
    /// runtime lock and holds it for `f` alone, driven on the calling thread.
    fn with<R>(&self, f: impl for<'js> FnOnce(Ctx<'js>) -> R) -> R {
        match self {
            Engine::Sync { ctx, .. } => ctx.with(f),
            Engine::Async { ctx, .. } => {
                let f = crate::yielding::AssertSend(f);
                pollster::block_on(ctx.with(move |ctx| {
                    let f = f;
                    crate::yielding::AssertSend(f.into_inner()(ctx))
                }))
                .into_inner()
            }
        }
    }

    fn set_interrupt_handler(&self, handler: Box<dyn FnMut() -> bool + Send>) {
        match self {
            Engine::Sync { rt, .. } => rt.set_interrupt_handler(Some(handler)),
            Engine::Async { rt, .. } => pollster::block_on(rt.set_interrupt_handler(Some(handler))),
        }
    }
}

/// An engine's runtime before its context exists, so limits and the module
/// loader can be configured the same way in either mode.
enum EngineRt {
    Sync(Runtime),
    Async(AsyncRuntime),
}

impl EngineRt {
    fn new(mode: RuntimeMode) -> Result<Self> {
        Ok(match mode {
            RuntimeMode::Sync => EngineRt::Sync(Runtime::new().map_err(|e| XriptError::Engine(e.to_string()))?),
            RuntimeMode::Async => {
                EngineRt::Async(AsyncRuntime::new().map_err(|e| XriptError::Engine(e.to_string()))?)
            }
        })
    }

    fn set_loader<R, L>(&self, resolver: R, loader: L)
    where
        R: Resolver + Send + 'static,
        L: Loader + Send + 'static,
    {
        match self {
            EngineRt::Sync(rt) => rt.set_loader(resolver, loader),
            EngineRt::Async(rt) => pollster::block_on(rt.set_loader(resolver, loader)),
        }
    }

    fn set_memory_limit(&self, limit: usize) {
        match self {
            EngineRt::Sync(rt) => rt.set_memory_limit(limit),
            EngineRt::Async(rt) => pollster::block_on(rt.set_memory_limit(limit)),
        }
    }

    fn set_max_stack_size(&self, limit: usize) {
        match self {
            EngineRt::Sync(rt) => rt.set_max_stack_size(limit),
            EngineRt::Async(rt) => pollster::block_on(rt.set_max_stack_size(limit)),
        }
    }

    fn into_engine(self) -> Result<Engine> {
        Ok(match self {
            EngineRt::Sync(rt) => {
                let ctx = Context::full(&rt).map_err(|e| XriptError::Engine(e.to_string()))?;
                Engine::Sync { rt, ctx }
            }
            EngineRt::Async(rt) => {
                let ctx = pollster::block_on(AsyncContext::full(&rt))
                    .map_err(|e| XriptError::Engine(e.to_string()))?;
                Engine::Async { rt, ctx }
            }
        })
    }
}

pub struct XriptRuntime {
    engine: Engine,
    mode: RuntimeMode,
    manifest: Arc<Manifest>,
    interrupt_frames: InterruptFrames,
    cancellation: Option<CancellationToken>,
    effective_timeout_ms: u64,
    /// The embedder's ceiling, kept so a per-slot override can be clamped to it
    /// rather than trusted. Without it a manifest could widen past the host.
    hard_timeout_ms: Option<u64>,
    missing_bindings: Vec<String>,
    loaded_mods: SharedMods,
    export_caps: std::sync::Mutex<HashMap<String, HashMap<String, Option<String>>>>,
    export_owners: std::sync::Mutex<HashMap<String, Vec<String>>>,
    granted: HashSet<String>,
    role_preferences: HashMap<String, String>,
    command_preferences: HashMap<String, String>,
    library_registry: Arc<LibraryRegistry>,
    hook_fills: std::sync::Mutex<Vec<crate::fragment::HookFillDecl>>,
    command_fills: std::sync::Mutex<Vec<crate::commands::CommandFill>>,
    audit: Option<AuditSink>,
    reported_hook_fill_denials: std::sync::Mutex<HashSet<(String, String, String)>>,
    debug: Option<crate::debug::DebugSession>,
    strict_html_vocabulary: bool,
    on_fragment_diagnostic: Option<FragmentDiagnosticSink>,
    entry_errors: crate::mod_load::EntryErrorPolicy,
    on_mod_diagnostic: Option<crate::mod_load::ModDiagnosticSink>,
    probe: Arc<RuntimeProbe>,
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
        Self::with_shared(
            Arc::new(manifest),
            Arc::new(std::sync::RwLock::new(Vec::new())),
            options,
        )
    }

    /// Builds a runtime over manifest and loaded-mod state the caller already
    /// holds. [`XriptHandle`](crate::handle::XriptHandle) uses this so it can
    /// answer manifest and slot/role reads on the caller's own thread instead
    /// of queueing them behind whatever the runtime thread is doing.
    pub fn with_shared(
        manifest: Arc<Manifest>,
        loaded_mods: SharedMods,
        options: RuntimeOptions,
    ) -> Result<Self> {
        Self::with_shared_probe(
            manifest,
            loaded_mods,
            Arc::new(RuntimeProbe::default()),
            options,
        )
    }

    /// [`with_shared`](Self::with_shared) over a probe the caller already
    /// holds, so a supervisor can read the heartbeat and the current binding
    /// even while the runtime thread is wedged and even before construction
    /// finishes.
    pub fn with_shared_probe(
        manifest: Arc<Manifest>,
        loaded_mods: SharedMods,
        probe: Arc<RuntimeProbe>,
        options: RuntimeOptions,
    ) -> Result<Self> {
        crate::manifest::validate_structure(&manifest)?;

        let mode = options.mode;
        probe.yielding.store(mode == RuntimeMode::Async, Ordering::Relaxed);
        let rt = EngineRt::new(mode)?;

        for (specifier, source) in &options.libraries {
            if manifest
                .libraries
                .as_ref()
                .and_then(|libs| libs.get(specifier))
                .is_none()
            {
                return Err(XriptError::LibraryRegistration {
                    specifier: specifier.clone(),
                    reason: "not declared in the host manifest's libraries map".to_string(),
                });
            }
            if let Some(artifact) = crate::module::detect_commonjs(source) {
                return Err(XriptError::LibraryRegistration {
                    specifier: specifier.clone(),
                    reason: format!(
                        "CommonJS artifacts detected (found: {artifact}); libraries must be pre-bundled ES modules"
                    ),
                });
            }
            if let Some(nested) = crate::module::first_import_specifier(source) {
                return Err(XriptError::LibraryRegistration {
                    specifier: specifier.clone(),
                    reason: format!(
                        "not import-clean: contains an import of \"{nested}\"; libraries must be self-contained pre-bundled ES modules with no imports of their own"
                    ),
                });
            }
        }

        let library_registry = Arc::new(LibraryRegistry {
            declarations: manifest
                .libraries
                .as_ref()
                .map(|libs| {
                    libs.iter()
                        .map(|(specifier, def)| (specifier.clone(), def.capability.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            sources: options.libraries,
            granted: options.capabilities.iter().cloned().collect(),
            load_phase: AtomicBool::new(false),
        });
        rt.set_loader(
            LibraryResolver {
                registry: library_registry.clone(),
            },
            LibraryLoader {
                registry: library_registry.clone(),
            },
        );

        let missing_bindings = missing_binding_names(&manifest, &options.host_bindings);
        if options.strict_bindings && !missing_bindings.is_empty() {
            return Err(XriptError::MissingBindings {
                missing: missing_bindings.clone(),
            });
        }

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
            effective_limit(manifest_timeout, hard.timeout_ms).unwrap_or(crate::manifest::DEFAULT_TIMEOUT_MS);

        let engine = rt.into_engine()?;

        let granted: HashSet<String> = options.capabilities.into_iter().collect();
        let audit = options.audit.clone();
        let cancellation = options.cancellation.clone();
        let role_preferences = options.role_preferences;
        let command_preferences = options.command_preferences;
        let strict_html_vocabulary = options.strict_html_vocabulary;
        let on_fragment_diagnostic = options.on_fragment_diagnostic.clone();
        let entry_errors = options.entry_errors;
        let on_mod_diagnostic = options.on_mod_diagnostic.clone();

        let debug = options
            .debug
            .map(crate::debug::DebugSession::new);



        engine.with(|ctx| -> Result<()> {
            remove_dangerous_globals(&ctx)?;
            register_console(&ctx, options.console)?;
            register_bindings(&ctx, &manifest, options.host_bindings, &granted, &audit, &probe)?;
            register_hooks(&ctx, &manifest, &granted)?;
            register_events(&ctx, &manifest, &granted)?;
            register_fragment_hooks(&ctx)?;
            register_exports_surface(&ctx)?;
            if let Some(ref session) = debug {
                crate::debug::register_debug_probe(&ctx, session)?;
            }
            Ok(())
        })?;

        let interrupt_frames: InterruptFrames = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let handler_frames = interrupt_frames.clone();
        let handler_probe = probe.clone();
        engine.set_interrupt_handler(Box::new(move || {
            // Bumped before any early return: the tick is the signal that
            // bytecode is running at all, which is what tells a slow call
            // apart from a wedged one.
            handler_probe
                .heartbeat
                .fetch_add(1, Ordering::Relaxed);
            let frames = lock_frames(&handler_frames);
            let Some(stack) = frames.get(&std::thread::current().id()) else {
                return false;
            };
            if stack.is_empty() {
                return false;
            }
            if stack.iter().any(|f| {
                f.token.as_ref().map(|t| t.is_cancelled()).unwrap_or(false)
                    || f.call_token
                        .as_ref()
                        .map(|t| t.is_cancelled())
                        .unwrap_or(false)
            }) {
                for frame in stack.iter() {
                    frame.cancelled.store(true, Ordering::Relaxed);
                }
                return true;
            }
            let now = Instant::now();
            let expired = stack.iter().any(|frame| {
                let paused = frame
                    .debug_clock
                    .as_ref()
                    .map(|c| Duration::from_millis(c.load(Ordering::Relaxed)))
                    .unwrap_or_default();
                now >= frame.deadline + paused
            });
            if expired {
                for frame in stack.iter() {
                    frame.interrupted.store(true, Ordering::Relaxed);
                }
                true
            } else {
                false
            }
        }) as Box<dyn FnMut() -> bool + Send>);

        Ok(Self {
            engine,
            mode,
            manifest,
            interrupt_frames,
            cancellation,
            effective_timeout_ms,
            hard_timeout_ms: hard.timeout_ms,
            missing_bindings,
            loaded_mods,
            export_caps: std::sync::Mutex::new(HashMap::new()),
            export_owners: std::sync::Mutex::new(HashMap::new()),
            granted,
            role_preferences,
            command_preferences,
            library_registry,
            hook_fills: std::sync::Mutex::new(Vec::new()),
            command_fills: std::sync::Mutex::new(Vec::new()),
            audit,
            reported_hook_fill_denials: std::sync::Mutex::new(HashSet::new()),
            debug,
            strict_html_vocabulary,
            on_fragment_diagnostic,
            entry_errors,
            on_mod_diagnostic,
            probe,
        })
    }

    /// Pushes an interrupt frame onto the calling thread's stack and returns a
    /// guard that pops it on drop. Nesting is safe at any depth: an outer
    /// region stays armed for the remainder of its execution regardless of how
    /// many inner regions come and go. Frames are per-thread, so a shared
    /// runtime driven from several threads keeps each thread's deadline and
    /// cancellation to itself.
    pub(crate) fn push_interrupt_frame(&self, mut frame: InterruptFrame) -> InterruptGuard {
        let thread = std::thread::current().id();
        if frame.call_token.is_none() {
            frame.call_token = current_call_token();
        }
        lock_frames(&self.interrupt_frames)
            .entry(thread)
            .or_default()
            .push(frame);
        InterruptGuard {
            frames: self.interrupt_frames.clone(),
            thread,
        }
    }

    /// Live frame count for the calling thread.
    #[allow(dead_code)]
    pub(crate) fn interrupt_depth(&self) -> usize {
        lock_frames(&self.interrupt_frames)
            .get(&std::thread::current().id())
            .map(|stack| stack.len())
            .unwrap_or(0)
    }

    /// True when a live frame governs execution on the calling thread, i.e.
    /// the installed handler would enforce a deadline or observe cancellation
    /// right now.
    #[allow(dead_code)]
    pub(crate) fn interrupt_armed(&self) -> bool {
        self.interrupt_depth() > 0
    }

    pub fn execute(&self, code: &str) -> Result<ExecutionResult> {
        self.execute_within(code, None)
    }

    /// `execute`, with an optional per-call timeout standing in for the
    /// manifest-wide one. A slot's `limits.timeout_ms` arrives here. The
    /// embedder's hard ceiling still clamps it, so a manifest cannot buy
    /// itself more budget than the host allowed.
    pub fn execute_within(
        &self,
        code: &str,
        timeout_override_ms: Option<u64>,
    ) -> Result<ExecutionResult> {
        match self.mode {
            RuntimeMode::Sync => self.execute_within_blocking(code, timeout_override_ms),
            RuntimeMode::Async => pollster::block_on(self.execute_within_yielding(code, timeout_override_ms)),
        }
    }

    /// The engine mode this runtime was built in.
    pub fn mode(&self) -> RuntimeMode {
        self.mode
    }

    /// [`execute`](Self::execute) as a future. On an async-mode runtime a
    /// script awaiting an async host binding suspends here, releasing the
    /// runtime so other calls on it proceed until the binding's future
    /// completes. The manifest's `timeout_ms` bounds the whole call, time spent
    /// awaiting included. On a sync-mode runtime the call runs to completion on
    /// first poll, exactly as `execute` does.
    pub async fn execute_async(&self, code: &str) -> Result<ExecutionResult> {
        self.execute_within_async(code, None).await
    }

    /// [`execute_within`](Self::execute_within) as a future; see
    /// [`execute_async`](Self::execute_async).
    pub async fn execute_within_async(
        &self,
        code: &str,
        timeout_override_ms: Option<u64>,
    ) -> Result<ExecutionResult> {
        match self.mode {
            RuntimeMode::Sync => self.execute_within_blocking(code, timeout_override_ms),
            RuntimeMode::Async => self.execute_within_yielding(code, timeout_override_ms).await,
        }
    }

    /// Runs every pending job and spawned host future on an async-mode
    /// runtime until none remain, settling work a script started without
    /// awaiting it. Returns immediately on a sync-mode runtime.
    pub async fn idle(&self) {
        if let Engine::Async { rt, .. } = &self.engine {
            rt.idle().await;
        }
    }

    fn timeout_for(&self, timeout_override_ms: Option<u64>) -> u64 {
        match timeout_override_ms {
            Some(requested) => effective_limit(Some(requested), self.hard_timeout_ms)
                .unwrap_or(self.effective_timeout_ms),
            None => self.effective_timeout_ms,
        }
    }

    fn call_frame(&self, timeout_ms: u64, debug: bool) -> InterruptFrame {
        InterruptFrame {
            deadline: Instant::now() + Duration::from_millis(timeout_ms),
            token: self.cancellation.clone(),
            call_token: None,
            debug_clock: if debug {
                self.debug.as_ref().map(|d| d.paused_clock())
            } else {
                None
            },
            interrupted: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn execute_within_yielding(
        &self,
        code: &str,
        timeout_override_ms: Option<u64>,
    ) -> Result<ExecutionResult> {
        if self.cancellation.as_ref().is_some_and(|t| t.is_cancelled()) || call_cancelled() {
            return Err(XriptError::Cancelled);
        }
        let Engine::Async { ctx, .. } = &self.engine else {
            unreachable!("yielding execution requires an async engine");
        };
        let start = Instant::now();
        let frame = self.call_frame(self.timeout_for(timeout_override_ms), true);
        let watch = crate::yielding::Watch::new(&frame);
        let interrupted = frame.interrupted.clone();
        let cancelled = frame.cancelled.clone();
        let code = code.to_string();
        let body_watch = watch.clone();

        let call = rquickjs::async_with!(ctx => |ctx| {
            let settled = match ctx.eval::<Value, _>(code.as_str()) {
                Ok(val) => match Promise::from_value(val.clone()) {
                    Ok(promise) => {
                        match crate::yielding::Abortable::new(promise.into_future::<Value>(), body_watch).await {
                            Ok(Ok(v)) => Ok(js_value_to_json(&ctx, &v)),
                            Ok(Err(_)) => Err(None),
                            Err(limit) => Err(Some(limit)),
                        }
                    }
                    Err(_) => Ok(js_value_to_json(&ctx, &val)),
                },
                Err(_) => Err(None),
            };
            match settled {
                Ok(value) => Ok(value),
                Err(Some(limit)) => Err(limit),
                Err(None) => {
                    if cancelled.load(Ordering::Relaxed) {
                        Err(XriptError::Cancelled)
                    } else if interrupted.load(Ordering::Relaxed) {
                        Err(XriptError::ExecutionLimit { limit: "timeout_ms".into() })
                    } else {
                        let caught = ctx.catch();
                        Err(XriptError::Script(format_rejection(&ctx, &caught)))
                    }
                }
            }
        });

        let value = crate::yielding::Governed::new(self, frame, watch, call).await?;
        Ok(ExecutionResult {
            value,
            duration_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }

    fn execute_within_blocking(
        &self,
        code: &str,
        timeout_override_ms: Option<u64>,
    ) -> Result<ExecutionResult> {
        if let Some(ref token) = self.cancellation
            && token.is_cancelled()
        {
            return Err(XriptError::Cancelled);
        }
        if call_cancelled() {
            return Err(XriptError::Cancelled);
        }

        let timeout_ms = match timeout_override_ms {
            Some(requested) => effective_limit(Some(requested), self.hard_timeout_ms)
                .unwrap_or(self.effective_timeout_ms),
            None => self.effective_timeout_ms,
        };

        let interrupted = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let start = Instant::now();

        let _interrupt = self.push_interrupt_frame(InterruptFrame {
            deadline: start + Duration::from_millis(timeout_ms),
            token: self.cancellation.clone(),
            call_token: None,
            debug_clock: self.debug.as_ref().map(|d| d.paused_clock()),
            interrupted: interrupted.clone(),
            cancelled: cancelled.clone(),
        });

        let result = self.engine.with(|ctx| {
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
                        PromiseOutcome::Pending => {
                            if cancelled.load(Ordering::Relaxed) {
                                Err(XriptError::Cancelled)
                            } else if interrupted.load(Ordering::Relaxed) {
                                Err(XriptError::ExecutionLimit {
                                    limit: "timeout_ms".into(),
                                })
                            } else {
                                Err(XriptError::Script(
                                    "workflow promise never settled: it awaited something that never resolves, and no pending jobs remain. A host binding declared `async` does not yield, so awaiting one cannot be what is outstanding here.".into(),
                                ))
                            }
                        }
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

        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

        result.map(|value| ExecutionResult { value, duration_ms })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Bindings the manifest declares that the host did not supply, fully
    /// qualified and sorted. Each installs as a stub that throws when called,
    /// so this is the drift between the contract a mod author reads and the
    /// surface the host actually wired.
    pub fn missing_bindings(&self) -> &[String] {
        &self.missing_bindings
    }

    /// The manifest as a shared handle, for a caller that wants to read it
    /// without holding a borrow on the runtime.
    pub fn manifest_arc(&self) -> Arc<Manifest> {
        self.manifest.clone()
    }

    /// The loaded-mod table this runtime writes into. Reading it requires no
    /// access to the JS context, so a host may resolve slots and roles from
    /// another thread while the runtime is busy.
    pub fn loaded_mods(&self) -> SharedMods {
        self.loaded_mods.clone()
    }

    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Result<crate::fragment::ModInstance> {
        pollster::block_on(self.load_mod_async(
            mod_manifest_json,
            fragment_sources,
            granted_capabilities,
            entry_source,
        ))
    }

    /// [`load_mod`](Self::load_mod) as a future. On an async-mode runtime a
    /// module entry whose top-level `await` waits on an async host binding
    /// yields while it waits.
    pub async fn load_mod_async(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Result<crate::fragment::ModInstance> {
        let normalized = crate::fragment::normalize_mod_fills(
            mod_manifest_json,
            self.manifest.slots.as_deref().unwrap_or(&[]),
            &self.granted,
        )?;
        let mod_manifest_json = normalized.manifest_json.as_str();

        let mut mod_instance = crate::fragment::load_mod_with_options(
            mod_manifest_json,
            &self.manifest,
            granted_capabilities,
            &fragment_sources,
            self.strict_html_vocabulary,
        )?;

        if let Some(ref sink) = self.on_fragment_diagnostic {
            for fragment in &mod_instance.fragments {
                for diagnostic in &fragment.diagnostics {
                    sink(&fragment.id, diagnostic);
                }
            }
        }
        for diagnostic in &mod_instance.diagnostics {
            crate::mod_load::send(self.on_mod_diagnostic.as_ref(), diagnostic);
        }

        let mod_manifest: crate::manifest::ModManifest =
            serde_json::from_str(mod_manifest_json).map_err(XriptError::Json)?;
        let entry = mod_manifest.entry_block();
        let owning_mod = mod_instance.name.clone();
        if let Some(ref entry) = entry {
            let mut caps = self.export_caps.lock().unwrap();
            let mut owners = self.export_owners.lock().unwrap();
            let own = caps.entry(owning_mod.clone()).or_default();
            for (export_name, decl) in &entry.exports {
                own.insert(export_name.clone(), decl.capability.clone());
                let declared = owners.entry(export_name.clone()).or_default();
                if !declared.contains(&owning_mod) {
                    declared.push(owning_mod.clone());
                }
            }
        }

        let is_module = entry
            .as_ref()
            .map(|e| e.format == "module")
            .unwrap_or(false);

        let mod_name = mod_instance.name.clone();
        let (scripts, mut failure) =
            self.resolve_entry_sources(&mut mod_instance, &mod_manifest, entry_source, &fragment_sources);

        if failure.is_none() {
            for (script, source) in &scripts {
                match self.run_entry_script(&mod_name, source, is_module).await {
                    Ok(()) => {}
                    Err(XriptError::Cancelled) => return Err(XriptError::Cancelled),
                    Err(error) => {
                        self.record_mod_diagnostic(
                            &mut mod_instance,
                            crate::mod_load::ModDiagnostic {
                                code: crate::mod_load::ModDiagnosticCode::EntryFailed,
                                severity: crate::mod_load::ModDiagnosticSeverity::Error,
                                mod_name: mod_name.clone(),
                                message: error.to_string(),
                                script: Some(script.clone()),
                                fragment_id: None,
                                field: None,
                            },
                        );
                        failure = Some(error);
                        break;
                    }
                }
            }
        }

        if let Some(error) = failure
            && self.entry_errors == crate::mod_load::EntryErrorPolicy::Throw
        {
            return Err(error);
        }

        self.hook_fills.lock().unwrap().extend(normalized.hook_fills);
        self.command_fills
            .lock()
            .unwrap()
            .extend(normalized.command_fills);
        // Write-locked for the push alone; the entry evaluation above is long
        // and already done, so a concurrent slot read waits on a vector push.
        self.loaded_mods
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(mod_instance.clone());

        Ok(mod_instance)
    }

    fn record_mod_diagnostic(
        &self,
        mod_instance: &mut crate::fragment::ModInstance,
        diagnostic: crate::mod_load::ModDiagnostic,
    ) {
        crate::mod_load::send(self.on_mod_diagnostic.as_ref(), &diagnostic);
        mod_instance.diagnostics.push(diagnostic);
    }

    /// Pairs each entry script with its source. An explicit `entry_source`
    /// stands for the whole entry; without one, every script the entry names is
    /// looked up in `fragment_sources`, and all of them are checked before any
    /// runs, so a mod never half-runs because a later script is missing.
    fn resolve_entry_sources(
        &self,
        mod_instance: &mut crate::fragment::ModInstance,
        mod_manifest: &crate::manifest::ModManifest,
        entry_source: Option<&str>,
        fragment_sources: &HashMap<String, String>,
    ) -> (Vec<(String, String)>, Option<XriptError>) {
        let scripts = mod_manifest.entry_scripts();
        if let Some(source) = entry_source {
            let script = scripts.into_iter().next().unwrap_or_else(|| "entry".to_string());
            return (vec![(script, source.to_string())], None);
        }

        let mut resolved = Vec::new();
        let mut first_missing = None;
        for script in scripts {
            match fragment_sources.get(&script) {
                Some(source) => resolved.push((script, source.clone())),
                None => {
                    let error = XriptError::MissingEntryScript {
                        mod_name: mod_instance.name.clone(),
                        script: script.clone(),
                    };
                    self.record_mod_diagnostic(
                        mod_instance,
                        crate::mod_load::ModDiagnostic {
                            code: crate::mod_load::ModDiagnosticCode::MissingEntryScript,
                            severity: crate::mod_load::ModDiagnosticSeverity::Error,
                            mod_name: mod_instance.name.clone(),
                            message: error.to_string(),
                            script: Some(script),
                            fragment_id: None,
                            field: None,
                        },
                    );
                    first_missing.get_or_insert(error);
                }
            }
        }
        (resolved, first_missing)
    }

    async fn run_entry_script(&self, mod_name: &str, source: &str, is_module: bool) -> Result<()> {
        crate::module::check_entry_source_with(mod_name, source, is_module, |specifier| {
            self.library_registry.approve(mod_name, specifier)
        })?;

        self.set_export_owner(Some(mod_name));
        let evaluated = if is_module {
            self.eval_module_entry(mod_name, source).await
        } else {
            self.eval_script_entry(mod_name, source)
        };
        self.set_export_owner(None);
        evaluated
    }

    /// Evaluates a classic-script entry under the same deadline and
    /// cancellation as any other execution, so an entry that never ends is an
    /// [`XriptError::ExecutionLimit`] rather than a load that never returns.
    fn eval_script_entry(&self, mod_name: &str, source: &str) -> Result<()> {
        if let Some(ref token) = self.cancellation
            && token.is_cancelled()
        {
            return Err(XriptError::Cancelled);
        }
        let interrupted = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let _interrupt = self.push_interrupt_frame(InterruptFrame {
            deadline: Instant::now() + Duration::from_millis(self.effective_timeout_ms),
            token: self.cancellation.clone(),
            call_token: None,
            debug_clock: None,
            interrupted: interrupted.clone(),
            cancelled: cancelled.clone(),
        });

        self.engine.with(|ctx| {
            let res: std::result::Result<Value, _> = ctx.eval(source);
            if res.is_ok() {
                return Ok(());
            }
            if cancelled.load(Ordering::Relaxed) {
                return Err(XriptError::Cancelled);
            }
            if interrupted.load(Ordering::Relaxed) {
                return Err(XriptError::ExecutionLimit {
                    limit: "timeout_ms".into(),
                });
            }
            let caught = ctx.catch();
            Err(XriptError::ModEntry {
                mod_name: mod_name.to_string(),
                message: format_rejection(&ctx, &caught),
            })
        })
    }

    async fn eval_module_entry(&self, mod_name: &str, source: &str) -> Result<()> {
        match self.mode {
            RuntimeMode::Sync => self.eval_module_entry_blocking(mod_name, source),
            RuntimeMode::Async => {
                self.library_registry.load_phase.store(true, Ordering::Relaxed);
                let result = self.eval_module_entry_yielding(mod_name, source).await;
                self.library_registry.load_phase.store(false, Ordering::Relaxed);
                result
            }
        }
    }

    async fn eval_module_entry_yielding(&self, mod_name: &str, source: &str) -> Result<()> {
        let Engine::Async { ctx, .. } = &self.engine else {
            unreachable!("yielding evaluation requires an async engine");
        };
        let frame = self.call_frame(self.effective_timeout_ms, false);
        let watch = crate::yielding::Watch::new(&frame);
        let interrupted = frame.interrupted.clone();
        let cancelled = frame.cancelled.clone();
        let mod_name = mod_name.to_string();
        let source = source.to_string();
        let body_watch = watch.clone();

        let call = rquickjs::async_with!(ctx => |ctx| {
            let declared = match Module::declare(ctx.clone(), "xript:mod-entry", source) {
                Ok(m) => m,
                Err(_) => return Err(module_eval_error(&ctx, &mod_name, &cancelled, &interrupted)),
            };
            let (evaluated, promise) = match declared.eval() {
                Ok(pair) => pair,
                Err(_) => return Err(module_eval_error(&ctx, &mod_name, &cancelled, &interrupted)),
            };
            match crate::yielding::Abortable::new(promise.into_future::<Value>(), body_watch).await {
                Ok(Ok(_)) => harvest_named_exports(&ctx, &evaluated),
                Ok(Err(_)) => Err(module_eval_error(&ctx, &mod_name, &cancelled, &interrupted)),
                Err(limit) => Err(limit),
            }
        });

        crate::yielding::Governed::new(self, frame, watch, call).await
    }

    fn eval_module_entry_blocking(&self, mod_name: &str, source: &str) -> Result<()> {
        let timeout_ms = self.effective_timeout_ms;
        let interrupted = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let start = Instant::now();

        let _interrupt = self.push_interrupt_frame(InterruptFrame {
            deadline: start + Duration::from_millis(timeout_ms),
            token: self.cancellation.clone(),
            call_token: None,
            debug_clock: None,
            interrupted: interrupted.clone(),
            cancelled: cancelled.clone(),
        });

        self.library_registry.load_phase.store(true, Ordering::Relaxed);
        let result = self.engine.with(|ctx| -> Result<()> {
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
        self.library_registry.load_phase.store(false, Ordering::Relaxed);

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
        let owner = self.declared_owner(name)?;
        self.invoke_export_in(name, args, owner.as_deref(), None)
    }

    /// Invokes an export inside one named mod's own namespace. Gated by that
    /// mod's own declaration, so a second mod declaring the same name can
    /// neither weaken the gate nor shadow the function.
    pub fn invoke_mod_export(
        &self,
        mod_name: &str,
        name: &str,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        self.invoke_export_in(name, args, Some(mod_name), None)
    }

    /// `invoke_mod_export`, bounded by a slot's own `limits.timeout_ms` instead
    /// of the manifest-wide budget. `None` keeps the manifest budget.
    pub fn invoke_mod_export_within(
        &self,
        mod_name: &str,
        name: &str,
        args: &[serde_json::Value],
        timeout_override_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        self.invoke_export_in(name, args, Some(mod_name), timeout_override_ms)
    }

    /// [`invoke_export`](Self::invoke_export) as a future. On an async-mode
    /// runtime an export that returns a promise is awaited, yielding while it
    /// waits on async host bindings, and its settled value is returned.
    pub async fn invoke_export_async(
        &self,
        name: &str,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        let owner = self.declared_owner(name)?;
        self.invoke_export_in_async(name, args, owner.as_deref(), None).await
    }

    /// [`invoke_mod_export`](Self::invoke_mod_export) as a future; see
    /// [`invoke_export_async`](Self::invoke_export_async).
    pub async fn invoke_mod_export_async(
        &self,
        mod_name: &str,
        name: &str,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        self.invoke_export_in_async(name, args, Some(mod_name), None).await
    }

    /// [`invoke_mod_export_within`](Self::invoke_mod_export_within) as a
    /// future; see [`invoke_export_async`](Self::invoke_export_async).
    pub async fn invoke_mod_export_within_async(
        &self,
        mod_name: &str,
        name: &str,
        args: &[serde_json::Value],
        timeout_override_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        self.invoke_export_in_async(name, args, Some(mod_name), timeout_override_ms)
            .await
    }

    fn declared_owner(&self, name: &str) -> Result<Option<String>> {
        let owners = self.export_owners.lock().unwrap();
        match owners.get(name) {
            Some(mods) if mods.len() > 1 => Err(XriptError::AmbiguousExport {
                export: name.to_string(),
                mods: mods.clone(),
            }),
            Some(mods) if mods.len() == 1 => Ok(Some(mods[0].clone())),
            _ => Ok(None),
        }
    }

    /// The capability an export declares when the granted set does not satisfy
    /// it, otherwise `None`.
    fn denied_capability(&self, owner: &str, name: &str) -> Option<String> {
        let caps = self.export_caps.lock().unwrap();
        let cap = caps.get(owner).and_then(|own| own.get(name))?.as_ref()?;
        if crate::cap_match::granted_satisfies(&self.granted, cap) {
            None
        } else {
            Some(cap.clone())
        }
    }

    /// Reports a hook fill refused on capability grounds to the audit sink,
    /// once per `(mod, handler, hook)` for the lifetime of the runtime so a
    /// hot hook cannot flood the channel.
    fn audit_hook_fill_denial(&self, mod_name: &str, handler: &str, hook: &str, capability: &str) {
        let Some(sink) = self.audit.as_ref() else {
            return;
        };
        let key = (
            mod_name.to_string(),
            handler.to_string(),
            hook.to_string(),
        );
        if !self
            .reported_hook_fill_denials
            .lock()
            .unwrap()
            .insert(key)
        {
            return;
        }
        sink(AuditEvent {
            binding: handler.to_string(),
            capability: Some(capability.to_string()),
            at_ms: now_ms(),
            decision: AuditDecision::Denied,
            mod_name: Some(mod_name.to_string()),
            hook: Some(hook.to_string()),
            ..Default::default()
        });
    }

    fn set_export_owner(&self, owner: Option<&str>) {
        let escaped = escape_js_string(owner.unwrap_or(""));
        let code = format!("globalThis.__xript_set_export_owner('{escaped}');");
        let _ = self
            .engine
            .with(|ctx| ctx.eval::<Value, _>(code.as_str()).map(|_| ()));
    }

    fn invoke_export_in(
        &self,
        name: &str,
        args: &[serde_json::Value],
        owner: Option<&str>,
        timeout_override_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        pollster::block_on(self.invoke_export_in_async(name, args, owner, timeout_override_ms))
    }

    async fn invoke_export_in_async(
        &self,
        name: &str,
        args: &[serde_json::Value],
        owner: Option<&str>,
        timeout_override_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        if let Some(owner) = owner
            && let Some(cap) = self.denied_capability(owner, name)
        {
            return Err(XriptError::CapabilityDenied {
                binding: name.to_string(),
                capability: cap,
            });
        }

        let args_json = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
        let escaped_name = escape_js_string(name);
        let owner_expr = match owner {
            Some(owner) => format!("'{}'", escape_js_string(owner)),
            None => "undefined".to_string(),
        };
        let yielding = self.mode == RuntimeMode::Async;
        let escaped_args = args_json.replace('\\', "\\\\").replace('`', "\\`");
        let code = format!(
            r#"({async_kw}function() {{
                var fn = globalThis.__xript_lookup_export('{name}', {owner});
                if (typeof fn !== 'function') {{
                    return JSON.stringify({{ __xript_err: "export {name} not found" }});
                }}
                try {{
                    var args = JSON.parse(`{args}`);
                    var result = {await_kw}fn.apply(null, args);
                    return JSON.stringify({{ __xript_ok: result === undefined ? null : result }});
                }} catch (e) {{
                    return JSON.stringify({{ __xript_err: (e && e.message) ? e.message : String(e) }});
                }}
            }})()"#,
            name = escaped_name,
            owner = owner_expr,
            args = escaped_args,
            async_kw = if yielding { "async " } else { "" },
            await_kw = if yielding { "await " } else { "" },
        );

        let result = self.execute_within_async(&code, timeout_override_ms).await?;
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

    /// Fires a host-declared hook, invoking every registered sandbox handler in
    /// registration order with the spread payload (object payloads spread to
    /// positional args per the hook's declared params, anything else passed as a
    /// single argument). Per-handler errors are swallowed to `undefined`; the
    /// collected results are returned in registration order. An unknown hook id
    /// fires nothing and returns an empty list.
    pub fn fire_hook(
        &self,
        hook: &str,
        payload: &[serde_json::Value],
    ) -> Result<Vec<serde_json::Value>> {
        Ok(self
            .fire_hook_tagged(hook, payload)?
            .into_iter()
            .map(|tagged| tagged.value)
            .collect())
    }

    /// [`fire_hook`](Self::fire_hook) with each result tagged by the mod that
    /// registered the handler and its index within that mod's handlers for this
    /// hook.
    ///
    /// Additive: `fire_hook` keeps its exact signature and behavior. The tags
    /// exist so a pool can merge segments from several workers back into a
    /// single deterministic order — see `spec/hooks.md`.
    pub fn fire_hook_tagged(&self, hook: &str, payload: &[serde_json::Value]) -> Result<Vec<TaggedResult>> {
        pollster::block_on(self.fire_hook_tagged_async(hook, payload))
    }

    /// [`fire_hook`](Self::fire_hook) as a future. Handlers run in registration
    /// order and their return values are collected as they are, unawaited.
    pub async fn fire_hook_async(&self, hook: &str, payload: &[serde_json::Value]) -> Result<Vec<serde_json::Value>> {
        Ok(self
            .fire_hook_tagged_async(hook, payload)
            .await?
            .into_iter()
            .map(|tagged| tagged.value)
            .collect())
    }

    /// [`fire_hook_tagged`](Self::fire_hook_tagged) as a future.
    pub async fn fire_hook_tagged_async(&self, hook: &str, payload: &[serde_json::Value]) -> Result<Vec<TaggedResult>> {
        let mut results = self.dispatch_to_registry("__xript_hooks", hook, payload, true).await?;
        let fills: Vec<crate::fragment::HookFillDecl> = self
            .hook_fills
            .lock()
            .unwrap()
            .iter()
            .filter(|fill| fill.hook == hook)
            .cloned()
            .collect();
        let mut counters: HashMap<String, u32> = HashMap::new();
        for tagged in &results {
            let next = counters.entry(tagged.mod_id.clone()).or_default();
            *next = (*next).max(tagged.index + 1);
        }
        for fill in fills {
            let index = counters.entry(fill.mod_name.clone()).or_default();
            let at = *index;
            *index += 1;
            if let Some(capability) = self.denied_capability(&fill.mod_name, &fill.handler) {
                self.audit_hook_fill_denial(&fill.mod_name, &fill.handler, hook, &capability);
                results.push(TaggedResult {
                    mod_id: fill.mod_name.clone(),
                    index: at,
                    value: serde_json::Value::Null,
                });
                continue;
            }
            let value = self
                .invoke_export_in_async(&fill.handler, payload, Some(&fill.mod_name), None)
                .await
                .unwrap_or(serde_json::Value::Null);
            results.push(TaggedResult {
                mod_id: fill.mod_name.clone(),
                index: at,
                value,
            });
        }
        Ok(results)
    }

    /// Emits a host-declared broadcast event, delivering the payload to every
    /// `events.on` subscriber in registration order. Shares the hook fan-out
    /// contract: object payloads spread to positional args, errors swallowed to
    /// `undefined`, results collected in order. An unknown or undeclared event id
    /// delivers to nobody and returns an empty list.
    pub fn emit(
        &self,
        event: &str,
        payload: &[serde_json::Value],
    ) -> Result<Vec<serde_json::Value>> {
        Ok(self
            .emit_tagged(event, payload)?
            .into_iter()
            .map(|tagged| tagged.value)
            .collect())
    }

    /// [`emit`](Self::emit) with each result tagged by the subscribing mod and
    /// its index within that mod's subscriptions for this event.
    pub fn emit_tagged(&self, event: &str, payload: &[serde_json::Value]) -> Result<Vec<TaggedResult>> {
        pollster::block_on(self.emit_tagged_async(event, payload))
    }

    /// [`emit`](Self::emit) as a future.
    pub async fn emit_async(&self, event: &str, payload: &[serde_json::Value]) -> Result<Vec<serde_json::Value>> {
        Ok(self
            .emit_tagged_async(event, payload)
            .await?
            .into_iter()
            .map(|tagged| tagged.value)
            .collect())
    }

    /// [`emit_tagged`](Self::emit_tagged) as a future.
    pub async fn emit_tagged_async(&self, event: &str, payload: &[serde_json::Value]) -> Result<Vec<TaggedResult>> {
        self.dispatch_to_registry("__xript_event_handlers", event, payload, false).await
    }

    async fn dispatch_to_registry(
        &self,
        registry: &str,
        id: &str,
        payload: &[serde_json::Value],
        hook_shaped: bool,
    ) -> Result<Vec<TaggedResult>> {
        let payload_json = serde_json::to_string(payload).unwrap_or_else(|_| "[]".into());
        let escaped_id = id.replace('\\', "\\\\").replace('\'', "\\'");
        let escaped_payload = payload_json.replace('\\', "\\\\").replace('`', "\\`");
        let _ = hook_shaped;
        let code = format!(
            r#"(function() {{
                var registry = globalThis['{registry}'] || {{}};
                var entries = registry['{id}'] || [];
                var args = JSON.parse(`{payload}`);
                var spread = (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]))
                    ? Object.keys(args[0]).map(function(k) {{ return args[0][k]; }})
                    : args;
                var results = [];
                for (var i = 0; i < entries.length; i++) {{
                    var entry = entries[i];
                    var handler = (entry && entry.handler) || entry;
                    var modId = (entry && entry.modId) || '';
                    if (typeof handler !== 'function') {{ results.push({{ modId: modId, value: null }}); continue; }}
                    try {{
                        var r = handler.apply(null, spread);
                        results.push({{ modId: modId, value: r === undefined ? null : r }});
                    }} catch (e) {{
                        results.push({{ modId: modId, value: null }});
                    }}
                }}
                return JSON.stringify(results);
            }})()"#,
            registry = registry,
            id = escaped_id,
            payload = escaped_payload,
        );

        let result = self.execute_async(&code).await?;
        let raw = result.value.as_str().unwrap_or("[]");
        let parsed: serde_json::Value =
            serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
        let entries = parsed.as_array().cloned().unwrap_or_default();
        let mut counters: HashMap<String, u32> = HashMap::new();
        Ok(entries
            .into_iter()
            .map(|entry| {
                let mod_id = entry
                    .get("modId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let counter = counters.entry(mod_id.clone()).or_default();
                let index = *counter;
                *counter += 1;
                TaggedResult {
                    mod_id,
                    index,
                    value: entry.get("value").cloned().unwrap_or(serde_json::Value::Null),
                }
            })
            .collect())
    }

    /// Which hooks and events the handlers registered by `mod_id` answer to.
    ///
    /// A pool reads this at load time so a fan-out only reaches the workers
    /// that actually host a handler, instead of queueing a no-op behind
    /// whatever every other worker is doing.
    pub fn handler_index_for(&self, mod_id: &str) -> HandlerIndex {
        let escaped = js_string_escape(mod_id);
        let code = format!(
            r#"(function() {{
                var out = {{ hooks: [], events: [] }};
                var want = '{escaped}';
                function scan(registry, into) {{
                    var reg = globalThis[registry] || {{}};
                    for (var id in reg) {{
                        var entries = reg[id] || [];
                        for (var i = 0; i < entries.length; i++) {{
                            var entry = entries[i];
                            if (entry && entry.modId === want) {{ into.push(id); break; }}
                        }}
                    }}
                }}
                scan('__xript_hooks', out.hooks);
                scan('__xript_event_handlers', out.events);
                return JSON.stringify(out);
            }})()"#
        );
        let mut index = match self.execute(&code) {
            Ok(result) => result
                .value
                .as_str()
                .and_then(|raw| serde_json::from_str::<HandlerIndex>(raw).ok())
                .unwrap_or_default(),
            Err(_) => HandlerIndex::default(),
        };
        for fill in self.hook_fills.lock().unwrap().iter() {
            if fill.mod_name == mod_id && !index.hooks.contains(&fill.hook) {
                index.hooks.push(fill.hook.clone());
            }
        }
        index
    }

    /// The instrumentation a supervisor reads to tell a slow call from a
    /// wedged one.
    pub fn probe(&self) -> Arc<RuntimeProbe> {
        self.probe.clone()
    }

    /// Returns the loaded fragment contributions targeting `slot_id`, ordered by
    /// priority descending then fragment id ascending. When the slot's
    /// `multiple` is false (default), at most one contribution (the winner) is
    /// returned. An undeclared slot id returns an empty vec.
    pub fn resolve_slot(&self, slot_id: &str) -> Vec<SlotContribution> {
        resolve_slot_from(&self.manifest, &self.loaded_mods, slot_id)
    }

    /// Convenience for single-cardinality slots: returns the winning
    /// contribution, or `None` when the slot has no contributions.
    pub fn resolve_slot_single(&self, slot_id: &str) -> Option<SlotContribution> {
        self.resolve_slot(slot_id).into_iter().next()
    }

    /// Returns every loaded mod that provides `role`, ordered by owning mod
    /// name ascending. The host uses this ordered candidate set to build its
    /// own picker UI. An unprovided role returns an empty vec.
    ///
    /// The order is the shared slot ordering (priority descending, fill id
    /// ascending, owning mod ascending) collapsed onto role candidates, which
    /// carry neither a priority nor a fill id: two providers of one role
    /// therefore resolve by mod name and never by the host's load order.
    pub fn resolve_role_all(&self, role: &str) -> Vec<RoleResolution> {
        resolve_role_all_from(&self.loaded_mods, role)
    }

    /// Resolves the winning provider for `role`. Policy is the deterministic
    /// ordering of [`Self::resolve_role_all`] unless `role_preferences[role]`
    /// names a candidate present in the loaded set, in which case that addon
    /// wins. A role with no provider resolves to `None`. xript never invokes
    /// the returned fns.
    pub fn resolve_role(&self, role: &str) -> Option<RoleResolution> {
        resolve_role_from(&self.loaded_mods, &self.role_preferences, role)
    }

    /// The authority a host renders for a command: the handler's export
    /// capability when it declares one, otherwise the slot's gate. Purely
    /// informational — [`Self::invoke_command`] enforces through the export
    /// path, never through this value.
    fn command_capability(&self, fill: &crate::commands::CommandFill) -> Option<String> {
        let declared = self
            .export_caps
            .lock()
            .unwrap()
            .get(&fill.mod_name)
            .and_then(|own| own.get(&fill.handler).cloned())
            .flatten();
        declared.or_else(|| {
            self.manifest
                .slots
                .as_ref()
                .and_then(|slots| slots.iter().find(|slot| slot.id == fill.slot))
                .and_then(|slot| slot.capability.clone())
        })
    }

    fn slots(&self) -> &[crate::manifest::Slot] {
        self.manifest.slots.as_deref().unwrap_or(&[])
    }

    /// Every command filling `slot_id`, ordered by priority descending, then
    /// command id ascending, then owning mod ascending, with no cardinality
    /// applied.
    pub fn resolve_commands_all(&self, slot_id: &str) -> Vec<crate::commands::ResolvedCommand> {
        let fills = self.command_fills.lock().unwrap().clone();
        crate::commands::resolve_commands_all_with(slot_id, &fills, &|fill| {
            self.command_capability(fill)
        })
    }

    /// The commands filling `slot_id` after the slot's cardinality is applied:
    /// a `multiple: false` command slot resolves to exactly one command across
    /// all mods, the same as every other slot kind.
    pub fn resolve_commands(&self, slot_id: &str) -> Vec<crate::commands::ResolvedCommand> {
        let fills = self.command_fills.lock().unwrap().clone();
        crate::commands::resolve_commands_with(slot_id, &fills, self.slots(), &|fill| {
            self.command_capability(fill)
        })
    }

    /// Resolves a bare command id or a `mod:id` qualified id. A qualified id is
    /// total and ignores preferences; a bare id honors
    /// `command_preferences`, keyed by command id or by slot id.
    pub fn resolve_command(&self, reference: &str) -> Option<crate::commands::ResolvedCommand> {
        let fills = self.command_fills.lock().unwrap().clone();
        crate::commands::resolve_command_with(
            reference,
            &fills,
            self.slots(),
            &self.command_preferences,
            &|fill| self.command_capability(fill),
        )
    }

    /// Invokes a resolved command: bound args merged with call args (call-time
    /// wins), then dispatched through the mod-scoped export path, so the
    /// handler runs in its declaring mod's own namespace behind that export's
    /// capability gate. A throwing handler surfaces as an invocation error
    /// rather than being swallowed the way a hook handler's is.
    pub fn invoke_command(
        &self,
        command: &crate::commands::ResolvedCommand,
        call_args: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Result<serde_json::Value> {
        let effective = crate::commands::merge_command_args(&command.args, call_args);
        self.invoke_mod_export_within(
            &command.mod_name,
            &command.handler,
            &[serde_json::Value::Object(effective)],
            Some(self
                .manifest
                .effective_slot_timeout_ms(&command.slot, self.hard_timeout_ms)),
        )
    }

    /// [`invoke_command`](Self::invoke_command) as a future; the handler is
    /// awaited the way [`invoke_export_async`](Self::invoke_export_async)
    /// awaits an export.
    pub async fn invoke_command_async(
        &self,
        command: &crate::commands::ResolvedCommand,
        call_args: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Result<serde_json::Value> {
        let effective = crate::commands::merge_command_args(&command.args, call_args);
        self.invoke_mod_export_within_async(
            &command.mod_name,
            &command.handler,
            &[serde_json::Value::Object(effective)],
            Some(self
                .manifest
                .effective_slot_timeout_ms(&command.slot, self.hard_timeout_ms)),
        )
        .await
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
    ) -> Result<Vec<crate::fragment::ops::FragmentOp>> {
        pollster::block_on(self.fire_fragment_hook_async(fragment_id, lifecycle, bindings))
    }

    /// [`fire_fragment_hook`](Self::fire_fragment_hook) as a future.
    pub async fn fire_fragment_hook_async(
        &self,
        fragment_id: &str,
        lifecycle: &str,
        bindings: Option<&serde_json::Value>,
    ) -> Result<Vec<crate::fragment::ops::FragmentOp>> {
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
                        removeAttr: function(sel, attr) {{ ops.push({{ op: "removeAttr", selector: sel, attr: attr }}); }},
                        setProp: function(sel, prop, val) {{ ops.push({{ op: "setProp", selector: sel, prop: prop, value: val }}); }},
                        replaceChildren: function(sel, children) {{ ops.push({{ op: "replaceChildren", selector: sel, value: children }}); }}
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

        let result = self.execute_async(&code).await?;
        let raw: Vec<serde_json::Value> = serde_json::from_str::<Vec<Vec<serde_json::Value>>>(
            result.value.as_str().unwrap_or("[]"),
        )
        .map(|per_handler| per_handler.into_iter().flatten().collect())
        .unwrap_or_default();

        let profile = self.fragment_profile(fragment_id);
        let sink = self.on_fragment_diagnostic.clone();
        let mut report = |diagnostic: crate::fragment::vocabulary::FragmentDiagnostic| {
            if let Some(ref sink) = sink {
                sink(fragment_id, &diagnostic);
            }
        };
        Ok(crate::fragment::ops::finalize_ops(&raw, &profile, &mut report))
    }

    /// Resolves the vocabulary a loaded fragment speaks, falling back to
    /// `text/html` for a fragment this runtime does not know about.
    fn fragment_profile(&self, fragment_id: &str) -> crate::fragment::profiles::FormatProfile {
        let mods = read_mods(&self.loaded_mods);
        for loaded in mods.iter() {
            for fragment in &loaded.fragments {
                if fragment.id == fragment_id {
                    return fragment.profile.clone();
                }
            }
        }
        crate::fragment::profiles::builtin_profile("text/html")
            .expect("text/html is a built-in profile")
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

    let all_exports: Object = ctx
        .globals()
        .get("__xript_exports")
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    let owner: String = ctx
        .globals()
        .get("__xript_export_owner")
        .unwrap_or_default();
    let registry: Object = all_exports
        .get(owner.as_str())
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
        (function () {
            var refuse = function () {
                throw new TypeError("Function constructor is not permitted. Dynamic code generation is disabled in xript.");
            };
            var prototypes = [
                Object.getPrototypeOf(function () {}),
                Object.getPrototypeOf(async function () {}),
                Object.getPrototypeOf(function* () {}),
                Object.getPrototypeOf(async function* () {}),
            ];
            for (var i = 0; i < prototypes.length; i++) {
                Object.defineProperty(prototypes[i], 'constructor', { value: refuse, writable: true, configurable: true });
            }
        })();
        if (typeof globalThis.Function !== 'undefined') {
            Object.defineProperty(globalThis, 'Function', {
                get: function() { throw new TypeError("Function constructor is not permitted. Dynamic code generation is disabled in xript."); },
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
        globalThis.__xript_exports = { "": {} };
        globalThis.__xript_export_owner = "";
        globalThis.__xript_set_export_owner = function(owner) {
            var key = typeof owner === 'string' ? owner : "";
            globalThis.__xript_export_owner = key;
            if (!globalThis.__xript_exports[key]) globalThis.__xript_exports[key] = {};
            return key;
        };
        globalThis.__xript_export_owners_of = function(name) {
            var owners = [];
            var keys = Object.keys(globalThis.__xript_exports);
            for (var i = 0; i < keys.length; i++) {
                if (typeof globalThis.__xript_exports[keys[i]][name] === 'function') owners.push(keys[i]);
            }
            return owners;
        };
        globalThis.__xript_lookup_export = function(name, owner) {
            if (typeof owner === 'string') {
                var bucket = globalThis.__xript_exports[owner];
                return bucket ? bucket[name] : undefined;
            }
            var owners = globalThis.__xript_export_owners_of(name);
            return owners.length === 1 ? globalThis.__xript_exports[owners[0]][name] : undefined;
        };
        var exportsNs = {
            register: function(name, fn) {
                if (typeof name !== 'string') {
                    throw new Error("xript.exports.register: name must be a string");
                }
                if (typeof fn !== 'function') {
                    throw new Error("xript.exports.register: fn must be a function");
                }
                globalThis.__xript_exports[globalThis.__xript_export_owner][name] = fn;
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
/// Wraps a sync host binding so that entering it is visible to the probe and,
/// when a sink is configured, audited. The probe wrap is unconditional: wedge
/// detection has to be able to name the binding a thread is stuck in whether
/// or not the host asked for an audit trail.
fn audited_sync(
    f: HostFn,
    audit: &Option<AuditSink>,
    binding: &str,
    capability: Option<String>,
    probe: &Arc<RuntimeProbe>,
) -> HostFn {
    let index = probe.intern(binding);
    let probe = probe.clone();
    let sink = audit.clone();
    let binding = binding.to_string();
    Arc::new(move |args| {
        if let Some(ref sink) = sink {
            sink(AuditEvent {
                binding: binding.clone(),
                capability: capability.clone(),
                at_ms: now_ms(),
                decision: AuditDecision::Invoke,
                ..Default::default()
            });
        }
        let _scope = BindingScope::enter(&probe, index);
        f(args)
    })
}

/// The async mirror of [`audited_sync`]. On a sync runtime the scope covers
/// the whole future, which is settled with `pollster::block_on` on the JS
/// thread, so a host future that never settles reads as "inside this binding"
/// for as long as it takes, which is exactly right. On a yielding runtime the
/// thread is not inside the binding while its future is pending, so the scope
/// covers only the call that creates the future.
fn audited_async(
    f: AsyncHostFn,
    audit: &Option<AuditSink>,
    binding: &str,
    capability: Option<String>,
    probe: &Arc<RuntimeProbe>,
) -> AsyncHostFn {
    let yielding = probe.yielding();
    let index = probe.intern(binding);
    let probe = probe.clone();
    let sink = audit.clone();
    let binding = binding.to_string();
    Arc::new(move |args| {
        if let Some(ref sink) = sink {
            sink(AuditEvent {
                binding: binding.clone(),
                capability: capability.clone(),
                at_ms: now_ms(),
                decision: AuditDecision::Invoke,
                ..Default::default()
            });
        }
        let scope = BindingScope::enter(&probe, index);
        let inner = f(args);
        if yielding {
            drop(scope);
            return inner;
        }
        Box::pin(async move {
            let _scope = scope;
            inner.await
        })
    })
}

fn register_bindings(
    ctx: &Ctx<'_>,
    manifest: &Manifest,
    host_bindings: HostBindings,
    granted: &HashSet<String>,
    audit: &Option<AuditSink>,
    probe: &Arc<RuntimeProbe>,
) -> Result<()> {
    let Some(ref bindings) = manifest.bindings else {
        return Ok(());
    };

    for (name, binding) in bindings {
        match binding {
            Binding::Function(func_def) => {
                if let Some(ref cap) = func_def.capability {
                    if !crate::cap_match::granted_satisfies(granted, cap) {
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
                let checks = crate::callback::function_param_checks(func_def.params.as_ref());
                match host_bindings.bindings.get(name) {
                    Some(HostBinding::Function(f)) => {
                        let wrapped = audited_sync(f.clone(), audit, name, cap, probe);
                        let js_fn = create_host_function(ctx, name, wrapped, &checks)?;
                        ctx.globals()
                            .set(name.as_str(), js_fn)
                            .map_err(|e| XriptError::Engine(e.to_string()))?;
                    }
                    Some(HostBinding::AsyncFunction(f)) => {
                        let wrapped = audited_async(f.clone(), audit, name, cap, probe);
                        let js_fn = async_binding(ctx, name, wrapped, probe, &checks)?;
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
                register_namespace_binding(ctx, name, ns_def, &host_bindings, granted, audit, probe)?;
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
    probe: &Arc<RuntimeProbe>,
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

    let ns_obj = build_namespace_object(ctx, name, &ns_def.members, &host_view, granted, audit, probe)?;

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
    probe: &Arc<RuntimeProbe>,
) -> Result<Object<'js>> {
    let ns_obj = Object::new(ctx.clone()).map_err(|e| XriptError::Engine(e.to_string()))?;

    for (member_name, member_binding) in members {
        let full_name = format!("{}.{}", path, member_name);

        match member_binding {
            Binding::Namespace(sub_ns) => {
                let sub_view = nested_host_view(host_view, member_name);
                let sub_obj =
                    build_namespace_object(ctx, &full_name, &sub_ns.members, &sub_view, granted, audit, probe)?;
                ns_obj
                    .set(member_name.as_str(), sub_obj)
                    .map_err(|e| XriptError::Engine(e.to_string()))?;
            }
            Binding::Function(func_def) => {
                if let Some(ref cap) = func_def.capability {
                    if !crate::cap_match::granted_satisfies(granted, cap) {
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
                let checks = crate::callback::function_param_checks(func_def.params.as_ref());
                let value = resolve_namespace_member(
                    ctx,
                    &full_name,
                    member_name,
                    host_view,
                    cap,
                    &checks,
                    audit,
                    probe,
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
    checks: &[crate::callback::FunctionParamCheck],
    audit: &Option<AuditSink>,
    probe: &Arc<RuntimeProbe>,
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
                let wrapped = audited_sync(f.clone(), audit, full_name, capability, probe);
                return Ok(create_host_function(ctx, full_name, wrapped, &checks)?.into_value());
            }
        }
        HostNsView::Sync(map) => {
            if let Some(f) = map.get(member_name) {
                let wrapped = audited_sync(f.clone(), audit, full_name, capability, probe);
                return Ok(create_host_function(ctx, full_name, wrapped, &checks)?.into_value());
            }
        }
        HostNsView::Async(map) => {
            if let Some(f) = map.get(member_name) {
                let wrapped = audited_async(f.clone(), audit, full_name, capability, probe);
                return Ok(async_binding(ctx, full_name, wrapped, probe, &checks)?.into_value());
            }
        }
        HostNsView::Nested(map) => match map.get(member_name) {
            Some(HostNamespaceMember::Function(f)) => {
                let wrapped = audited_sync(f.clone(), audit, full_name, capability, probe);
                return Ok(create_host_function(ctx, full_name, wrapped, &checks)?.into_value());
            }
            Some(HostNamespaceMember::AsyncFunction(f)) => {
                let wrapped = audited_async(f.clone(), audit, full_name, capability, probe);
                return Ok(async_binding(ctx, full_name, wrapped, probe, &checks)?.into_value());
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
    let hooks = manifest.effective_hooks();

    if hooks.is_empty() {
        return Ok(());
    }

    let mut hook_setup = String::from("globalThis.__xript_hooks = {};\n");
    hook_setup.push_str("globalThis.hooks = {};\n");

    for (hook_name, hook_def) in &hooks {
        hook_setup.push_str(&format!(
            "globalThis.__xript_hooks['{}'] = [];\n",
            hook_name
        ));

        if let Some(ref phases) = hook_def.phases {
            if !phases.is_empty() {
                hook_setup.push_str(&format!("globalThis.hooks['{}'] = {{}};\n", hook_name));
                for phase in phases {
                    let registration = if let Some(ref cap) = hook_def.capability {
                        if !crate::cap_match::granted_satisfies(granted, cap) {
                            format!(
                                "globalThis.hooks['{hook}']['{phase}'] = function() {{ throw new Error(\"{hook}.{phase}() requires the \\\"{cap}\\\" capability\"); }};",
                                hook = hook_name, phase = phase, cap = cap
                            )
                        } else {
                            format!(
                                "globalThis.hooks['{hook}']['{phase}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ phase: '{phase}', modId: globalThis.__xript_export_owner || '', handler: handler }}); }};",
                                hook = hook_name, phase = phase
                            )
                        }
                    } else {
                        format!(
                            "globalThis.hooks['{hook}']['{phase}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ phase: '{phase}', modId: globalThis.__xript_export_owner || '', handler: handler }}); }};",
                            hook = hook_name, phase = phase
                        )
                    };
                    hook_setup.push_str(&registration);
                    hook_setup.push('\n');
                }
            }
        } else {
            let registration = if let Some(ref cap) = hook_def.capability {
                if !crate::cap_match::granted_satisfies(granted, cap) {
                    format!(
                        "globalThis.hooks['{hook}'] = function() {{ throw new Error(\"{hook}() requires the \\\"{cap}\\\" capability\"); }};",
                        hook = hook_name, cap = cap
                    )
                } else {
                    format!(
                        "globalThis.hooks['{hook}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ modId: globalThis.__xript_export_owner || '', handler: handler }}); }};",
                        hook = hook_name
                    )
                }
            } else {
                format!(
                    "globalThis.hooks['{hook}'] = function(handler) {{ globalThis.__xript_hooks['{hook}'].push({{ modId: globalThis.__xript_export_owner || '', handler: handler }}); }};",
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

/// Injects the `events` global and the `__xript_event_handlers` registry,
/// mirroring the hook gate model: a subscription is admitted only when the
/// event's declared capability is satisfied by the granted set, otherwise
/// `events.on` for that id is a throwing stub baked at injection.
fn register_events(ctx: &Ctx<'_>, manifest: &Manifest, granted: &HashSet<String>) -> Result<()> {
    let Some(ref events) = manifest.events else {
        return Ok(());
    };

    let mut setup = String::from("globalThis.__xript_event_handlers = {};\n");
    setup.push_str("globalThis.__xript_event_gates = {};\n");

    for event in events {
        let id = js_string_escape(&event.id);
        setup.push_str(&format!("globalThis.__xript_event_handlers['{id}'] = [];\n"));

        let admitted = match event.capability {
            Some(ref cap) => crate::cap_match::granted_satisfies(granted, cap),
            None => true,
        };

        if admitted {
            setup.push_str(&format!("globalThis.__xript_event_gates['{id}'] = true;\n"));
        } else {
            let cap = js_string_escape(event.capability.as_deref().unwrap_or(""));
            setup.push_str(&format!(
                "globalThis.__xript_event_gates['{id}'] = \"{cap}\";\n"
            ));
        }
    }

    setup.push_str(
        r#"
        function __xript_event_subscribe(id, handler) {
            var gate = globalThis.__xript_event_gates[id];
            if (gate === undefined) {
                throw new Error("event \"" + id + "\" is not declared by the host");
            }
            if (gate !== true) {
                throw new Error("events.on(\"" + id + "\") requires the \"" + gate + "\" capability");
            }
            if (typeof handler !== 'function') {
                throw new Error("events.on(\"" + id + "\") handler must be a function");
            }
            globalThis.__xript_event_handlers[id].push({ modId: globalThis.__xript_export_owner || '', handler: handler });
        }
        globalThis.events = Object.freeze({
            on: __xript_event_subscribe,
            subscribe: __xript_event_subscribe,
        });
    "#,
    );

    ctx.eval::<(), _>(setup.as_str())
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(())
}

fn js_string_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'").replace('"', "\\\"")
}

/// The sandbox side of a bridged binding: refuses a non-function where the
/// manifest declares a function parameter, then serializes the arguments with
/// every script function swapped for a numeric callback marker and hands the
/// functions to the bridge alongside the JSON.
const BRIDGE_WRAPPER: &str = r#"(function (bridge, marker, checks, name, settle) {
    var stringify = JSON.stringify;
    var parse = JSON.parse;
    var slice = Array.prototype.slice;
    return function () {
        var args = slice.call(arguments);
        for (var i = 0; i < checks.length; i++) {
            var check = checks[i];
            var value = args[check.index];
            if (typeof value === 'function') continue;
            if (check.optional && (value === undefined || value === null)) continue;
            throw new TypeError(name + '(): parameter "' + check.name + '" expects a function, got ' + (value === null ? 'null' : typeof value));
        }
        var fns = [];
        var json = stringify(args, function (key, v) {
            if (typeof v === 'function') {
                var m = {};
                m[marker] = fns.length;
                fns[fns.length] = v;
                return m;
            }
            return v;
        });
        return settle(bridge(json, fns), parse);
    };
})"#;

const SYNC_SETTLE: &str = "(function (raw, parse) { var envelope = parse(raw); if (envelope.__xript_err !== undefined) { throw new Error(envelope.__xript_err); } return envelope.__xript_ok; })";

const ASYNC_SETTLE: &str = "(function (raw, parse) { var envelope = parse(raw); if (envelope.__xript_err !== undefined) { return Promise.reject(new Error(envelope.__xript_err)); } return Promise.resolve(envelope.__xript_ok); })";

const YIELD_SETTLE: &str = "(function (pending, parse) { return pending.then(function (raw) { var envelope = parse(raw); if (envelope.__xript_err !== undefined) { throw new Error(envelope.__xript_err); } return envelope.__xript_ok; }); })";

const ASYNC_IN_CALLBACK_MESSAGE: &str =
    "cannot be called from inside a callback passed to a binding: it is async, and a callback runs synchronously";

fn bridge_envelope(result: std::result::Result<serde_json::Value, String>) -> String {
    match result {
        Ok(value) => serde_json::to_string(&serde_json::json!({ "__xript_ok": value }))
            .unwrap_or("{\"__xript_ok\":null}".into()),
        Err(msg) => serde_json::to_string(&serde_json::json!({ "__xript_err": msg })).unwrap(),
    }
}

/// Runs one bridged binding call: resolves its callbacks, invokes the host
/// through `call`, and ends the call with the script's own exception when a
/// callback demands it (a budget stop, or a throw the host passed through).
fn run_bridged_call<'js>(
    ctx: &Ctx<'js>,
    binding: &str,
    args_json: &str,
    functions: Vec<Function<'js>>,
    call: impl FnOnce(&[serde_json::Value]) -> std::result::Result<serde_json::Value, String>,
) -> rquickjs::Result<String> {
    let mut args: Vec<serde_json::Value> = match serde_json::from_str(args_json) {
        Ok(a) => a,
        Err(e) => return Ok(bridge_envelope(Err(format!("invalid args: {}", e)))),
    };
    let scope = crate::callback::CallScope::new(ctx.clone(), binding, functions);
    scope.resolve_markers(&mut args);
    let result = scope.run(|| call(&args));
    if let Some(exception) = scope.outcome(result.as_ref().err().map(String::as_str)) {
        return Err(ctx.throw(exception));
    }
    Ok(bridge_envelope(result))
}

fn install_bridge<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    bridge_fn: Function<'js>,
    checks: &[crate::callback::FunctionParamCheck],
    settle: &str,
) -> Result<Function<'js>> {
    let checks_json = serde_json::to_string(checks).map_err(|e| XriptError::Engine(e.to_string()))?;
    let name_json = serde_json::to_string(name).map_err(|e| XriptError::Engine(e.to_string()))?;
    let marker_json = serde_json::to_string(crate::callback::CALLBACK_MARKER)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    ctx.globals()
        .set("__xript_tmp_bridge", bridge_fn)
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    let wrapper: Function = ctx
        .eval(format!(
            "{BRIDGE_WRAPPER}(__xript_tmp_bridge, {marker_json}, {checks_json}, {name_json}, {settle})"
        ))
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    ctx.eval::<(), _>("delete globalThis.__xript_tmp_bridge")
        .map_err(|e| XriptError::Engine(e.to_string()))?;

    Ok(wrapper)
}

fn async_binding<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: AsyncHostFn,
    probe: &Arc<RuntimeProbe>,
    checks: &[crate::callback::FunctionParamCheck],
) -> Result<Function<'js>> {
    if probe.yielding() {
        create_yielding_host_function(ctx, name, f, checks)
    } else {
        create_async_host_function(ctx, name, f, checks)
    }
}

/// An async host binding on a yielding runtime: hands script a genuinely
/// pending promise and spawns the host future onto the runtime's own executor.
/// The call's callback scope travels with the future and is entered for every
/// poll, so callbacks passed to the binding stay callable until it settles,
/// as they do on a sync runtime, and expire when it does.
fn create_yielding_host_function<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: AsyncHostFn,
    checks: &[crate::callback::FunctionParamCheck],
) -> Result<Function<'js>> {
    let binding = name.to_string();
    let bridge_fn = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, args_json: String, functions: Vec<Function<'js>>| -> rquickjs::Result<Value<'js>> {
            if crate::callback::inside_callback() {
                return Err(rquickjs::Exception::throw_message(
                    &ctx,
                    &format!("{binding}(): {ASYNC_IN_CALLBACK_MESSAGE}"),
                ));
            }
            let (promise, resolve, reject) = ctx.promise()?;
            let mut args: Vec<serde_json::Value> = match serde_json::from_str(&args_json) {
                Ok(a) => a,
                Err(e) => {
                    resolve.call::<_, ()>((bridge_envelope(Err(format!("invalid args: {}", e))),))?;
                    return Ok(promise.into_value());
                }
            };
            let scope = crate::callback::CallScope::new(ctx.clone(), &binding, functions);
            scope.resolve_markers(&mut args);
            let mut pending = scope.run(|| f(&args));
            if let Some(exception) = scope.outcome(None) {
                return Err(ctx.throw(exception));
            }
            ctx.spawn(async move {
                let result = std::future::poll_fn(|cx| scope.run(|| pending.as_mut().poll(cx))).await;
                let _ = match scope.outcome(result.as_ref().err().map(String::as_str)) {
                    Some(exception) => reject.call::<_, ()>((exception,)),
                    None => resolve.call::<_, ()>((bridge_envelope(result),)),
                };
            });
            Ok(promise.into_value())
        },
    )
    .map_err(|e| {
        XriptError::Engine(format!(
            "failed to create async host function '{}': {}",
            name, e
        ))
    })?;

    install_bridge(ctx, name, bridge_fn, checks, YIELD_SETTLE)
}

fn create_host_function<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: HostFn,
    checks: &[crate::callback::FunctionParamCheck],
) -> Result<Function<'js>> {
    let binding = name.to_string();
    let bridge_fn = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, args_json: String, functions: Vec<Function<'js>>| -> rquickjs::Result<String> {
            run_bridged_call(&ctx, &binding, &args_json, functions, |args| f(args))
        },
    )
    .map_err(|e| {
        XriptError::Engine(format!("failed to create host function '{}': {}", name, e))
    })?;

    install_bridge(ctx, name, bridge_fn, checks, SYNC_SETTLE)
}

fn create_async_host_function<'js>(
    ctx: &Ctx<'js>,
    name: &str,
    f: AsyncHostFn,
    checks: &[crate::callback::FunctionParamCheck],
) -> Result<Function<'js>> {
    let binding = name.to_string();
    let bridge_fn = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, args_json: String, functions: Vec<Function<'js>>| -> rquickjs::Result<String> {
            if crate::callback::inside_callback() {
                return Err(rquickjs::Exception::throw_message(
                    &ctx,
                    &format!("{binding}(): {ASYNC_IN_CALLBACK_MESSAGE}"),
                ));
            }
            run_bridged_call(&ctx, &binding, &args_json, functions, |args| {
                pollster::block_on(f(args))
            })
        },
    )
    .map_err(|e| {
        XriptError::Engine(format!(
            "failed to create async host function '{}': {}",
            name, e
        ))
    })?;

    install_bridge(ctx, name, bridge_fn, checks, ASYNC_SETTLE)
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
fn escape_js_string(raw: &str) -> String {
    raw.replace('\\', "\\\\").replace('\'', "\\'")
}

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

pub(crate) fn json_to_js<'js>(ctx: &Ctx<'js>, value: &serde_json::Value) -> Result<Value<'js>> {
    let serialized = serde_json::to_string(value)
        .map_err(|e| XriptError::Engine(format!("json_to_js serialize: {e}")))?;
    let escaped = serialized.replace('\\', "\\\\").replace('`', "\\`");
    let script = format!("JSON.parse(`{}`)", escaped);
    ctx.eval::<Value, _>(script.as_str())
        .map_err(|e| XriptError::Engine(format!("json_to_js eval: {e}")))
}

pub(crate) fn js_value_to_json<'a>(ctx: &Ctx<'a>, val: &Value<'a>) -> serde_json::Value {
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
