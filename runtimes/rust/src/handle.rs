//! A runtime driven from any thread, without blocking the one that asks.
//!
//! One [`XriptRuntime`](crate::sandbox::XriptRuntime) owns one interpreter on
//! one thread, forever. `XriptHandle` is the seam: it owns that thread, accepts
//! commands from anywhere, and hands back a [`Pending<T>`] the caller can await,
//! poll, or attach a callback to.
//!
//! ```ignore
//! #[tauri::command]
//! async fn run_mod(state: State<'_, XriptHandle>, src: String) -> Result<Value, String> {
//!     state.execute(&src).await.map(|r| r.value).map_err(|e| e.to_string())
//! }
//! ```
//!
//! Three things are worth knowing before using it.
//!
//! - **The plain method names do not block.** The blocking form lives on
//!   [`XriptHandle::blocking`], and [`Pending::wait`] is the per-call opt-in.
//! - **Dropping a [`Pending`] cancels its call.** `let _ = handle.execute(..);`
//!   compiles and cancels; bind the value or call [`Pending::detach`].
//! - **Cancellation only reaches running bytecode.** A call sitting inside a
//!   blocking host binding observes nothing until that binding returns. See
//!   `spec/execution.md`. On a runtime built in `RuntimeMode::Async`, a call
//!   awaiting an async binding is parked rather than blocked: later calls run
//!   meanwhile, and cancellation reaches the parked one.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use crate::commands::ResolvedCommand;
use crate::debug::DebugSession;
use crate::error::{Result, XriptError};
use crate::fragment::ModInstance;
use crate::manifest::Manifest;
use crate::pending::{CallToken, Completer, Pending};
use crate::sandbox::{
    CallTokenScope, ExecutionResult, HandlerIndex, RoleResolution, RuntimeOptions, RuntimeProbe,
    SharedMods, SlotContribution, TaggedResult,
};

/// What a runtime thread was doing when it was asked about.
#[derive(Debug, Clone)]
pub struct CallInfo {
    /// The verb: `"execute"`, `"load_mod"`, `"invoke_export"`, and so on.
    pub kind: &'static str,
    /// The export, hook, event or slot the call names, when it names one.
    pub target: Option<String>,
    pub dispatched_at: std::time::Instant,
}

/// Where a worker stands. `Unhealthy` and `Retired` are set by a pool's
/// supervisor; a lone handle only ever reports `Idle` or `Running`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerState {
    Idle,
    Running,
    /// An in-flight call is past its threshold **and** the heartbeat has
    /// stalled. Both conditions are required — see [`XriptHandle::health`].
    Unhealthy,
    /// Removed from a pool's routing. The thread is abandoned, not killed.
    Retired,
}

/// A worker's observable state.
#[derive(Debug, Clone)]
pub struct WorkerHealth {
    pub state: WorkerState,
    pub in_flight: Option<CallInfo>,
    /// The host binding the runtime thread is inside right now, if any.
    pub current_binding: Option<String>,
    /// Monotonic, bumped by the interrupt handler. Advances only while
    /// bytecode runs.
    pub heartbeat: u64,
}

/// What actually happened when a handle was told to stop.
///
/// A runtime thread blocked inside a host binding cannot be interrupted or
/// killed, so this reports what was achieved rather than asserting a clean
/// teardown. See `spec/execution.md`.
#[derive(Debug, Clone)]
pub struct ShutdownReport {
    /// The runtime thread reached the stop command and exited its loop.
    pub stopped: bool,
    /// The caller joined the thread. Only [`XriptHandle::join`] does.
    pub joined: bool,
    /// The thread was left running and its memory left allocated.
    pub abandoned_thread: bool,
    /// Commands that were dropped from the queue rather than run.
    pub dropped: usize,
    /// What was running when the stop was requested, if anything.
    pub in_flight: Option<CallInfo>,
}

enum CommandKind {
    Execute {
        code: String,
        reply: Completer<ExecutionResult>,
    },
    LoadMod {
        mod_manifest_json: String,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: HashSet<String>,
        entry_source: Option<String>,
        reply: Completer<ModInstance>,
    },
    InvokeExport {
        mod_name: Option<String>,
        name: String,
        args: Vec<serde_json::Value>,
        reply: Completer<serde_json::Value>,
    },
    FireHook {
        hook: String,
        payload: Vec<serde_json::Value>,
        reply: Completer<Vec<serde_json::Value>>,
    },
    FireFragmentHook {
        fragment_id: String,
        lifecycle: String,
        bindings: Option<serde_json::Value>,
        reply: Completer<Vec<crate::fragment::ops::FragmentOp>>,
    },
    Emit {
        event: String,
        payload: Vec<serde_json::Value>,
        reply: Completer<Vec<serde_json::Value>>,
    },
    FireHookTagged {
        hook: String,
        payload: Vec<serde_json::Value>,
        reply: Completer<Vec<TaggedResult>>,
    },
    EmitTagged {
        event: String,
        payload: Vec<serde_json::Value>,
        reply: Completer<Vec<TaggedResult>>,
    },
    HandlerIndexFor {
        mod_id: String,
        reply: Completer<HandlerIndex>,
    },
    ResolveCommands {
        slot_id: String,
        all: bool,
        reply: Completer<Vec<ResolvedCommand>>,
    },
    ResolveCommandRef {
        reference: String,
        reply: Completer<Option<ResolvedCommand>>,
    },
    InvokeResolved {
        command: Box<ResolvedCommand>,
        call_args: Option<serde_json::Map<String, serde_json::Value>>,
        reply: Completer<serde_json::Value>,
    },
    DebugSession {
        reply: Completer<Option<DebugSession>>,
    },
    Stop {
        drop_queue: bool,
        in_flight: Option<CallInfo>,
        reply: Completer<ShutdownReport>,
    },
}

impl CommandKind {
    fn describe(&self) -> CallInfo {
        let (kind, target) = match self {
            CommandKind::Execute { .. } => ("execute", None),
            CommandKind::LoadMod { .. } => ("load_mod", None),
            CommandKind::InvokeExport { name, .. } => ("invoke_export", Some(name.clone())),
            CommandKind::FireHook { hook, .. } => ("fire_hook", Some(hook.clone())),
            CommandKind::FireFragmentHook { fragment_id, .. } => {
                ("fire_fragment_hook", Some(fragment_id.clone()))
            }
            CommandKind::Emit { event, .. } => ("emit", Some(event.clone())),
            CommandKind::FireHookTagged { hook, .. } => ("fire_hook", Some(hook.clone())),
            CommandKind::EmitTagged { event, .. } => ("emit", Some(event.clone())),
            CommandKind::HandlerIndexFor { mod_id, .. } => {
                ("handler_index", Some(mod_id.clone()))
            }
            CommandKind::ResolveCommands { slot_id, .. } => {
                ("resolve_commands", Some(slot_id.clone()))
            }
            CommandKind::ResolveCommandRef { reference, .. } => {
                ("resolve_command", Some(reference.clone()))
            }
            CommandKind::InvokeResolved { command, .. } => {
                ("invoke_command", Some(command.id.clone()))
            }
            CommandKind::DebugSession { .. } => ("debug_session", None),
            CommandKind::Stop { .. } => ("shutdown", None),
        };
        CallInfo {
            kind,
            target,
            dispatched_at: std::time::Instant::now(),
        }
    }

    /// Replies to a command that will never run.
    fn abort(self, error: impl Fn() -> XriptError) {
        match self {
            CommandKind::Execute { reply, .. } => reply.complete(Err(error())),
            CommandKind::LoadMod { reply, .. } => reply.complete(Err(error())),
            CommandKind::InvokeExport { reply, .. } => reply.complete(Err(error())),
            CommandKind::FireHook { reply, .. } => reply.complete(Err(error())),
            CommandKind::FireFragmentHook { reply, .. } => reply.complete(Err(error())),
            CommandKind::Emit { reply, .. } => reply.complete(Err(error())),
            CommandKind::FireHookTagged { reply, .. } => reply.complete(Err(error())),
            CommandKind::EmitTagged { reply, .. } => reply.complete(Err(error())),
            CommandKind::HandlerIndexFor { reply, .. } => reply.complete(Err(error())),
            CommandKind::ResolveCommands { reply, .. } => reply.complete(Err(error())),
            CommandKind::ResolveCommandRef { reply, .. } => reply.complete(Err(error())),
            CommandKind::InvokeResolved { reply, .. } => reply.complete(Err(error())),
            CommandKind::DebugSession { reply, .. } => reply.complete(Err(error())),
            CommandKind::Stop { reply, .. } => reply.complete(Err(error())),
        }
    }
}

struct Command {
    token: CallToken,
    kind: CommandKind,
}

/// State the handle reads without asking the runtime thread for it.
struct Shared {
    manifest: Arc<Manifest>,
    mods: SharedMods,
    role_preferences: HashMap<String, String>,
    /// Set by the runtime thread when construction fails, so every queued and
    /// subsequent command can be told why instead of hanging.
    init_error: Mutex<Option<String>>,
    /// Every dispatched call that has not yet completed, oldest first. A
    /// blocking runtime has at most one; a yielding runtime may have several
    /// parked on host futures at once.
    in_flight: Mutex<Vec<(CallInfo, CallToken)>>,
    stopping: AtomicBool,
    /// Set by `kill`. Every command the loop dequeues afterwards is shed
    /// rather than run, which is the one shedding path that needs no
    /// interrupt and therefore always works.
    killed: AtomicBool,
    shed: std::sync::atomic::AtomicUsize,
    probe: Arc<RuntimeProbe>,
    retired: AtomicBool,
    /// The runtime thread, unparked on every send so a yielding loop that is
    /// parked between polls notices new work.
    worker: std::sync::OnceLock<thread::Thread>,
}

pub struct XriptHandle {
    cmd_tx: mpsc::Sender<Command>,
    shared: Arc<Shared>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

fn placeholder_manifest() -> Manifest {
    serde_json::from_str(r#"{ "xript": "0", "name": "" }"#)
        .expect("the placeholder manifest is well-formed")
}

impl XriptHandle {
    /// Starts a runtime thread and waits for it to finish constructing.
    ///
    /// Only the construction blocks; every verb on the returned handle is
    /// non-blocking. Use [`XriptHandle::spawn`] when even that wait is too
    /// much.
    pub fn new(manifest_json: String, options: RuntimeOptions) -> Result<Self> {
        let (handle, ready) = Self::spawn(manifest_json, options);
        ready.wait()?;
        Ok(handle)
    }

    /// Starts a runtime thread and returns immediately.
    ///
    /// Commands sent before construction finishes are queued and run in order
    /// once it does. If construction fails, the returned `Pending` carries the
    /// error and every queued and subsequent command fails with
    /// [`XriptError::InitFailed`].
    pub fn spawn(manifest_json: String, options: RuntimeOptions) -> (Self, Pending<()>) {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (init_reply, init_pending) = Pending::<()>::new(CallToken::new());

        // Parsed here rather than on the runtime thread so the manifest is
        // readable through the handle before construction finishes, and so a
        // malformed manifest still yields a usable (if failed) handle.
        let parsed: Option<Manifest> = serde_json::from_str(&manifest_json).ok();
        let manifest = Arc::new(parsed.unwrap_or_else(placeholder_manifest));
        let mods: SharedMods = Arc::new(std::sync::RwLock::new(Vec::new()));
        let probe: Arc<RuntimeProbe> = Arc::new(RuntimeProbe::default());

        let shared = Arc::new(Shared {
            manifest: manifest.clone(),
            mods: mods.clone(),
            role_preferences: options.role_preferences.clone(),
            init_error: Mutex::new(None),
            in_flight: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            shed: std::sync::atomic::AtomicUsize::new(0),
            probe: probe.clone(),
            retired: AtomicBool::new(false),
            worker: std::sync::OnceLock::new(),
        });

        let worker_shared = shared.clone();
        let thread = thread::spawn(move || {
            let rt = match crate::sandbox::XriptRuntime::with_shared_probe(
                manifest, mods, probe, options,
            ) {
                Ok(rt) => {
                    init_reply.complete(Ok(()));
                    rt
                }
                Err(e) => {
                    let message = e.to_string();
                    *worker_shared
                        .init_error
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = Some(message.clone());
                    init_reply.complete(Err(e));
                    // Keep draining so callers get an answer instead of a
                    // silently dropped channel.
                    while let Ok(cmd) = cmd_rx.recv() {
                        if let CommandKind::Stop { reply, .. } = cmd.kind {
                            reply.complete(Ok(ShutdownReport {
                                stopped: true,
                                joined: false,
                                abandoned_thread: false,
                                dropped: 0,
                                in_flight: None,
                            }));
                            return;
                        }
                        cmd.kind.abort(|| XriptError::InitFailed {
                            message: message.clone(),
                        });
                    }
                    return;
                }
            };

            if rt.mode() == crate::sandbox::RuntimeMode::Async {
                run_yielding(&rt, &cmd_rx, &worker_shared);
            } else {
                run_blocking(&rt, &cmd_rx, &worker_shared);
            }
        });
        let _ = shared.worker.set(thread.thread().clone());

        (
            Self {
                cmd_tx,
                shared,
                thread: Mutex::new(Some(thread)),
            },
            init_pending,
        )
    }

    fn send<T: Send + 'static>(
        &self,
        build: impl FnOnce(Completer<T>) -> CommandKind,
    ) -> Pending<T> {
        let token = CallToken::new();
        let (completer, pending) = Pending::<T>::new(token.clone());
        let kind = build(completer);
        if let Err(returned) = self.cmd_tx.send(Command { token, kind }) {
            let init_error = self
                .shared
                .init_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            returned.0.kind.abort(|| match init_error {
                Some(ref message) => XriptError::InitFailed {
                    message: message.clone(),
                },
                None => XriptError::Engine("runtime thread is gone".into()),
            });
        } else {
            self.wake_worker();
        }
        pending
    }

    fn wake_worker(&self) {
        if let Some(worker) = self.shared.worker.get() {
            worker.unpark();
        }
    }

    // -- work ---------------------------------------------------------------

    pub fn execute(&self, code: &str) -> Pending<ExecutionResult> {
        let code = code.to_string();
        self.send(|reply| CommandKind::Execute { code, reply })
    }

    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Pending<ModInstance> {
        let mod_manifest_json = mod_manifest_json.to_string();
        let granted_capabilities = granted_capabilities.clone();
        let entry_source = entry_source.map(|s| s.to_string());
        self.send(|reply| CommandKind::LoadMod {
            mod_manifest_json,
            fragment_sources,
            granted_capabilities,
            entry_source,
            reply,
        })
    }

    pub fn invoke_export(&self, name: &str, args: &[serde_json::Value]) -> Pending<serde_json::Value> {
        self.invoke_export_inner(None, name, args)
    }

    /// Invokes an export inside one named mod's own namespace. Gated by that
    /// mod's own declaration, so a second mod declaring the same name can
    /// neither weaken the gate nor shadow the function.
    pub fn invoke_mod_export(
        &self,
        mod_name: &str,
        name: &str,
        args: &[serde_json::Value],
    ) -> Pending<serde_json::Value> {
        self.invoke_export_inner(Some(mod_name), name, args)
    }

    fn invoke_export_inner(
        &self,
        mod_name: Option<&str>,
        name: &str,
        args: &[serde_json::Value],
    ) -> Pending<serde_json::Value> {
        let mod_name = mod_name.map(|s| s.to_string());
        let name = name.to_string();
        let args = args.to_vec();
        self.send(|reply| CommandKind::InvokeExport {
            mod_name,
            name,
            args,
            reply,
        })
    }

    pub fn fire_hook(
        &self,
        hook: &str,
        payload: &[serde_json::Value],
    ) -> Pending<Vec<serde_json::Value>> {
        let hook = hook.to_string();
        let payload = payload.to_vec();
        self.send(|reply| CommandKind::FireHook {
            hook,
            payload,
            reply,
        })
    }

    /// Fires a fragment lifecycle hook and returns the ops the handler queued.
    ///
    /// Previously reachable only on [`XriptRuntime`](crate::sandbox::XriptRuntime)
    /// itself, which meant a host driving fragments could not use a handle at
    /// all.
    pub fn fire_fragment_hook(
        &self,
        fragment_id: &str,
        lifecycle: &str,
        bindings: Option<&serde_json::Value>,
    ) -> Pending<Vec<crate::fragment::ops::FragmentOp>> {
        let fragment_id = fragment_id.to_string();
        let lifecycle = lifecycle.to_string();
        let bindings = bindings.cloned();
        self.send(|reply| CommandKind::FireFragmentHook {
            fragment_id,
            lifecycle,
            bindings,
            reply,
        })
    }

    pub fn emit(
        &self,
        event: &str,
        payload: &[serde_json::Value],
    ) -> Pending<Vec<serde_json::Value>> {
        let event = event.to_string();
        let payload = payload.to_vec();
        self.send(|reply| CommandKind::Emit {
            event,
            payload,
            reply,
        })
    }

    /// [`fire_hook`](Self::fire_hook) with each result tagged by the mod that
    /// registered the handler. What a pool merges across workers.
    pub fn fire_hook_tagged(
        &self,
        hook: &str,
        payload: &[serde_json::Value],
    ) -> Pending<Vec<TaggedResult>> {
        let hook = hook.to_string();
        let payload = payload.to_vec();
        self.send(|reply| CommandKind::FireHookTagged {
            hook,
            payload,
            reply,
        })
    }

    /// [`emit`](Self::emit) with each result tagged by the subscribing mod.
    pub fn emit_tagged(
        &self,
        event: &str,
        payload: &[serde_json::Value],
    ) -> Pending<Vec<TaggedResult>> {
        let event = event.to_string();
        let payload = payload.to_vec();
        self.send(|reply| CommandKind::EmitTagged {
            event,
            payload,
            reply,
        })
    }

    /// Which hooks and events one loaded mod's handlers answer to.
    pub fn handler_index_for(&self, mod_id: &str) -> Pending<HandlerIndex> {
        let mod_id = mod_id.to_string();
        self.send(|reply| CommandKind::HandlerIndexFor { mod_id, reply })
    }

    // -- the off-thread fast lane -------------------------------------------
    //
    // Slot and role resolution and every manifest read touch no JS context;
    // they are Rust reads over shared state. They answer on the calling thread
    // and never queue behind an execution.

    pub fn resolve_slot(&self, slot_id: &str) -> Pending<Vec<SlotContribution>> {
        Pending::ready(Ok(crate::sandbox::resolve_slot_from(
            &self.shared.manifest,
            &self.shared.mods,
            slot_id,
        )))
    }

    /// The winning contribution for a single-cardinality slot.
    pub fn resolve_slot_single(&self, slot_id: &str) -> Pending<Option<SlotContribution>> {
        Pending::ready(Ok(crate::sandbox::resolve_slot_from(
            &self.shared.manifest,
            &self.shared.mods,
            slot_id,
        )
        .into_iter()
        .next()))
    }

    pub fn resolve_role(&self, role: &str) -> Pending<Option<RoleResolution>> {
        Pending::ready(Ok(crate::sandbox::resolve_role_from(
            &self.shared.mods,
            &self.shared.role_preferences,
            role,
        )))
    }

    pub fn resolve_role_all(&self, role: &str) -> Pending<Vec<RoleResolution>> {
        Pending::ready(Ok(crate::sandbox::resolve_role_all_from(
            &self.shared.mods,
            role,
        )))
    }

    /// The host manifest this runtime was built from. Synchronous: no queue,
    /// no lock, no runtime thread.
    pub fn manifest(&self) -> Arc<Manifest> {
        self.shared.manifest.clone()
    }

    pub fn manifest_name(&self) -> &str {
        &self.shared.manifest.name
    }

    // -- commands -----------------------------------------------------------

    /// Every command filling `slot_id`, ordered, with no cardinality applied.
    pub fn resolve_commands_all(&self, slot_id: &str) -> Pending<Vec<ResolvedCommand>> {
        self.resolve_commands_inner(slot_id, true)
    }

    /// The commands filling `slot_id` after the slot's cardinality is applied.
    pub fn resolve_commands(&self, slot_id: &str) -> Pending<Vec<ResolvedCommand>> {
        self.resolve_commands_inner(slot_id, false)
    }

    fn resolve_commands_inner(&self, slot_id: &str, all: bool) -> Pending<Vec<ResolvedCommand>> {
        let slot_id = slot_id.to_string();
        self.send(|reply| CommandKind::ResolveCommands {
            slot_id,
            all,
            reply,
        })
    }

    /// Resolves a bare command id or a `mod:id` qualified id.
    pub fn resolve_command(&self, reference: &str) -> Pending<Option<ResolvedCommand>> {
        let reference = reference.to_string();
        self.send(|reply| CommandKind::ResolveCommandRef { reference, reply })
    }

    /// Invokes a resolved command through the mod-scoped export path.
    pub fn invoke_command(
        &self,
        command: &ResolvedCommand,
        call_args: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Pending<serde_json::Value> {
        let command = Box::new(command.clone());
        let call_args = call_args.cloned();
        self.send(|reply| CommandKind::InvokeResolved {
            command,
            call_args,
            reply,
        })
    }

    pub fn debug_session(&self) -> Pending<Option<DebugSession>> {
        self.send(|reply| CommandKind::DebugSession { reply })
    }

    // -- blocking escape hatch ----------------------------------------------

    /// The blocking mirror of this handle, for a CLI, a test, or anything else
    /// with no reason to stay responsive.
    ///
    /// `handle.blocking().execute(src)?` is exactly
    /// `handle.execute(src).wait()?`, spelled so the intent is visible at the
    /// callsite.
    pub fn blocking(&self) -> BlockingHandle<'_> {
        BlockingHandle(self)
    }

    // -- teardown -----------------------------------------------------------

    /// What this runtime thread's state is, as far as it can honestly be
    /// known from another thread.
    ///
    /// The two fields that matter together are `heartbeat` and `in_flight`. A
    /// heartbeat that is advancing means the interpreter is running bytecode,
    /// which is exactly the case where `limits` and cancellation do work. A
    /// heartbeat that is **not** advancing while a call is in flight means the
    /// thread is inside `current_binding` and nothing xript owns will get it
    /// back. Neither field alone says anything: a script legitimately running
    /// for a minute ticks the heartbeat the whole time, and an idle runtime
    /// does not tick it at all.
    pub fn health(&self) -> WorkerHealth {
        let in_flight = self.in_flight();
        let state = if self.shared.retired.load(Ordering::SeqCst) {
            WorkerState::Retired
        } else if in_flight.is_some() {
            WorkerState::Running
        } else {
            WorkerState::Idle
        };
        WorkerHealth {
            state,
            in_flight,
            current_binding: self.shared.probe.current_binding(),
            heartbeat: self.shared.probe.heartbeat(),
        }
    }

    /// Marks this handle retired. Reporting only: a retired handle still
    /// accepts commands, because nothing can take its thread away from it.
    pub(crate) fn mark_retired(&self) {
        self.shared.retired.store(true, Ordering::SeqCst);
    }

    /// The probe a supervisor polls without touching the runtime thread.
    pub fn probe(&self) -> Arc<RuntimeProbe> {
        self.shared.probe.clone()
    }

    /// What the runtime thread is working on right now, if anything. On a
    /// yielding runtime with several calls parked at once, the oldest.
    pub fn in_flight(&self) -> Option<CallInfo> {
        self.shared
            .in_flight
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .first()
            .map(|(info, _token)| info.clone())
    }

    /// Every dispatched call that has not completed, oldest first. At most one
    /// on a blocking runtime; a yielding runtime may hold several, each parked
    /// on a host future.
    pub fn in_flight_all(&self) -> Vec<CallInfo> {
        self.shared
            .in_flight
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|(info, _token)| info.clone())
            .collect()
    }

    /// The tokens of the calls the runtime thread has dispatched and not yet
    /// finished.
    ///
    /// A pool uses them to tell a queued call from a dispatched one, which is
    /// the difference between shedding something that has not started and
    /// pretending to shed something that cannot be stopped.
    pub(crate) fn in_flight_tokens(&self) -> Vec<CallToken> {
        self.shared
            .in_flight
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|(_info, token)| token.clone())
            .collect()
    }

    /// Drains the queue, then stops the runtime thread.
    ///
    /// The returned `Pending` completes when the thread reaches the stop
    /// command, so awaiting it is the confirmation that everything queued
    /// before it ran. It does not join the thread; [`XriptHandle::join`] does.
    pub fn shutdown(&self) -> Pending<ShutdownReport> {
        self.stop(false)
    }

    /// Cancels the in-flight call, drops the queue, and stops.
    ///
    /// The cancellation reaches a call that is running script. It does **not**
    /// reach a call blocked inside a host binding — nothing does — so if the
    /// runtime thread is wedged there, the returned `Pending` stays pending and
    /// the thread stays alive. That is the honest outcome, not a bug.
    pub fn kill(&self) -> Pending<ShutdownReport> {
        self.shared.killed.store(true, Ordering::SeqCst);
        for token in self.in_flight_tokens() {
            token.cancel();
        }
        self.stop(true)
    }

    fn stop(&self, drop_queue: bool) -> Pending<ShutdownReport> {
        self.shared.stopping.store(true, Ordering::SeqCst);
        let in_flight = self.in_flight();
        let token = CallToken::new();
        let (completer, pending) = Pending::<ShutdownReport>::new(token.clone());
        if self
            .cmd_tx
            .send(Command {
                token,
                kind: CommandKind::Stop {
                    drop_queue,
                    in_flight: in_flight.clone(),
                    reply: completer,
                },
            })
            .is_err()
        {
            return Pending::ready(Ok(ShutdownReport {
                stopped: true,
                joined: false,
                abandoned_thread: false,
                dropped: 0,
                in_flight,
            }));
        }
        self.wake_worker();
        pending
    }

    /// Stops the runtime thread and blocks until it exits.
    ///
    /// The explicit opt-in to the wait that dropping a handle deliberately does
    /// not do. A thread blocked in a host binding never exits, so this can block
    /// forever; that is why it is not the default.
    pub fn join(self) -> Result<ShutdownReport> {
        let mut report = self.shutdown().wait()?;
        let thread = self
            .thread
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(thread) = thread {
            thread
                .join()
                .map_err(|_| XriptError::Engine("runtime thread panicked".into()))?;
            report.joined = true;
        }
        Ok(report)
    }
}

/// Dropping a handle **detaches** its runtime thread: the thread is told to
/// stop and is not waited for.
///
/// Joining here would mean that dropping a handle whose thread is blocked in a
/// host binding hangs the dropping thread — on a UI host, the UI thread during
/// teardown. Use [`XriptHandle::join`] when the wait is what you want.
impl Drop for XriptHandle {
    fn drop(&mut self) {
        if !self.shared.stopping.swap(true, Ordering::SeqCst) {
            let (completer, pending) = Pending::<ShutdownReport>::new(CallToken::new());
            let _unused = self.cmd_tx.send(Command {
                token: CallToken::new(),
                kind: CommandKind::Stop {
                    drop_queue: false,
                    in_flight: None,
                    reply: completer,
                },
            });
            pending.detach();
        }
    }
}

/// The blocking mirror of [`XriptHandle`], one `.wait()` deep.
pub struct BlockingHandle<'a>(&'a XriptHandle);

impl BlockingHandle<'_> {
    pub fn execute(&self, code: &str) -> Result<ExecutionResult> {
        self.0.execute(code).wait()
    }

    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Result<ModInstance> {
        self.0
            .load_mod(
                mod_manifest_json,
                fragment_sources,
                granted_capabilities,
                entry_source,
            )
            .wait()
    }

    pub fn invoke_export(&self, name: &str, args: &[serde_json::Value]) -> Result<serde_json::Value> {
        self.0.invoke_export(name, args).wait()
    }

    pub fn invoke_mod_export(
        &self,
        mod_name: &str,
        name: &str,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        self.0.invoke_mod_export(mod_name, name, args).wait()
    }

    pub fn fire_hook(
        &self,
        hook: &str,
        payload: &[serde_json::Value],
    ) -> Result<Vec<serde_json::Value>> {
        self.0.fire_hook(hook, payload).wait()
    }

    pub fn fire_fragment_hook(
        &self,
        fragment_id: &str,
        lifecycle: &str,
        bindings: Option<&serde_json::Value>,
    ) -> Result<Vec<crate::fragment::ops::FragmentOp>> {
        self.0
            .fire_fragment_hook(fragment_id, lifecycle, bindings)
            .wait()
    }

    pub fn emit(&self, event: &str, payload: &[serde_json::Value]) -> Result<Vec<serde_json::Value>> {
        self.0.emit(event, payload).wait()
    }

    pub fn resolve_slot(&self, slot_id: &str) -> Result<Vec<SlotContribution>> {
        self.0.resolve_slot(slot_id).wait()
    }

    pub fn resolve_slot_single(&self, slot_id: &str) -> Result<Option<SlotContribution>> {
        self.0.resolve_slot_single(slot_id).wait()
    }

    pub fn resolve_role(&self, role: &str) -> Result<Option<RoleResolution>> {
        self.0.resolve_role(role).wait()
    }

    pub fn resolve_role_all(&self, role: &str) -> Result<Vec<RoleResolution>> {
        self.0.resolve_role_all(role).wait()
    }

    pub fn resolve_commands_all(&self, slot_id: &str) -> Result<Vec<ResolvedCommand>> {
        self.0.resolve_commands_all(slot_id).wait()
    }

    pub fn resolve_commands(&self, slot_id: &str) -> Result<Vec<ResolvedCommand>> {
        self.0.resolve_commands(slot_id).wait()
    }

    pub fn resolve_command(&self, reference: &str) -> Result<Option<ResolvedCommand>> {
        self.0.resolve_command(reference).wait()
    }

    pub fn invoke_command(
        &self,
        command: &ResolvedCommand,
        call_args: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Result<serde_json::Value> {
        self.0.invoke_command(command, call_args).wait()
    }

    pub fn debug_session(&self) -> Result<Option<DebugSession>> {
        self.0.debug_session().wait()
    }

    pub fn manifest(&self) -> Arc<Manifest> {
        self.0.manifest()
    }

    pub fn manifest_name(&self) -> &str {
        self.0.manifest_name()
    }
}

fn lock_in_flight(shared: &Shared) -> std::sync::MutexGuard<'_, Vec<(CallInfo, CallToken)>> {
    shared.in_flight.lock().unwrap_or_else(|p| p.into_inner())
}

fn forget_in_flight(shared: &Shared, token: &CallToken) {
    lock_in_flight(shared).retain(|(_info, held)| !held.same_call(token));
}

/// Answers a stop command once nothing it promised to wait for is left.
fn finish_stop(
    shared: &Shared,
    cmd_rx: &mpsc::Receiver<Command>,
    drop_queue: bool,
    in_flight: Option<CallInfo>,
    reply: Completer<ShutdownReport>,
) {
    let mut dropped = shared.shed.load(Ordering::SeqCst);
    if drop_queue {
        while let Ok(queued) = cmd_rx.try_recv() {
            dropped += 1;
            queued.kind.abort(|| XriptError::Cancelled);
        }
    }
    reply.complete(Ok(ShutdownReport {
        stopped: true,
        joined: false,
        abandoned_thread: false,
        dropped,
        in_flight,
    }));
}

/// A call cancelled before it was dequeued is skipped outright, as is
/// everything behind a `kill`. This is the one cancellation path that works
/// unconditionally, because it needs no interrupt.
fn shed_if_cancelled(shared: &Shared, cmd: Command) -> Option<Command> {
    if cmd.token.is_cancelled() || shared.killed.load(Ordering::SeqCst) {
        if shared.killed.load(Ordering::SeqCst) {
            shared.shed.fetch_add(1, Ordering::SeqCst);
        }
        cmd.kind.abort(|| XriptError::Cancelled);
        return None;
    }
    Some(cmd)
}

fn run_blocking(rt: &crate::sandbox::XriptRuntime, cmd_rx: &mpsc::Receiver<Command>, shared: &Shared) {
    while let Ok(cmd) = cmd_rx.recv() {
        // Stop is checked before the token, so a dropped
        // `Pending<ShutdownReport>` cannot cancel the shutdown itself.
        if let CommandKind::Stop {
            drop_queue,
            in_flight,
            reply,
        } = cmd.kind
        {
            finish_stop(shared, cmd_rx, drop_queue, in_flight, reply);
            break;
        }
        let Some(cmd) = shed_if_cancelled(shared, cmd) else {
            continue;
        };
        lock_in_flight(shared).push((cmd.kind.describe(), cmd.token.clone()));
        let _call = CallTokenScope::enter(cmd.token.clone());
        dispatch(rt, cmd.kind);
        drop(_call);
        forget_in_flight(shared, &cmd.token);
    }
}

/// Wakes the runtime thread by unparking it, so the yielding loop can sleep
/// between polls without a timer.
struct UnparkWaker(thread::Thread);

impl std::task::Wake for UnparkWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

/// One dispatched call on a yielding runtime, parked until its future settles.
struct Flight<'rt> {
    token: CallToken,
    call: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'rt>>,
}

impl Flight<'_> {
    /// Polls under the call's own token, so the interrupt frame pushed for this
    /// poll carries this call's cancellation and nobody else's.
    fn poll(&mut self, cx: &mut std::task::Context<'_>) -> bool {
        let _call = CallTokenScope::enter(self.token.clone());
        self.call.as_mut().poll(cx).is_ready()
    }
}

/// The command loop of a yielding runtime. Calls that can await a host binding
/// are started in queue order and polled once on arrival, so everything a call
/// does before its first `await` happens in the order the calls were sent;
/// after that, whichever call's host future settles first continues first.
/// `load_mod` is a barrier: it runs to completion before the next command is
/// taken, so a later call can rely on the mod being loaded.
fn run_yielding(rt: &crate::sandbox::XriptRuntime, cmd_rx: &mpsc::Receiver<Command>, shared: &Shared) {
    let waker = std::task::Waker::from(Arc::new(UnparkWaker(thread::current())));
    let mut cx = std::task::Context::from_waker(&waker);
    let mut flights: Vec<Flight<'_>> = Vec::new();
    let mut stopping: Option<(bool, Option<CallInfo>, Completer<ShutdownReport>)> = None;
    let mut disconnected = false;

    loop {
        while stopping.is_none() && !disconnected {
            let next = if flights.is_empty() {
                cmd_rx.recv().map_err(|_| mpsc::TryRecvError::Disconnected)
            } else {
                cmd_rx.try_recv()
            };
            let cmd = match next {
                Ok(cmd) => cmd,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            };
            if let CommandKind::Stop {
                drop_queue,
                in_flight,
                reply,
            } = cmd.kind
            {
                if drop_queue {
                    for flight in &flights {
                        flight.token.cancel();
                    }
                }
                stopping = Some((drop_queue, in_flight, reply));
                break;
            }
            let Some(cmd) = shed_if_cancelled(shared, cmd) else {
                continue;
            };
            lock_in_flight(shared).push((cmd.kind.describe(), cmd.token.clone()));
            if !cmd.kind.yields() {
                let _call = CallTokenScope::enter(cmd.token.clone());
                dispatch(rt, cmd.kind);
                drop(_call);
                forget_in_flight(shared, &cmd.token);
                continue;
            }
            let mut flight = Flight {
                token: cmd.token.clone(),
                call: Box::pin(dispatch_yielding(rt, cmd.kind)),
            };
            if flight.poll(&mut cx) {
                forget_in_flight(shared, &flight.token);
            } else {
                flights.push(flight);
            }
        }

        flights.retain_mut(|flight| {
            let done = flight.poll(&mut cx);
            if done {
                forget_in_flight(shared, &flight.token);
            }
            !done
        });

        if flights.is_empty() {
            if let Some((drop_queue, in_flight, reply)) = stopping.take() {
                finish_stop(shared, cmd_rx, drop_queue, in_flight, reply);
                return;
            }
            if disconnected {
                return;
            }
            continue;
        }
        thread::park();
    }
}

impl CommandKind {
    /// Whether the call can await a host binding, and so runs as a parked
    /// flight on a yielding runtime instead of to completion in line.
    fn yields(&self) -> bool {
        matches!(
            self,
            CommandKind::Execute { .. }
                | CommandKind::InvokeExport { .. }
                | CommandKind::FireHook { .. }
                | CommandKind::FireHookTagged { .. }
                | CommandKind::FireFragmentHook { .. }
                | CommandKind::Emit { .. }
                | CommandKind::EmitTagged { .. }
                | CommandKind::InvokeResolved { .. }
        )
    }
}

async fn dispatch_yielding(rt: &crate::sandbox::XriptRuntime, kind: CommandKind) {
    match kind {
        CommandKind::Execute { code, reply } => reply.complete(rt.execute_async(&code).await),
        CommandKind::InvokeExport {
            mod_name,
            name,
            args,
            reply,
        } => reply.complete(match mod_name {
            Some(owner) => rt.invoke_mod_export_async(&owner, &name, &args).await,
            None => rt.invoke_export_async(&name, &args).await,
        }),
        CommandKind::FireHook {
            hook,
            payload,
            reply,
        } => reply.complete(rt.fire_hook_async(&hook, &payload).await),
        CommandKind::FireHookTagged {
            hook,
            payload,
            reply,
        } => reply.complete(rt.fire_hook_tagged_async(&hook, &payload).await),
        CommandKind::FireFragmentHook {
            fragment_id,
            lifecycle,
            bindings,
            reply,
        } => reply.complete(
            rt.fire_fragment_hook_async(&fragment_id, &lifecycle, bindings.as_ref())
                .await,
        ),
        CommandKind::Emit {
            event,
            payload,
            reply,
        } => reply.complete(rt.emit_async(&event, &payload).await),
        CommandKind::EmitTagged {
            event,
            payload,
            reply,
        } => reply.complete(rt.emit_tagged_async(&event, &payload).await),
        CommandKind::InvokeResolved {
            command,
            call_args,
            reply,
        } => reply.complete(rt.invoke_command_async(&command, call_args.as_ref()).await),
        other => dispatch(rt, other),
    }
}

fn dispatch(rt: &crate::sandbox::XriptRuntime, kind: CommandKind) {
    match kind {
        CommandKind::Execute { code, reply } => reply.complete(rt.execute(&code)),
        CommandKind::LoadMod {
            mod_manifest_json,
            fragment_sources,
            granted_capabilities,
            entry_source,
            reply,
        } => reply.complete(rt.load_mod(
            &mod_manifest_json,
            fragment_sources,
            &granted_capabilities,
            entry_source.as_deref(),
        )),
        CommandKind::InvokeExport {
            mod_name,
            name,
            args,
            reply,
        } => reply.complete(match mod_name {
            Some(owner) => rt.invoke_mod_export(&owner, &name, &args),
            None => rt.invoke_export(&name, &args),
        }),
        CommandKind::FireHook {
            hook,
            payload,
            reply,
        } => reply.complete(rt.fire_hook(&hook, &payload)),
        CommandKind::FireFragmentHook {
            fragment_id,
            lifecycle,
            bindings,
            reply,
        } => reply.complete(rt.fire_fragment_hook(&fragment_id, &lifecycle, bindings.as_ref())),
        CommandKind::Emit {
            event,
            payload,
            reply,
        } => reply.complete(rt.emit(&event, &payload)),
        CommandKind::FireHookTagged {
            hook,
            payload,
            reply,
        } => reply.complete(rt.fire_hook_tagged(&hook, &payload)),
        CommandKind::EmitTagged {
            event,
            payload,
            reply,
        } => reply.complete(rt.emit_tagged(&event, &payload)),
        CommandKind::HandlerIndexFor { mod_id, reply } => {
            reply.complete(Ok(rt.handler_index_for(&mod_id)))
        }
        CommandKind::ResolveCommands {
            slot_id,
            all,
            reply,
        } => reply.complete(Ok(if all {
            rt.resolve_commands_all(&slot_id)
        } else {
            rt.resolve_commands(&slot_id)
        })),
        CommandKind::ResolveCommandRef { reference, reply } => {
            reply.complete(Ok(rt.resolve_command(&reference)))
        }
        CommandKind::InvokeResolved {
            command,
            call_args,
            reply,
        } => reply.complete(rt.invoke_command(&command, call_args.as_ref())),
        CommandKind::DebugSession { reply } => reply.complete(Ok(rt.debug_session().cloned())),
        CommandKind::Stop { .. } => unreachable!("Stop is handled by the dispatch loop"),
    }
}
