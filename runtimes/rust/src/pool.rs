//! Many runtimes, two lanes, one home per mod.
//!
//! [`XriptPool`] is a **router over N [`XriptHandle`]s**, not a new
//! concurrency primitive. Every worker is a whole handle with its own
//! interpreter on its own thread, so everything the handle guarantees holds
//! inside the pool for free, and a host can always drop to a single worker with
//! [`XriptPool::on`].
//!
//! Three rules carry the design, and each is load-bearing enough that
//! violating it quietly would be worse than having no pool at all.
//!
//! **A mod lives on exactly one runtime.** Its exports, its hook handlers, its
//! event handlers and its module-scope state all reside on its home worker, and
//! every call into that mod is dispatched there. That is what makes a handler
//! run exactly once, as it does on a single runtime. Loading a mod onto every
//! worker so that any worker could answer any call would fan `emit` and
//! `fire_hook` to N copies of the same handler, and a handler that writes
//! through a host binding would perform its side effect N times. The price of
//! the rule is that a single mod gets no parallelism from the pool;
//! parallelism across *different* mods does.
//!
//! **Host bindings are called from N threads.** A binding registered with a
//! pool MUST be reentrant and thread-safe. xript does not and cannot serialize
//! calls into host code: the pool builds workers from a factory and never holds
//! a binding it could wrap, and a per-binding lock would let a long-lane call
//! block an interactive-lane one, which is the exact inversion the pool exists
//! to prevent. A documented contract, not a mechanism.
//!
//! **A wedged worker is detected, quarantined, and reported. It is not
//! reclaimed.** QuickJS's interrupt handler fires only while bytecode runs, so
//! a thread blocked inside a host binding observes no timeout, no cancellation
//! token and no drop-cancel. Its thread cannot be safely killed and its
//! runtime's memory cannot be reclaimed. [`XriptPool::retire_worker`] removes
//! it from routing and abandons the thread; the memory stays allocated until
//! the process exits, and [`PoolShutdownReport::leaked_bytes_estimate`] says so
//! in bytes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use crate::error::{Result, XriptError};
use crate::fragment::ModInstance;
use crate::handle::{CallInfo, ShutdownReport, WorkerState, XriptHandle};
use crate::manifest::{IntentAffinity, IntentDuration, Manifest, ModManifest, ResolvedIntent};
use crate::pending::{CallToken, Completer, Pending};
use crate::sandbox::{AuditEvent, AuditSink, ExecutionResult, RuntimeOptions, TaggedResult};

/// Which worker. `Dedicated` is a one-shot runtime built for a single
/// `execute` and torn down after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum WorkerId {
    Worker(usize),
    Dedicated(u64),
}

impl std::fmt::Display for WorkerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerId::Worker(n) => write!(f, "{n}"),
            WorkerId::Dedicated(n) => write!(f, "dedicated:{n}"),
        }
    }
}

/// Two lanes, not N. The distinction that actually matters is "is a human
/// waiting on the next frame"; every further lane is a knob a host has to
/// reason about for no benefit. A host that wants finer control implements
/// [`PoolRouter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    /// Ticks, events, slot-driven UI work: anything on a frame budget.
    /// [`Saturation::Backpressure`] is forced here, because shedding a UI
    /// event is worse than waiting for it.
    Interactive,
    /// `long` and `unbounded` work, and anything the host sends here.
    Long,
}

impl Lane {
    fn as_str(self) -> &'static str {
        match self {
            Lane::Interactive => "interactive",
            Lane::Long => "long",
        }
    }
}

/// What to do when a worker's queue is full.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Saturation {
    /// Admit anyway; the `Pending` simply resolves later.
    Backpressure,
    /// Fail immediately with [`XriptError::Saturated`]. The long lane's
    /// default: a host oversubscribing it should find out now.
    #[default]
    Reject,
    /// Cancel the oldest **queued** call to admit the new one.
    ///
    /// It cannot shed the call already running. Shedding rides the
    /// pre-dispatch token check, which is the one cancellation path that needs
    /// no interrupt and therefore always works; a dispatched call is past it.
    /// Right for tick-shaped work where the newest request subsumes the older.
    ShedOldest,
}

/// Whether a fan-out crossing workers runs them at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HookDispatch {
    /// Dispatch to every involved worker at once and merge deterministically.
    ///
    /// **Result ordering is preserved; happens-before between handlers on
    /// different workers is not.** Handlers on the same worker still run in
    /// order and still observe each other's effects.
    #[default]
    Concurrent,
    /// Dispatch worker-group by worker-group in load order, restoring full
    /// single-runtime happens-before at the cost of the parallelism. The right
    /// setting for handlers that coordinate through shared host state.
    Sequential,
}

/// What to do with a call bound for a worker already marked unhealthy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WedgePolicy {
    /// Fail immediately with [`XriptError::WorkerWedged`].
    #[default]
    FailFast,
    /// Queue anyway, on the chance the binding returns.
    Queue,
}

/// Per-worker segments of a fan-out, indexed by dispatch slot.
type Segments = Arc<Mutex<Vec<Option<Result<Vec<TaggedResult>>>>>>;

/// Called once when a worker is first marked wedged, so a host can log,
/// alert, or degrade its UI rather than discover it at the next call.
pub type WedgeSink = Arc<dyn Fn(&WedgedWorker) + Send + Sync>;

/// Thresholds for wedge detection.
///
/// **Both** an over-threshold in-flight call and a stalled heartbeat are
/// required. A worker executing script bytecode is never marked wedged no
/// matter how long it runs — that is what `limits` is for, and `limits` works
/// there.
pub struct HealthConfig {
    /// How often the supervisor samples every worker.
    pub interval: Duration,
    /// How long an in-flight call may run before it is *eligible* to be called
    /// wedged. Never sufficient on its own.
    pub wedge_threshold: Duration,
    /// The same, for a call whose resolved `duration` is `unbounded`.
    pub unbounded_threshold: Duration,
    /// How long the heartbeat may stall before the worker is *eligible*.
    pub heartbeat_stall: Duration,
    /// Called once per worker, the first time it is marked unhealthy.
    pub on_wedge: Option<WedgeSink>,
    /// Cap on replacements when [`PoolConfig::replace_wedged`] is on.
    pub max_replacements: usize,
}

impl std::fmt::Debug for HealthConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HealthConfig")
            .field("interval", &self.interval)
            .field("wedge_threshold", &self.wedge_threshold)
            .field("unbounded_threshold", &self.unbounded_threshold)
            .field("heartbeat_stall", &self.heartbeat_stall)
            .field("max_replacements", &self.max_replacements)
            .finish_non_exhaustive()
    }
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(250),
            wedge_threshold: Duration::from_secs(5),
            unbounded_threshold: Duration::from_secs(300),
            heartbeat_stall: Duration::from_secs(1),
            on_wedge: None,
            max_replacements: 2,
        }
    }
}

/// How the pool is shaped.
///
/// Memory is per-runtime: `Runtime::set_memory_limit` bounds one interpreter,
/// so an N-worker pool costs N times the manifest's configured budget.
/// [`PoolStats::memory_budget_bytes`] reports the aggregate the pool believes
/// it is holding, abandoned workers included.
pub struct PoolConfig {
    /// Workers on the interactive lane.
    pub interactive: usize,
    /// Total workers across both lanes.
    pub workers: usize,
    /// Per-worker queue bound. The pool's queues are bounded even though a
    /// lone [`XriptHandle`]'s is not.
    pub queue_depth: usize,
    /// Long-lane policy. The interactive lane is always
    /// [`Saturation::Backpressure`].
    pub saturation: Saturation,
    pub router: Arc<dyn PoolRouter>,
    pub hook_dispatch: HookDispatch,
    /// Cap on live [`Route::Dedicated`] runtimes. Exceeding it falls back to
    /// the configured saturation policy rather than spawning threads without
    /// limit.
    pub max_dedicated: usize,
    pub health: HealthConfig,
    pub wedge_policy: WedgePolicy,
    /// How many mods may home on the interactive lane before further brief
    /// mods are placed on the long lane. Unlimited by default: a host that
    /// wants its interactive worker kept clear says so.
    pub interactive_mod_cap: usize,
    /// Spawn a fresh worker when one retires. Off by default: each
    /// replacement permanently costs the abandoned worker's memory budget, so
    /// a systematically-wedging binding would otherwise leak workers until the
    /// host runs out of memory.
    pub replace_wedged: bool,
}

impl std::fmt::Debug for PoolConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PoolConfig")
            .field("interactive", &self.interactive)
            .field("workers", &self.workers)
            .field("queue_depth", &self.queue_depth)
            .field("saturation", &self.saturation)
            .field("hook_dispatch", &self.hook_dispatch)
            .field("max_dedicated", &self.max_dedicated)
            .field("health", &self.health)
            .field("wedge_policy", &self.wedge_policy)
            .field("interactive_mod_cap", &self.interactive_mod_cap)
            .field("replace_wedged", &self.replace_wedged)
            .finish_non_exhaustive()
    }
}

impl Default for PoolConfig {
    fn default() -> Self {
        let parallelism = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2);
        Self {
            interactive: 1,
            workers: parallelism.saturating_sub(1).max(2),
            queue_depth: 64,
            saturation: Saturation::default(),
            router: Arc::new(IntentRouter),
            hook_dispatch: HookDispatch::default(),
            max_dedicated: 4,
            health: HealthConfig::default(),
            wedge_policy: WedgePolicy::default(),
            interactive_mod_cap: usize::MAX,
            replace_wedged: false,
        }
    }
}

/// What a call is, for a router's benefit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    Execute,
    InvokeExport,
    FireHook,
    Emit,
}

impl CallKind {
    fn as_str(self) -> &'static str {
        match self {
            CallKind::Execute => "Execute",
            CallKind::InvokeExport => "InvokeExport",
            CallKind::FireHook => "FireHook",
            CallKind::Emit => "Emit",
        }
    }
}

/// Everything a router knows about one call.
#[derive(Debug, Clone)]
pub struct CallDescriptor<'a> {
    pub kind: CallKind,
    pub mod_id: Option<&'a str>,
    /// Export name, hook id, or event name.
    pub target: Option<&'a str>,
    /// Resolved and widened per the manifest precedence rules.
    pub intent: ResolvedIntent,
    /// The mod's home worker, when the call names a mod.
    pub home: Option<WorkerId>,
}

/// Everything a router knows when choosing a mod's home.
#[derive(Debug, Clone)]
pub struct ModPlacement<'a> {
    pub mod_id: &'a str,
    /// The widen over every declared export and the mod-wide default.
    pub intent: ResolvedIntent,
}

/// A read-only view of the pool a router may consult.
pub struct PoolView<'a> {
    workers: &'a [Arc<Worker>],
    queue_depth: usize,
    interactive_mod_cap: usize,
}

impl PoolView<'_> {
    /// Every routable worker in a lane: healthy, not retired.
    pub fn lane(&self, lane: Lane) -> Vec<WorkerId> {
        self.workers
            .iter()
            .filter(|w| w.lane == lane && w.routable())
            .map(|w| w.id)
            .collect()
    }

    /// The routable worker in `lane` with the fewest queued calls.
    pub fn least_loaded(&self, lane: Lane) -> Option<WorkerId> {
        self.workers
            .iter()
            .filter(|w| w.lane == lane && w.routable())
            .min_by_key(|w| (w.depth(), w.id))
            .map(|w| w.id)
    }

    /// The routable worker in `lane` with the fewest mods homed on it, ties
    /// broken by queue depth then by id.
    pub fn least_homed(&self, lane: Lane) -> Option<WorkerId> {
        self.workers
            .iter()
            .filter(|w| w.lane == lane && w.routable())
            .min_by_key(|w| (w.homed_count(), w.depth(), w.id))
            .map(|w| w.id)
    }

    /// The configured per-worker queue bound.
    pub fn queue_depth(&self) -> usize {
        self.queue_depth
    }

    /// The configured interactive-lane mod cap.
    pub fn interactive_mod_cap(&self) -> usize {
        self.interactive_mod_cap
    }

    /// How many mods home on the interactive lane right now.
    pub fn interactive_mods(&self) -> usize {
        self.workers
            .iter()
            .filter(|w| w.lane == Lane::Interactive)
            .map(|w| w.homed_count())
            .sum()
    }

    /// True when every routable worker in the lane is at or past the
    /// configured bound, and true when the lane has no routable worker at all
    /// — both mean "there is nowhere here to put this".
    pub fn lane_saturated(&self, lane: Lane) -> bool {
        !self
            .workers
            .iter()
            .any(|w| w.lane == lane && w.routable() && w.depth() < self.queue_depth)
    }

    /// How many mods call `worker` home.
    pub fn homed_count(&self, worker: WorkerId) -> usize {
        self.workers
            .iter()
            .find(|w| w.id == worker)
            .map(|w| w.homed_count())
            .unwrap_or(0)
    }

    /// How many calls are queued on `worker`, the running one included.
    pub fn depth(&self, worker: WorkerId) -> usize {
        self.workers
            .iter()
            .find(|w| w.id == worker)
            .map(|w| w.depth())
            .unwrap_or(0)
    }
}

/// Where a call goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Interactive,
    Lane(Lane),
    Worker(WorkerId),
    /// A one-shot runtime built for this call and torn down after it.
    ///
    /// **Execute-only.** A dedicated runtime is built from the factory, gets
    /// the manifest and the host bindings, and has **no mods loaded** — so it
    /// cannot serve an `InvokeExport` (no mod), cannot serve a `FireHook` or
    /// `Emit` (no registered handlers), and never receives events. Mod state
    /// does not travel.
    Dedicated,
}

impl Route {
    fn as_str(self) -> &'static str {
        match self {
            Route::Interactive => "Interactive",
            Route::Lane(_) => "Lane",
            Route::Worker(_) => "Worker",
            Route::Dedicated => "Dedicated",
        }
    }
}

/// Host-implemented placement policy. [`IntentRouter`] is the default.
pub trait PoolRouter: Send + Sync {
    /// Where an execute or invoke call runs.
    ///
    /// Not consulted for hook or event fan-out. Those always target the home
    /// worker of each mod that registered a handler, so every handler runs
    /// exactly once; a router that could redirect them would break that. A
    /// [`Route`] returned for a hook is therefore neither honored nor
    /// rejected, because none is ever requested.
    fn route(&self, call: &CallDescriptor<'_>, pool: &PoolView<'_>) -> Route;

    /// The load-time home choice. Never called for
    /// [`XriptPool::load_mod_on`], which bypasses placement entirely.
    fn place(&self, placement: &ModPlacement<'_>, pool: &PoolView<'_>) -> WorkerId;

    /// Whether the interactive lane is already carrying its share of mods.
    /// Consulted by [`IntentRouter::place`]; a custom router may ignore it.
    fn interactive_full(&self, _pool: &PoolView<'_>) -> bool {
        false
    }

    /// Whether a [`Route::Dedicated`] this router returns for a mod-resident
    /// call should be silently clamped to the mod's home worker.
    ///
    /// False for every host-written router, and deliberately so: clamping our
    /// own default is fine, silently overriding a host's stated choice is not.
    /// A custom router that returns `Dedicated` for an `InvokeExport` gets
    /// [`XriptError::RouteUnsupported`].
    fn clamps_dedicated(&self) -> bool {
        false
    }
}

/// Routes on declared intent, with mod residency winning over everything.
pub struct IntentRouter;

impl PoolRouter for IntentRouter {
    fn route(&self, call: &CallDescriptor<'_>, pool: &PoolView<'_>) -> Route {
        // Rule 1, unconditional: a mod-resident call goes to the mod's home
        // worker. Intent does not override residency, which is why an
        // `affinity: isolated` export is clamped rather than sent to a
        // dedicated runtime with no mod state to work on.
        if call.kind != CallKind::Execute
            && let Some(home) = call.home
        {
            return Route::Worker(home);
        }
        if call.intent.affinity == IntentAffinity::Isolated {
            return Route::Dedicated;
        }
        match call.intent.duration {
            IntentDuration::Unbounded => {
                if pool.lane_saturated(Lane::Long) {
                    Route::Dedicated
                } else {
                    Route::Lane(Lane::Long)
                }
            }
            IntentDuration::Long => Route::Lane(Lane::Long),
            _ => Route::Interactive,
        }
    }

    fn place(&self, placement: &ModPlacement<'_>, pool: &PoolView<'_>) -> WorkerId {
        let long = placement.intent.duration >= IntentDuration::Long
            || placement.intent.affinity == IntentAffinity::Isolated;
        if long {
            if placement.intent.affinity == IntentAffinity::Isolated
                && let Some(empty) = pool
                    .lane(Lane::Long)
                    .into_iter()
                    .find(|id| pool.homed_count(*id) == 0)
            {
                return empty;
            }
            if let Some(id) = pool.least_homed(Lane::Long) {
                return id;
            }
        }
        if pool.interactive_mods() < pool.interactive_mod_cap()
            && let Some(id) = pool.least_homed(Lane::Interactive)
        {
            return id;
        }
        pool.least_homed(Lane::Long)
            .or_else(|| pool.least_homed(Lane::Interactive))
            .unwrap_or(WorkerId::Worker(0))
    }

    fn clamps_dedicated(&self) -> bool {
        true
    }
}

/// A mod, placed.
///
/// Singular `home`, singular `instance`. There is no fan-out and no
/// `instances` vector, and that is the point: see the module docs.
#[derive(Debug, Clone)]
pub struct PoolMod {
    pub mod_id: String,
    pub home: WorkerId,
    /// Pool-wide monotonic, assigned at load before placement. The primary key
    /// of pool-wide handler order.
    pub load_seq: u64,
    pub instance: ModInstance,
}

/// A worker the supervisor has marked unhealthy.
#[derive(Debug, Clone)]
pub struct WedgedWorker {
    pub id: WorkerId,
    pub since: Instant,
    pub in_flight: Option<CallInfo>,
    /// The host binding the thread is inside. This is the culprit.
    pub binding: Option<String>,
    pub stalled_ms: u64,
    /// Mods that are now unreachable, because their state lives here.
    pub homed_mods: Vec<String>,
}

/// What the pool is doing and what it has given up on.
#[derive(Debug, Clone)]
pub struct PoolStats {
    pub workers: usize,
    pub interactive: usize,
    pub long: usize,
    pub queued: usize,
    pub dedicated_live: usize,
    /// Times [`IntentRouter`] clamped an `affinity: isolated` mod-resident
    /// call to its home worker. Counted once per `(mod, target)` pair.
    pub route_clamps: usize,
    pub wedged: Vec<WedgedWorker>,
    pub retired: Vec<WorkerId>,
    /// The aggregate memory budget the pool believes it holds: the manifest's
    /// per-runtime limit times the number of live runtimes, abandoned ones
    /// included, because an abandoned runtime's memory is never returned.
    pub memory_budget_bytes: u64,
}

/// What shutting a pool down actually achieved.
#[derive(Debug, Clone)]
pub struct PoolShutdownReport {
    /// Workers that reached their stop command.
    pub joined: Vec<WorkerId>,
    /// Workers whose threads were left running. Their memory stays allocated
    /// until the process exits.
    pub abandoned: Vec<WorkerId>,
    pub leaked_bytes_estimate: u64,
    pub reports: Vec<(WorkerId, ShutdownReport)>,
}

/// Answers one queued call with an error the pool decided on.
///
/// The pool holds this rather than leaving the reply to the runtime thread,
/// because a wedged worker never reaches the queued command to skip it — the
/// token check that makes shedding free happens on *its* thread, at dequeue
/// time. Cancelling the token stops the call from ever running; this is what
/// makes the caller hear about it now.
type FailQueued = Arc<Mutex<Option<Box<dyn FnOnce(XriptError) + Send>>>>;

struct QueuedCall {
    token: CallToken,
    intent: ResolvedIntent,
    /// Set once, by whoever answers the call first.
    settled: Arc<AtomicBool>,
    fail: FailQueued,
}

struct Worker {
    id: WorkerId,
    lane: Lane,
    handle: XriptHandle,
    depth: AtomicUsize,
    queue: Mutex<VecDeque<QueuedCall>>,
    homed: Mutex<Vec<String>>,
    state: Mutex<WorkerState>,
    wedged: Mutex<Option<WedgedWorker>>,
    /// Last heartbeat the supervisor observed, and when it changed.
    beat: Mutex<(u64, Instant)>,
}

impl Worker {
    fn depth(&self) -> usize {
        self.depth.load(Ordering::SeqCst)
    }

    fn homed_count(&self) -> usize {
        self.homed.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    fn homed_mods(&self) -> Vec<String> {
        self.homed.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn state(&self) -> WorkerState {
        *self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set_state(&self, state: WorkerState) {
        *self.state.lock().unwrap_or_else(|p| p.into_inner()) = state;
    }

    fn routable(&self) -> bool {
        matches!(self.state(), WorkerState::Idle | WorkerState::Running)
    }

    /// The intent of the oldest queued call, which is the one in flight when
    /// the worker is running.
    fn front_intent(&self) -> Option<ResolvedIntent> {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .front()
            .map(|q| q.intent)
    }

    /// Cancels and answers the oldest queued call that is not the one already
    /// dispatched. Returns whether anything was shed.
    fn shed_oldest(&self) -> bool {
        self.answer_queued(1, |worker| XriptError::Shed {
            worker: worker.id.to_string(),
        }) > 0
    }

    /// Answers every call queued behind the running one.
    ///
    /// This is the one shedding path that works unconditionally. It does not
    /// need an interrupt, and — the part that is easy to get wrong — it does
    /// not need the runtime thread either: the pool replies itself, because a
    /// thread parked in a host binding will never dequeue the command it would
    /// otherwise have skipped.
    fn answer_queued(&self, limit: usize, error: impl Fn(&Worker) -> XriptError) -> usize {
        let running = self.handle.in_flight_tokens();
        let mut answered = 0;
        loop {
            if answered >= limit {
                break;
            }
            let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
            let Some(position) = queue.iter().position(|call| {
                !call.settled.load(Ordering::SeqCst)
                    && !running.iter().any(|r| r.same_call(&call.token))
            }) else {
                break;
            };
            let call = queue.remove(position).expect("position is in range");
            drop(queue);
            if call.settled.swap(true, Ordering::SeqCst) {
                continue;
            }
            self.depth.fetch_sub(1, Ordering::SeqCst);
            // Cancelled so it never runs if the thread ever comes back.
            call.token.cancel();
            if let Some(fail) = call.fail.lock().unwrap_or_else(|p| p.into_inner()).take() {
                fail(error(self));
            }
            answered += 1;
        }
        answered
    }

    fn wedged_error(&self) -> XriptError {
        let wedged = self.wedged.lock().unwrap_or_else(|p| p.into_inner()).clone();
        XriptError::WorkerWedged {
            worker: self.id.to_string(),
            stalled_ms: wedged.as_ref().map(|w| w.stalled_ms).unwrap_or(0),
            binding: wedged.as_ref().and_then(|w| w.binding.clone()),
            homed_mods: self.homed_mods(),
        }
    }
}

struct ModRecord {
    home: WorkerId,
    load_seq: u64,
    hooks: HashSet<String>,
    events: HashSet<String>,
    intent: ResolvedIntent,
    manifest: Option<ModManifest>,
    /// Which host slot each of the mod's exports fills, when it fills one.
    slot_of_export: HashMap<String, String>,
}

struct PoolInner {
    workers: Mutex<Vec<Arc<Worker>>>,
    manifest: Arc<Manifest>,
    manifest_json: String,
    factory: Arc<dyn Fn(WorkerId) -> RuntimeOptions + Send + Sync>,
    config: PoolConfig,
    mods: Mutex<HashMap<String, ModRecord>>,
    load_seq: AtomicU64,
    dedicated_seq: AtomicU64,
    dedicated_live: AtomicUsize,
    route_clamps: Mutex<HashSet<(String, String)>>,
    replacements: AtomicUsize,
    next_worker_index: AtomicUsize,
    supervisor_stop: Arc<AtomicBool>,
}

/// A router over N handles.
pub struct XriptPool {
    inner: Arc<PoolInner>,
    supervisor: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// A borrowed pool worker. Derefs to the [`XriptHandle`] behind it, so
/// everything the handle offers is reachable when the host knows better than
/// the router.
pub struct WorkerRef {
    worker: Arc<Worker>,
}

impl std::ops::Deref for WorkerRef {
    type Target = XriptHandle;

    fn deref(&self) -> &Self::Target {
        &self.worker.handle
    }
}

fn placeholder_manifest() -> Manifest {
    serde_json::from_str(r#"{ "xript": "0", "name": "" }"#)
        .expect("the placeholder manifest is well-formed")
}

/// Wraps a worker's audit sink so every record carries the worker that raised
/// it and that worker's own monotonic sequence.
fn stamp_audit(options: &mut RuntimeOptions, worker: WorkerId, seq: Arc<AtomicU64>) {
    let inner = options.audit.take();
    let index = match worker {
        WorkerId::Worker(n) => n,
        WorkerId::Dedicated(n) => usize::MAX - (n as usize),
    };
    let stamped: AuditSink = Arc::new(move |mut event: AuditEvent| {
        event.worker = Some(index);
        event.seq = seq.fetch_add(1, Ordering::Relaxed);
        if let Some(ref inner) = inner {
            inner(event);
        }
    });
    options.audit = Some(stamped);
}

fn build_worker(
    inner_manifest_json: &str,
    factory: &Arc<dyn Fn(WorkerId) -> RuntimeOptions + Send + Sync>,
    id: WorkerId,
    lane: Lane,
) -> (Arc<Worker>, Pending<()>) {
    let mut options = factory(id);
    stamp_audit(&mut options, id, Arc::new(AtomicU64::new(0)));
    let (handle, ready) = XriptHandle::spawn(inner_manifest_json.to_string(), options);
    (
        Arc::new(Worker {
            id,
            lane,
            handle,
            depth: AtomicUsize::new(0),
            queue: Mutex::new(VecDeque::new()),
            homed: Mutex::new(Vec::new()),
            state: Mutex::new(WorkerState::Idle),
            wedged: Mutex::new(None),
            beat: Mutex::new((0, Instant::now())),
        }),
        ready,
    )
}

impl XriptPool {
    /// Starts every worker and returns immediately. The returned `Pending`
    /// completes when all of them have finished constructing, or fails with
    /// the first construction error.
    ///
    /// `factory` is called once per worker. A factory rather than one
    /// [`RuntimeOptions`] because `RuntimeOptions`, `HostBindings` and
    /// `ConsoleHandler` are deliberately not `Clone` — and, more importantly,
    /// because per-worker construction is what keeps each worker's library
    /// registry its own. Sharing one registry would let one worker's open load
    /// phase authorize another worker's concurrent dynamic `import(..)`, which
    /// is a capability-gating hole rather than an optimization.
    ///
    /// **Every host binding the factory registers will be invoked concurrently
    /// from multiple worker threads and must be reentrant and thread-safe.**
    /// xript does not serialize calls into host code; a binding that requires
    /// serialization must implement it itself, and must not do so with a lock
    /// an interactive-lane call can contend against.
    pub fn spawn<F>(manifest_json: String, factory: F, config: PoolConfig) -> (Self, Pending<()>)
    where
        F: Fn(WorkerId) -> RuntimeOptions + Send + Sync + 'static,
    {
        let factory: Arc<dyn Fn(WorkerId) -> RuntimeOptions + Send + Sync> = Arc::new(factory);
        let manifest = Arc::new(
            serde_json::from_str::<Manifest>(&manifest_json)
                .unwrap_or_else(|_| placeholder_manifest()),
        );

        let total = config.workers.max(1);
        let interactive = config.interactive.clamp(1, total);

        let mut workers = Vec::with_capacity(total);
        let mut readies = Vec::with_capacity(total);
        for index in 0..total {
            let lane = if index < interactive {
                Lane::Interactive
            } else {
                Lane::Long
            };
            let (worker, ready) =
                build_worker(&manifest_json, &factory, WorkerId::Worker(index), lane);
            workers.push(worker);
            readies.push(ready);
        }

        let inner = Arc::new(PoolInner {
            workers: Mutex::new(workers),
            manifest,
            manifest_json,
            factory,
            config,
            mods: Mutex::new(HashMap::new()),
            load_seq: AtomicU64::new(0),
            dedicated_seq: AtomicU64::new(0),
            dedicated_live: AtomicUsize::new(0),
            route_clamps: Mutex::new(HashSet::new()),
            replacements: AtomicUsize::new(0),
            next_worker_index: AtomicUsize::new(total),
            supervisor_stop: Arc::new(AtomicBool::new(false)),
        });

        let supervisor = spawn_supervisor(&inner);
        let ready = join_pendings(readies);
        (
            Self {
                inner,
                supervisor: Mutex::new(Some(supervisor)),
            },
            ready,
        )
    }

    /// The host manifest every worker was built from. Synchronous.
    pub fn manifest(&self) -> Arc<Manifest> {
        self.inner.manifest.clone()
    }

    /// One worker, or `None` when it has been retired.
    pub fn on(&self, worker: WorkerId) -> Option<WorkerRef> {
        let workers = self.inner.workers.lock().unwrap_or_else(|p| p.into_inner());
        workers
            .iter()
            .find(|w| w.id == worker && w.state() != WorkerState::Retired)
            .map(|w| WorkerRef { worker: w.clone() })
    }

    /// The least-loaded interactive-lane worker.
    pub fn interactive(&self) -> WorkerRef {
        let id = self
            .inner
            .view(|view| view.least_loaded(Lane::Interactive))
            .unwrap_or(WorkerId::Worker(0));
        let workers = self.inner.workers.lock().unwrap_or_else(|p| p.into_inner());
        let worker = workers
            .iter()
            .find(|w| w.id == id)
            .cloned()
            .unwrap_or_else(|| workers[0].clone());
        WorkerRef { worker }
    }

    // -- work ---------------------------------------------------------------

    /// Evaluates code on a routed worker.
    ///
    /// Routed on the host manifest's own declared intent. Use
    /// [`execute_with`](Self::execute_with) when the host knows the cost of
    /// this particular script.
    pub fn execute(&self, code: &str) -> Pending<ExecutionResult> {
        let intent = self.inner.manifest.execution.unwrap_or_default().resolved();
        self.execute_with(code, intent)
    }

    /// [`execute`](Self::execute) with a call-site intent, which wins outright
    /// and is not widened against anything.
    pub fn execute_with(&self, code: &str, intent: ResolvedIntent) -> Pending<ExecutionResult> {
        self.inner.execute_with(code, intent)
    }

    /// Invokes an export on the mod's home worker.
    ///
    /// Always the home worker: mod state does not travel, and a call that ran
    /// anywhere else would be a call into a different mod.
    pub fn invoke_export(
        &self,
        mod_id: &str,
        export: &str,
        args: &[serde_json::Value],
    ) -> Pending<serde_json::Value> {
        self.inner.invoke_export(mod_id, export, args)
    }

    /// Fires a hook on every worker that hosts a handler for it, and merges
    /// the segments back into single-runtime order.
    ///
    /// Pool-wide handler order is `(mod.load_seq, intra-mod registration
    /// index)`. That reproduces single-runtime order exactly: on one runtime
    /// the same two keys sort the same way, and a mod's handlers are
    /// contiguous under both because a mod's handlers all live on one worker.
    /// **The merge is deterministic regardless of which worker replies
    /// first.**
    pub fn fire_hook(
        &self,
        hook: &str,
        payload: &[serde_json::Value],
    ) -> Pending<Vec<serde_json::Value>> {
        self.inner.fan_out(FanKind::Hook, hook, payload)
    }

    /// The event mirror of [`fire_hook`](Self::fire_hook), same ordering
    /// contract.
    pub fn emit(
        &self,
        event: &str,
        payload: &[serde_json::Value],
    ) -> Pending<Vec<serde_json::Value>> {
        self.inner.fan_out(FanKind::Event, event, payload)
    }

    // -- mod residency ------------------------------------------------------

    /// Loads a mod onto exactly one worker, chosen by [`PoolRouter::place`]
    /// from the mod's aggregate declared intent.
    ///
    /// A mod that declares a `long` export never homes on the interactive
    /// lane. That placement is the main thing declared intent buys, because
    /// once a mod is placed, every call into it goes to its home regardless.
    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Pending<PoolMod> {
        let intent = serde_json::from_str::<ModManifest>(mod_manifest_json)
            .map(|m| m.aggregate_execution())
            .unwrap_or_default();
        let mod_id = serde_json::from_str::<ModManifest>(mod_manifest_json)
            .map(|m| m.name)
            .unwrap_or_default();
        let placement = ModPlacement {
            mod_id: &mod_id,
            intent,
        };
        let home = self
            .inner
            .view(|view| self.inner.config.router.place(&placement, view));
        self.load_mod_on(
            home,
            mod_manifest_json,
            fragment_sources,
            granted_capabilities,
            entry_source,
        )
    }

    /// [`load_mod`](Self::load_mod) with the home worker chosen by the host.
    /// Bypasses [`PoolRouter::place`] entirely.
    pub fn load_mod_on(
        &self,
        home: WorkerId,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Pending<PoolMod> {
        self.inner.load_mod_on(
            home,
            mod_manifest_json,
            fragment_sources,
            granted_capabilities,
            entry_source,
        )
    }

    /// The worker a mod lives on. Still answers for a retired worker's mods,
    /// so a host can tell "unreachable" from "never loaded".
    pub fn home_of(&self, mod_id: &str) -> Option<WorkerId> {
        self.inner
            .mods
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(mod_id)
            .map(|record| record.home)
    }

    // -- health and teardown ------------------------------------------------

    pub fn stats(&self) -> PoolStats {
        self.inner.stats()
    }

    /// Removes a worker from routing forever and **abandons its thread**.
    ///
    /// There is no reclamation and this method does not pretend otherwise. A
    /// wedged thread is blocked in host code that owns unknown resources;
    /// unwinding it is not possible in safe Rust and would not be safe in
    /// unsafe Rust either. The runtime's memory stays allocated until the
    /// process exits, mods homed here become unreachable, and
    /// [`shutdown`](Self::shutdown) will not wait for it.
    pub fn retire_worker(&self, worker: WorkerId) -> Pending<()> {
        self.inner.retire_worker(worker)
    }

    /// Stops every worker that can be stopped and reports what was left
    /// behind.
    pub fn shutdown(&self) -> Pending<PoolShutdownReport> {
        self.inner.supervisor_stop.store(true, Ordering::SeqCst);
        self.inner.shutdown()
    }
}

impl Drop for XriptPool {
    fn drop(&mut self) {
        self.inner.supervisor_stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self
            .supervisor
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            let _ = handle.join();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FanKind {
    Hook,
    Event,
}

impl PoolInner {
    fn view<T>(&self, f: impl FnOnce(&PoolView<'_>) -> T) -> T {
        let workers = self.workers.lock().unwrap_or_else(|p| p.into_inner());
        f(&PoolView {
            workers: &workers,
            queue_depth: self.config.queue_depth,
            interactive_mod_cap: self.config.interactive_mod_cap,
        })
    }

    fn worker(&self, id: WorkerId) -> Option<Arc<Worker>> {
        self.workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|w| w.id == id)
            .cloned()
    }

    fn resolve_route(&self, route: Route) -> Option<WorkerId> {
        self.view(|view| match route {
            Route::Worker(id) => Some(id),
            Route::Interactive => view
                .least_loaded(Lane::Interactive)
                .or_else(|| view.least_loaded(Lane::Long)),
            Route::Lane(lane) => view
                .least_loaded(lane)
                .or_else(|| view.least_loaded(Lane::Interactive))
                .or_else(|| view.least_loaded(Lane::Long)),
            Route::Dedicated => None,
        })
    }

    /// The resolved intent of a call into one mod's export, per the manifest
    /// precedence rules: the host side (the slot the export fills, else the
    /// host manifest default) widened against the mod's own claim. Neither
    /// party can weaken the other.
    fn call_intent(&self, mod_id: &str, export: &str) -> ResolvedIntent {
        let mods = self.mods.lock().unwrap_or_else(|p| p.into_inner());
        let host_default = self.manifest.execution.unwrap_or_default().resolved();
        let Some(record) = mods.get(mod_id) else {
            return host_default;
        };
        let host_side = match record.slot_of_export.get(export) {
            Some(slot) => self.manifest.execution_of(&format!("slots/{slot}")),
            None => host_default,
        };
        let mod_side = match record.manifest {
            Some(ref manifest) => manifest.execution_of(&format!("exports/{export}")),
            None => record.intent,
        };
        ResolvedIntent::widen(host_side, mod_side)
    }

    fn execute_with(
        self: &Arc<Self>,
        code: &str,
        intent: ResolvedIntent,
    ) -> Pending<ExecutionResult> {
        let descriptor = CallDescriptor {
            kind: CallKind::Execute,
            mod_id: None,
            target: None,
            intent,
            home: None,
        };
        let route = self.view(|view| self.config.router.route(&descriptor, view));
        if route == Route::Dedicated {
            return self.execute_dedicated(code, intent);
        }
        let Some(id) = self.resolve_route(route) else {
            return self.execute_dedicated(code, intent);
        };
        let Some(worker) = self.worker(id) else {
            return self.execute_dedicated(code, intent);
        };
        let code = code.to_string();
        self.dispatch(&worker, intent, move |handle| handle.execute(&code))
    }

    fn invoke_export(
        self: &Arc<Self>,
        mod_id: &str,
        export: &str,
        args: &[serde_json::Value],
    ) -> Pending<serde_json::Value> {
        let Some(home) = self
            .mods
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(mod_id)
            .map(|record| record.home)
        else {
            return Pending::ready(Err(XriptError::UnknownMod {
                mod_id: mod_id.to_string(),
            }));
        };
        let intent = self.call_intent(mod_id, export);
        let descriptor = CallDescriptor {
            kind: CallKind::InvokeExport,
            mod_id: Some(mod_id),
            target: Some(export),
            intent,
            home: Some(home),
        };
        let route = self.view(|view| self.config.router.route(&descriptor, view));
        let target = match self.mod_resident_route(route, CallKind::InvokeExport, mod_id, export, home)
        {
            Ok(id) => id,
            Err(e) => return Pending::ready(Err(e)),
        };
        let Some(worker) = self.worker(target) else {
            return Pending::ready(Err(XriptError::UnknownMod {
                mod_id: mod_id.to_string(),
            }));
        };
        let mod_id = mod_id.to_string();
        let export = export.to_string();
        let args = args.to_vec();
        self.dispatch(&worker, intent, move |handle| {
            handle.invoke_mod_export(&mod_id, &export, &args)
        })
    }

    /// Applies the execute-only rule to a mod-resident route.
    ///
    /// [`IntentRouter`] never lands here with `Dedicated` — its first rule
    /// fires first — so an `affinity: isolated` export is *clamped* to home
    /// and the clamp is recorded once per `(mod, target)`. A custom router
    /// that returns `Dedicated` explicitly gets a loud error instead.
    fn mod_resident_route(
        &self,
        route: Route,
        kind: CallKind,
        mod_id: &str,
        target: &str,
        home: WorkerId,
    ) -> Result<WorkerId> {
        if route != Route::Dedicated {
            return self
                .resolve_route(route)
                .ok_or_else(|| XriptError::UnknownMod {
                    mod_id: mod_id.to_string(),
                });
        }
        if self.config.router.clamps_dedicated() {
            self.route_clamps
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert((mod_id.to_string(), target.to_string()));
            return Ok(home);
        }
        Err(XriptError::RouteUnsupported {
            kind: kind.as_str(),
            route: route.as_str(),
            target: format!("{mod_id}::{target}"),
            home: home.to_string(),
        })
    }

    // -- dispatch -----------------------------------------------------------

    /// Enqueues one call on one worker, applying saturation and wedge policy,
    /// and tracking the queue so shedding and quarantine have something to
    /// act on.
    fn dispatch<T: Send + 'static>(
        self: &Arc<Self>,
        worker: &Arc<Worker>,
        intent: ResolvedIntent,
        build: impl FnOnce(&XriptHandle) -> Pending<T>,
    ) -> Pending<T> {
        if worker.state() == WorkerState::Unhealthy
            && self.config.wedge_policy == WedgePolicy::FailFast
        {
            return Pending::ready(Err(worker.wedged_error()));
        }

        // The interactive lane is always Backpressure: shedding a UI event is
        // worse than waiting for it, and rejecting one is worse still.
        let policy = if worker.lane == Lane::Interactive {
            Saturation::Backpressure
        } else {
            self.config.saturation
        };
        if worker.depth() >= self.config.queue_depth {
            match policy {
                Saturation::Reject => {
                    return Pending::ready(Err(XriptError::Saturated {
                        lane: worker.lane.as_str(),
                        worker: worker.id.to_string(),
                        depth: worker.depth(),
                        limit: self.config.queue_depth,
                    }))
                }
                Saturation::ShedOldest => {
                    worker.shed_oldest();
                }
                Saturation::Backpressure => {}
            }
        }

        let inner = build(&worker.handle);
        let token = inner.token();
        let (completer, pending) = Pending::<T>::new(token.clone());

        // The completer is shared between the runtime thread's reply and the
        // pool's own shedding path, and exactly one of them gets to use it.
        let holder = Arc::new(Mutex::new(Some(completer)));
        let settled = Arc::new(AtomicBool::new(false));
        let fail: FailQueued = {
            let holder = holder.clone();
            Arc::new(Mutex::new(Some(Box::new(move |error: XriptError| {
                if let Some(completer) =
                    holder.lock().unwrap_or_else(|p| p.into_inner()).take()
                {
                    completer.complete(Err(error));
                }
            }) as Box<dyn FnOnce(XriptError) + Send>)))
        };

        worker.depth.fetch_add(1, Ordering::SeqCst);
        worker
            .queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push_back(QueuedCall {
                token: token.clone(),
                intent,
                settled: settled.clone(),
                fail,
            });

        let worker = worker.clone();
        inner.on_complete(move |result| {
            if !settled.swap(true, Ordering::SeqCst) {
                worker.depth.fetch_sub(1, Ordering::SeqCst);
                worker
                    .queue
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .retain(|call| !call.token.same_call(&token));
            }
            if let Some(completer) = holder.lock().unwrap_or_else(|p| p.into_inner()).take() {
                completer.complete(result);
            }
        });
        pending
    }

    /// Builds a one-shot runtime, runs one `execute` on it, and tears it down.
    fn execute_dedicated(
        self: &Arc<Self>,
        code: &str,
        intent: ResolvedIntent,
    ) -> Pending<ExecutionResult> {
        if self.dedicated_live.load(Ordering::SeqCst) >= self.config.max_dedicated {
            // Falling back rather than spawning threads without limit. The
            // long lane's own policy decides what "full" means from here.
            let fallback = self.resolve_route(Route::Lane(Lane::Long));
            if let Some(id) = fallback
                && let Some(worker) = self.worker(id)
            {
                let code = code.to_string();
                return self.dispatch(&worker, intent, move |handle| handle.execute(&code));
            }
            return Pending::ready(Err(XriptError::Saturated {
                lane: Lane::Long.as_str(),
                worker: "dedicated".into(),
                depth: self.dedicated_live.load(Ordering::SeqCst),
                limit: self.config.max_dedicated,
            }));
        }

        let seq = self.dedicated_seq.fetch_add(1, Ordering::SeqCst);
        let id = WorkerId::Dedicated(seq);
        let mut options = (self.factory)(id);
        stamp_audit(&mut options, id, Arc::new(AtomicU64::new(0)));
        let (handle, ready) = XriptHandle::spawn(self.manifest_json.clone(), options);
        ready.detach();
        self.dedicated_live.fetch_add(1, Ordering::SeqCst);

        let inner = handle.execute(code);
        let (completer, pending) = Pending::<ExecutionResult>::new(inner.token());
        let live = self.clone();
        inner.on_complete(move |result| {
            live.dedicated_live.fetch_sub(1, Ordering::SeqCst);
            // Dropping the handle detaches its thread, which then reaches the
            // stop command it was just sent.
            drop(handle);
            completer.complete(result);
        });
        pending
    }

    // -- mod residency ------------------------------------------------------

    fn load_mod_on(
        self: &Arc<Self>,
        home: WorkerId,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Pending<PoolMod> {
        let parsed: Option<ModManifest> = serde_json::from_str(mod_manifest_json).ok();
        let intent = parsed
            .as_ref()
            .map(|m| m.aggregate_execution())
            .unwrap_or_default();
        let slot_of_export = slot_of_export(mod_manifest_json);
        // Assigned before placement, so pool-wide handler order is load order
        // exactly as it is on a single runtime.
        let load_seq = self.load_seq.fetch_add(1, Ordering::SeqCst);

        let Some(worker) = self.worker(home) else {
            return Pending::ready(Err(XriptError::Engine(format!(
                "worker {home} is not part of this pool"
            ))));
        };

        let mod_manifest_json = mod_manifest_json.to_string();
        let granted = granted_capabilities.clone();
        let entry_source = entry_source.map(|s| s.to_string());
        let inner = self.dispatch(&worker, intent, move |handle| {
            handle.load_mod(
                &mod_manifest_json,
                fragment_sources,
                &granted,
                entry_source.as_deref(),
            )
        });

        let (completer, pending) = Pending::<PoolMod>::new(inner.token());
        let pool = self.clone();
        let worker_for_index = worker.clone();
        inner.on_complete(move |result| {
            let instance = match result {
                Ok(instance) => instance,
                Err(e) => return completer.complete(Err(e)),
            };
            let mod_id = instance.name.clone();
            // Which hooks and events this mod's handlers answer to, so a
            // fan-out only reaches the workers that host one. Chained rather
            // than waited on: this callback runs *on* the worker's runtime
            // thread, so blocking here for a command that thread has yet to
            // dequeue would deadlock it against itself.
            let follow = worker_for_index.handle.handler_index_for(&mod_id);
            follow.on_complete(move |index| {
                let index = index.unwrap_or_default();
                worker_for_index
                    .homed
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(mod_id.clone());
                pool.mods.lock().unwrap_or_else(|p| p.into_inner()).insert(
                    mod_id.clone(),
                    ModRecord {
                        home,
                        load_seq,
                        hooks: index.hooks.into_iter().collect(),
                        events: index.events.into_iter().collect(),
                        intent,
                        manifest: parsed,
                        slot_of_export,
                    },
                );
                completer.complete(Ok(PoolMod {
                    mod_id,
                    home,
                    load_seq,
                    instance,
                }));
            });
        });
        pending
    }

    // -- fan-out ------------------------------------------------------------

    fn fan_out(
        self: &Arc<Self>,
        kind: FanKind,
        id: &str,
        payload: &[serde_json::Value],
    ) -> Pending<Vec<serde_json::Value>> {
        let mut seq_of: HashMap<String, u64> = HashMap::new();
        let mut earliest: HashMap<WorkerId, u64> = HashMap::new();
        let mut intent = match kind {
            FanKind::Hook => self.manifest.execution_of(&format!("hooks/{id}")),
            FanKind::Event => self.manifest.execution.unwrap_or_default().resolved(),
        };
        {
            let mods = self.mods.lock().unwrap_or_else(|p| p.into_inner());
            for (mod_id, record) in mods.iter() {
                let hosts = match kind {
                    FanKind::Hook => record.hooks.contains(id),
                    FanKind::Event => record.events.contains(id),
                };
                if !hosts {
                    continue;
                }
                seq_of.insert(mod_id.clone(), record.load_seq);
                intent = ResolvedIntent::widen(intent, record.intent);
                let entry = earliest.entry(record.home).or_insert(record.load_seq);
                *entry = (*entry).min(record.load_seq);
            }
        }
        let mut targets: Vec<(WorkerId, u64)> = earliest.into_iter().collect();
        // Dispatch order is load order, which only matters under
        // `HookDispatch::Sequential` — the merge is order-independent either
        // way.
        targets.sort_by_key(|(worker, seq)| (*seq, *worker));

        if targets.is_empty() {
            return Pending::ready(Ok(Vec::new()));
        }

        let id = id.to_string();
        let payload = payload.to_vec();
        match self.config.hook_dispatch {
            HookDispatch::Concurrent => {
                self.fan_out_concurrent(kind, id, payload, targets, seq_of, intent)
            }
            HookDispatch::Sequential => {
                let (completer, pending) =
                    Pending::<Vec<serde_json::Value>>::new(CallToken::new());
                self.fan_out_step(
                    kind,
                    Arc::new(FanState {
                        id,
                        payload,
                        targets,
                        seq_of,
                        intent,
                        collected: Mutex::new(Vec::new()),
                    }),
                    0,
                    completer,
                );
                pending
            }
        }
    }

    fn fan_out_concurrent(
        self: &Arc<Self>,
        kind: FanKind,
        id: String,
        payload: Vec<serde_json::Value>,
        targets: Vec<(WorkerId, u64)>,
        seq_of: HashMap<String, u64>,
        intent: ResolvedIntent,
    ) -> Pending<Vec<serde_json::Value>> {
        let (completer, pending) = Pending::<Vec<serde_json::Value>>::new(CallToken::new());
        let total = targets.len();
        let segments: Segments = Arc::new(Mutex::new((0..total).map(|_| None).collect()));
        let remaining = Arc::new(AtomicUsize::new(total));
        let completer = Arc::new(Mutex::new(Some(completer)));
        let seq_of = Arc::new(seq_of);

        for (slot, (worker_id, _)) in targets.into_iter().enumerate() {
            let Some(worker) = self.worker(worker_id) else {
                continue;
            };
            let call_id = id.clone();
            let call_payload = payload.clone();
            let inner = self.dispatch(&worker, intent, move |handle| match kind {
                FanKind::Hook => handle.fire_hook_tagged(&call_id, &call_payload),
                FanKind::Event => handle.emit_tagged(&call_id, &call_payload),
            });
            let segments = segments.clone();
            let remaining = remaining.clone();
            let completer = completer.clone();
            let seq_of = seq_of.clone();
            inner.on_complete(move |result| {
                segments.lock().unwrap_or_else(|p| p.into_inner())[slot] = Some(result);
                if remaining.fetch_sub(1, Ordering::SeqCst) != 1 {
                    return;
                }
                let taken =
                    std::mem::take(&mut *segments.lock().unwrap_or_else(|p| p.into_inner()));
                let merged = merge_segments(taken, &seq_of);
                if let Some(completer) =
                    completer.lock().unwrap_or_else(|p| p.into_inner()).take()
                {
                    completer.complete(merged);
                }
            });
        }

        pending
    }

    /// One worker-group at a time, each dispatched from the previous one's
    /// completion. Restores cross-worker happens-before.
    fn fan_out_step(
        self: &Arc<Self>,
        kind: FanKind,
        state: Arc<FanState>,
        at: usize,
        completer: Completer<Vec<serde_json::Value>>,
    ) {
        if at >= state.targets.len() {
            let taken =
                std::mem::take(&mut *state.collected.lock().unwrap_or_else(|p| p.into_inner()));
            completer.complete(merge_segments(taken, &state.seq_of));
            return;
        }
        let Some(worker) = self.worker(state.targets[at].0) else {
            return self.fan_out_step(kind, state, at + 1, completer);
        };
        let call_id = state.id.clone();
        let call_payload = state.payload.clone();
        let inner = self.dispatch(&worker, state.intent, move |handle| match kind {
            FanKind::Hook => handle.fire_hook_tagged(&call_id, &call_payload),
            FanKind::Event => handle.emit_tagged(&call_id, &call_payload),
        });
        let pool = self.clone();
        let completer = Mutex::new(Some(completer));
        inner.on_complete(move |result| {
            state
                .collected
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(Some(result));
            if let Some(completer) = completer.lock().unwrap_or_else(|p| p.into_inner()).take() {
                pool.fan_out_step(kind, state.clone(), at + 1, completer);
            }
        });
    }

    // -- health -------------------------------------------------------------

    fn stats(&self) -> PoolStats {
        let workers = self.workers.lock().unwrap_or_else(|p| p.into_inner());
        let per_runtime_bytes = self
            .manifest
            .limits
            .as_ref()
            .and_then(|l| l.memory_mb)
            .unwrap_or(0)
            * 1024
            * 1024;
        PoolStats {
            workers: workers.len(),
            interactive: workers.iter().filter(|w| w.lane == Lane::Interactive).count(),
            long: workers.iter().filter(|w| w.lane == Lane::Long).count(),
            queued: workers.iter().map(|w| w.depth()).sum(),
            dedicated_live: self.dedicated_live.load(Ordering::SeqCst),
            route_clamps: self
                .route_clamps
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .len(),
            wedged: workers
                .iter()
                .filter_map(|w| w.wedged.lock().unwrap_or_else(|p| p.into_inner()).clone())
                .collect(),
            retired: workers
                .iter()
                .filter(|w| w.state() == WorkerState::Retired)
                .map(|w| w.id)
                .collect(),
            memory_budget_bytes: per_runtime_bytes
                * (workers.len() as u64 + self.dedicated_live.load(Ordering::SeqCst) as u64),
        }
    }

    fn retire_worker(self: &Arc<Self>, id: WorkerId) -> Pending<()> {
        let Some(worker) = self.worker(id) else {
            return Pending::ready(Ok(()));
        };
        worker.set_state(WorkerState::Retired);
        worker.handle.mark_retired();
        worker.answer_queued(usize::MAX, |w| w.wedged_error());

        if self.config.replace_wedged
            && self.replacements.load(Ordering::SeqCst) < self.config.health.max_replacements
        {
            self.replacements.fetch_add(1, Ordering::SeqCst);
            let index = self.next_worker_index.fetch_add(1, Ordering::SeqCst);
            let (replacement, ready) = build_worker(
                &self.manifest_json,
                &self.factory,
                WorkerId::Worker(index),
                worker.lane,
            );
            ready.detach();
            self.workers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(replacement);
        }
        Pending::ready(Ok(()))
    }

    fn shutdown(self: &Arc<Self>) -> Pending<PoolShutdownReport> {
        let workers: Vec<Arc<Worker>> = self
            .workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let per_runtime_bytes = self
            .manifest
            .limits
            .as_ref()
            .and_then(|l| l.memory_mb)
            .unwrap_or(0)
            * 1024
            * 1024;

        let mut abandoned = Vec::new();
        let mut waiting = Vec::new();
        for worker in workers {
            // A wedged or retired worker's thread is inside host code. Asking
            // it to stop is free; waiting for it would never return, so the
            // report says abandoned instead of hanging.
            if matches!(worker.state(), WorkerState::Unhealthy | WorkerState::Retired) {
                worker.handle.shutdown().detach();
                abandoned.push(worker.id);
                continue;
            }
            waiting.push((worker.id, worker.handle.shutdown()));
        }

        let (completer, pending) = Pending::<PoolShutdownReport>::new(CallToken::new());
        let total = waiting.len();
        let collected: Arc<Mutex<Vec<(WorkerId, ShutdownReport)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let remaining = Arc::new(AtomicUsize::new(total));
        let completer = Arc::new(Mutex::new(Some(completer)));
        let abandoned = Arc::new(Mutex::new(abandoned));

        if total == 0 {
            let abandoned = abandoned.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let leaked = per_runtime_bytes * abandoned.len() as u64;
            if let Some(completer) = completer.lock().unwrap_or_else(|p| p.into_inner()).take() {
                completer.complete(Ok(PoolShutdownReport {
                    joined: Vec::new(),
                    abandoned,
                    leaked_bytes_estimate: leaked,
                    reports: Vec::new(),
                }));
            }
            return pending;
        }

        for (id, inner) in waiting {
            let collected = collected.clone();
            let remaining = remaining.clone();
            let completer = completer.clone();
            let abandoned = abandoned.clone();
            inner.on_complete(move |result| {
                match result {
                    Ok(report) => collected
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push((id, report)),
                    Err(_) => abandoned
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(id),
                }
                if remaining.fetch_sub(1, Ordering::SeqCst) != 1 {
                    return;
                }
                let reports = std::mem::take(
                    &mut *collected.lock().unwrap_or_else(|p| p.into_inner()),
                );
                let abandoned = abandoned.lock().unwrap_or_else(|p| p.into_inner()).clone();
                let leaked = per_runtime_bytes * abandoned.len() as u64;
                if let Some(completer) =
                    completer.lock().unwrap_or_else(|p| p.into_inner()).take()
                {
                    completer.complete(Ok(PoolShutdownReport {
                        joined: reports.iter().map(|(id, _)| *id).collect(),
                        abandoned,
                        leaked_bytes_estimate: leaked,
                        reports,
                    }));
                }
            });
        }

        pending
    }
}

struct FanState {
    id: String,
    payload: Vec<serde_json::Value>,
    targets: Vec<(WorkerId, u64)>,
    seq_of: HashMap<String, u64>,
    intent: ResolvedIntent,
    collected: Mutex<Vec<Option<Result<Vec<TaggedResult>>>>>,
}

/// Samples every worker and marks the ones that are wedged.
///
/// Two conditions, both required: an in-flight call older than the threshold
/// for its declared intent, **and** a heartbeat that has not advanced. The
/// heartbeat is bumped by the interrupt handler, which fires only while
/// bytecode runs, so a script legitimately grinding for a minute keeps ticking
/// and is never marked wedged. Only a thread parked inside host code stalls it.
/// On a yielding worker a call awaiting an async binding stalls the heartbeat
/// without occupying the thread, so there a third condition applies: the
/// thread must actually be inside a sync binding.
fn spawn_supervisor(inner: &Arc<PoolInner>) -> std::thread::JoinHandle<()> {
    let weak: Weak<PoolInner> = Arc::downgrade(inner);
    let stop = inner.supervisor_stop.clone();
    let interval = inner.config.health.interval;
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(interval);
            let Some(inner) = weak.upgrade() else { break };
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let workers: Vec<Arc<Worker>> = inner
                .workers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            for worker in workers {
                if matches!(worker.state(), WorkerState::Retired) {
                    continue;
                }
                let health = worker.handle.health();
                let mut beat = worker.beat.lock().unwrap_or_else(|p| p.into_inner());
                if health.heartbeat != beat.0 {
                    *beat = (health.heartbeat, Instant::now());
                }
                let stalled_for = beat.1.elapsed();
                drop(beat);

                let Some(ref call) = health.in_flight else {
                    if worker.state() == WorkerState::Unhealthy {
                        continue;
                    }
                    worker.set_state(WorkerState::Idle);
                    continue;
                };

                let intent = worker.front_intent().unwrap_or_default();
                let threshold = if intent.duration == IntentDuration::Unbounded {
                    inner.config.health.unbounded_threshold
                } else {
                    inner.config.health.wedge_threshold
                };
                let running_for = call.dispatched_at.elapsed();

                // A yielding worker parked on an async binding runs no
                // bytecode and holds no thread, so its stalled heartbeat
                // means nothing unless the thread is inside a sync binding.
                let parked_not_stuck =
                    worker.handle.probe().yielding() && health.current_binding.is_none();
                let wedged = running_for >= threshold
                    && stalled_for >= inner.config.health.heartbeat_stall
                    && !parked_not_stuck;

                if !wedged {
                    if worker.state() != WorkerState::Unhealthy {
                        worker.set_state(WorkerState::Running);
                    }
                    continue;
                }
                if worker.state() == WorkerState::Unhealthy {
                    continue;
                }

                let record = WedgedWorker {
                    id: worker.id,
                    since: Instant::now(),
                    in_flight: health.in_flight.clone(),
                    binding: health.current_binding.clone(),
                    stalled_ms: stalled_for.as_millis() as u64,
                    homed_mods: worker.homed_mods(),
                };
                worker.set_state(WorkerState::Unhealthy);
                *worker.wedged.lock().unwrap_or_else(|p| p.into_inner()) = Some(record.clone());
                // Works unconditionally: a queued call has not been dispatched,
                // so no interrupt is needed to stop it, and the pool answers it
                // itself rather than waiting for a thread that is not coming
                // back.
                worker.answer_queued(usize::MAX, |w| w.wedged_error());
                if let Some(ref on_wedge) = inner.config.health.on_wedge {
                    on_wedge(&record);
                }
            }
        }
    })
}

fn join_pendings(pendings: Vec<Pending<()>>) -> Pending<()> {
    let (completer, pending) = Pending::<()>::new(CallToken::new());
    let completer = Arc::new(Mutex::new(Some(completer)));
    if pendings.is_empty() {
        if let Some(c) = completer.lock().unwrap_or_else(|p| p.into_inner()).take() {
            c.complete(Ok(()));
        }
        return pending;
    }
    let remaining = Arc::new(AtomicUsize::new(pendings.len()));
    for inner in pendings {
        let remaining = remaining.clone();
        let completer = completer.clone();
        inner.on_complete(move |result| {
            let last = remaining.fetch_sub(1, Ordering::SeqCst) == 1;
            if (result.is_err() || last)
                && let Some(c) = completer.lock().unwrap_or_else(|p| p.into_inner()).take()
            {
                c.complete(result);
            }
        });
    }
    pending
}

/// Merges per-worker segments into one result list ordered by
/// `(mod.load_seq, intra-mod index)`.
fn merge_segments(
    segments: Vec<Option<Result<Vec<TaggedResult>>>>,
    seq_of: &HashMap<String, u64>,
) -> Result<Vec<serde_json::Value>> {
    let mut all: Vec<(u64, u32, serde_json::Value)> = Vec::new();
    for segment in segments {
        match segment {
            Some(Ok(tagged)) => {
                for entry in tagged {
                    let seq = seq_of.get(&entry.mod_id).copied().unwrap_or(u64::MAX);
                    all.push((seq, entry.index, entry.value));
                }
            }
            Some(Err(e)) => return Err(e),
            None => {}
        }
    }
    all.sort_by_key(|(seq, index, _)| (*seq, *index));
    Ok(all.into_iter().map(|(_, _, value)| value).collect())
}

/// Which host slot each of a mod's exports fills, read straight off the mod
/// manifest's `fills`.
///
/// Best-effort and used only to pick the host side of a widen: a fill shape
/// this does not recognize falls back to the host manifest's own default,
/// which is the same answer an export that fills nothing gets.
fn slot_of_export(mod_manifest_json: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(mod_manifest_json) else {
        return map;
    };
    let Some(fills) = value.get("fills").and_then(|f| f.as_object()) else {
        return map;
    };
    for (slot, fill) in fills {
        let mut record = |name: Option<&str>| {
            if let Some(name) = name {
                map.insert(name.to_string(), slot.clone());
            }
        };
        match fill {
            serde_json::Value::String(name) => record(Some(name)),
            serde_json::Value::Object(object) => {
                for key in ["handler", "export", "fn", "command"] {
                    record(object.get(key).and_then(|v| v.as_str()));
                }
            }
            serde_json::Value::Array(entries) => {
                for entry in entries {
                    match entry {
                        serde_json::Value::String(name) => record(Some(name)),
                        serde_json::Value::Object(object) => {
                            for key in ["handler", "export", "fn", "command"] {
                                record(object.get(key).and_then(|v| v.as_str()));
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    map
}
