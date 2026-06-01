//! DAP-shaped (Debug Adapter Protocol) step/breakpoint/inspect surface.
//!
//! xript exposes the MECHANISM (pause/resume/inspect) — it owns no transport, no
//! debug UI, and no wire socket. The host drives a [`DebugSession`] obtained from
//! the runtime, sets breakpoints by source position, and is notified via a
//! host-registered `on_stopped` sink when execution pauses; while paused it reads
//! the call stack, scopes, and variables, then issues continue/step verbs.
//!
//! `threadId` is the constant `1` everywhere (scripts are single-threaded) but is
//! present in every message for DAP conformance. `variables_reference` handles
//! are runtime-assigned, monotonic per pause, and reset on resume.
//!
//! Mechanism on this runtime: rquickjs 0.10 exposes no per-line debug hook, so
//! pause/step positions come from SOURCE INSTRUMENTATION — the host runs script
//! through [`instrument_source`], which injects `__xript_dbg(line, col)` probe
//! calls at statement boundaries. The probe is a host-bridged fn that consults
//! breakpoint/step state and blocks the executing thread on a condvar until a
//! resume verb fires. Fidelity is reported as [`DebugFidelity::Instrumented`].

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use rquickjs::{Ctx, Function};
use serde::{Deserialize, Serialize};

use crate::error::{Result, XriptError};

pub const DEBUG_THREAD_ID: i64 = 1;

/// How faithfully a runtime realizes the debug surface. rquickjs has no native
/// stepping, so this runtime reconstructs positions/frames from instrumentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DebugFidelity {
    Native,
    Instrumented,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceBreakpoint {
    pub line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Breakpoint {
    pub id: i64,
    pub verified: bool,
    pub line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    pub line: i64,
    pub column: i64,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scope {
    pub name: String,
    #[serde(rename = "variablesReference")]
    pub variables_reference: i64,
    pub expensive: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(rename = "variablesReference")]
    pub variables_reference: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StopReason {
    Breakpoint,
    Step,
    Pause,
    Entry,
    Exception,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoppedEvent {
    pub reason: StopReason,
    #[serde(rename = "threadId")]
    pub thread_id: i64,
    #[serde(rename = "hitBreakpointIds", skip_serializing_if = "Option::is_none")]
    pub hit_breakpoint_ids: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Host-supplied event sinks. Each is invoked from the executing thread; the
/// `on_stopped` sink fires while the script is blocked at a checkpoint.
#[derive(Clone, Default)]
pub struct DebugOptions {
    pub on_stopped: Option<Arc<dyn Fn(StoppedEvent) + Send + Sync>>,
    pub on_continued: Option<Arc<dyn Fn(i64) + Send + Sync>>,
    pub on_terminated: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_breakpoint_changed: Option<Arc<dyn Fn(Breakpoint) + Send + Sync>>,
    pub stop_on_entry: bool,
}

impl std::fmt::Debug for DebugOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DebugOptions")
            .field("stop_on_entry", &self.stop_on_entry)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StepMode {
    None,
    In,
    Over,
    Out,
}

struct BoundBreakpoint {
    id: i64,
    line: i64,
    column: Option<i64>,
    condition: Option<String>,
    source: String,
}

#[derive(Default)]
struct PauseRegistry {
    next_ref: i64,
    entries: BTreeMap<i64, Vec<Variable>>,
}

impl PauseRegistry {
    fn reset(&mut self) {
        self.next_ref = 0;
        self.entries.clear();
    }

    fn alloc(&mut self, vars: Vec<Variable>) -> i64 {
        self.next_ref += 1;
        let r = self.next_ref;
        self.entries.insert(r, vars);
        r
    }
}

struct DebugState {
    breakpoints: Vec<BoundBreakpoint>,
    next_bp_id: i64,
    step: StepMode,
    pause_requested: bool,
    frames: Vec<StackFrame>,
    registry: PauseRegistry,
    paused: bool,
    paused_clock_ms: u64,
}

impl Default for DebugState {
    fn default() -> Self {
        Self {
            breakpoints: Vec::new(),
            next_bp_id: 0,
            step: StepMode::None,
            pause_requested: false,
            frames: Vec::new(),
            registry: PauseRegistry::default(),
            paused: false,
            paused_clock_ms: 0,
        }
    }
}

/// A host-driven DAP session. Verbs match the DAP vocabulary; structs round-trip
/// to DAP JSON via serde. Cloneable — the same session backs the runtime and any
/// host-held reference.
#[derive(Clone)]
pub struct DebugSession {
    inner: Arc<DebugInner>,
}

struct DebugInner {
    state: Mutex<DebugState>,
    resume: Condvar,
    options: DebugOptions,
    paused_clock: Arc<AtomicU64>,
    terminated: AtomicBool,
}

impl DebugSession {
    pub fn new(options: DebugOptions) -> Self {
        let mut state = DebugState::default();
        if options.stop_on_entry {
            state.pause_requested = true;
        }
        Self {
            inner: Arc::new(DebugInner {
                state: Mutex::new(state),
                resume: Condvar::new(),
                options,
                paused_clock: Arc::new(AtomicU64::new(0)),
                terminated: AtomicBool::new(false),
            }),
        }
    }

    pub fn fidelity(&self) -> DebugFidelity {
        DebugFidelity::Instrumented
    }

    /// Shared accumulator of total time the script has spent blocked at a
    /// checkpoint. The execute loop adds this to the deadline so a paused script
    /// never trips the timeout.
    pub fn paused_clock(&self) -> Arc<AtomicU64> {
        self.inner.paused_clock.clone()
    }

    /// Clears and replaces all breakpoints for `source`. Returns the bound
    /// breakpoints; `verified` is `false` when a requested line cannot bind
    /// (here: line < 1).
    pub fn set_breakpoints(
        &self,
        source: &str,
        breakpoints: &[SourceBreakpoint],
    ) -> Vec<Breakpoint> {
        let mut state = self.inner.state.lock().unwrap();
        state.breakpoints.retain(|b| b.source != source);
        let mut out = Vec::new();
        for sb in breakpoints {
            state.next_bp_id += 1;
            let id = state.next_bp_id;
            let verified = sb.line >= 1;
            let bp = Breakpoint {
                id,
                verified,
                line: sb.line,
                column: sb.column,
                source: source.to_string(),
            };
            if verified {
                state.breakpoints.push(BoundBreakpoint {
                    id,
                    line: sb.line,
                    column: sb.column,
                    condition: sb.condition.clone(),
                    source: source.to_string(),
                });
            }
            out.push(bp.clone());
            if let Some(ref sink) = self.inner.options.on_breakpoint_changed {
                sink(bp);
            }
        }
        out
    }

    pub fn clear_breakpoints(&self, source: &str) {
        let mut state = self.inner.state.lock().unwrap();
        state.breakpoints.retain(|b| b.source != source);
    }

    /// Requests a stop at the next checkpoint.
    pub fn pause(&self) {
        let mut state = self.inner.state.lock().unwrap();
        state.pause_requested = true;
    }

    pub fn resume(&self) {
        self.resume_with(StepMode::None);
    }

    /// Alias for [`DebugSession::resume`] matching the DAP `continue` verb.
    pub fn r#continue(&self) {
        self.resume();
    }

    pub fn step_in(&self) {
        self.resume_with(StepMode::In);
    }

    pub fn step_over(&self) {
        self.resume_with(StepMode::Over);
    }

    pub fn step_out(&self) {
        self.resume_with(StepMode::Out);
    }

    fn resume_with(&self, mode: StepMode) {
        let mut state = self.inner.state.lock().unwrap();
        state.step = mode;
        state.pause_requested = false;
        state.paused = false;
        drop(state);
        self.inner.resume.notify_all();
        if let Some(ref sink) = self.inner.options.on_continued {
            sink(DEBUG_THREAD_ID);
        }
    }

    /// Returns the captured call stack, innermost frame first. Valid only while
    /// paused; an empty vec otherwise.
    pub fn stack_trace(&self) -> Vec<StackFrame> {
        let state = self.inner.state.lock().unwrap();
        let mut frames = state.frames.clone();
        frames.reverse();
        frames
    }

    /// Returns the scopes for `frame_id`. The instrumented backend exposes a
    /// single `Local` scope per frame plus a shared `Global` scope.
    pub fn scopes(&self, frame_id: i64) -> Vec<Scope> {
        let mut state = self.inner.state.lock().unwrap();
        if !state.frames.iter().any(|f| f.id == frame_id) {
            return Vec::new();
        }
        let local_ref = state.registry.alloc(Vec::new());
        let global_ref = state.registry.alloc(Vec::new());
        vec![
            Scope {
                name: "Local".into(),
                variables_reference: local_ref,
                expensive: false,
            },
            Scope {
                name: "Global".into(),
                variables_reference: global_ref,
                expensive: true,
            },
        ]
    }

    /// Returns the children of `variables_reference`. A leaf (`0`) returns empty.
    pub fn variables(&self, variables_reference: i64) -> Vec<Variable> {
        if variables_reference == 0 {
            return Vec::new();
        }
        let state = self.inner.state.lock().unwrap();
        state
            .registry
            .entries
            .get(&variables_reference)
            .cloned()
            .unwrap_or_default()
    }

    /// Inspect-only expression evaluation in a frame context. The instrumented
    /// backend cannot reach paused frame state, so this uniformly reports
    /// unsupported, matching the cross-runtime contract.
    pub fn evaluate(&self, _expression: &str, _frame_id: Option<i64>) -> Result<Variable> {
        Err(XriptError::Script(
            "debug evaluate is unsupported on the instrumented rquickjs backend".into(),
        ))
    }

    pub fn is_terminated(&self) -> bool {
        self.inner.terminated.load(Ordering::SeqCst)
    }

    fn signal_terminated(&self) {
        self.inner.terminated.store(true, Ordering::SeqCst);
        if let Some(ref sink) = self.inner.options.on_terminated {
            sink();
        }
    }

    /// The probe entry point. Called from the executing script at each statement
    /// boundary. Decides whether to stop, fires `on_stopped`, and blocks until a
    /// resume verb. Returns immediately when neither a breakpoint nor a pending
    /// step/pause applies.
    fn on_checkpoint(&self, line: i64, column: i64) {
        let reason = {
            let state = self.inner.state.lock().unwrap();
            let hit: Vec<i64> = state
                .breakpoints
                .iter()
                .filter(|b| {
                    b.line == line
                        && b.condition.is_none()
                        && b.column.map(|c| c == column).unwrap_or(true)
                })
                .map(|b| b.id)
                .collect();
            if !hit.is_empty() {
                Some((StopReason::Breakpoint, Some(hit)))
            } else if state.pause_requested {
                Some((StopReason::Pause, None))
            } else if state.step != StepMode::None {
                Some((StopReason::Step, None))
            } else {
                None
            }
        };

        let Some((reason, hit_ids)) = reason else {
            return;
        };

        let source = {
            let mut state = self.inner.state.lock().unwrap();
            state.registry.reset();
            let source = state
                .frames
                .last()
                .map(|f| f.source.clone())
                .unwrap_or_default();
            if let Some(frame) = state.frames.last_mut() {
                frame.line = line;
                frame.column = column;
            }
            state.paused = true;
            state.pause_requested = false;
            source
        };

        if let Some(ref sink) = self.inner.options.on_stopped {
            sink(StoppedEvent {
                reason,
                thread_id: DEBUG_THREAD_ID,
                hit_breakpoint_ids: hit_ids,
                description: Some(source),
            });
        }

        let block_start = std::time::Instant::now();
        let mut state = self.inner.state.lock().unwrap();
        while state.paused {
            state = self.inner.resume.wait(state).unwrap();
        }
        let blocked = block_start.elapsed().as_millis() as u64;
        state.paused_clock_ms += blocked;
        self.inner
            .paused_clock
            .store(state.paused_clock_ms, Ordering::Relaxed);
    }

    fn push_frame(&self, name: String, source: String, line: i64, column: i64) {
        let mut state = self.inner.state.lock().unwrap();
        let id = state.frames.len() as i64 + 1;
        state.frames.push(StackFrame {
            id,
            name,
            line,
            column,
            source,
        });
    }

    fn pop_frame(&self) {
        let mut state = self.inner.state.lock().unwrap();
        state.frames.pop();
    }
}

/// Registers the `__xript_dbg` probe bridge into the sandbox context so an
/// instrumented script can call back into the [`DebugSession`] at each statement
/// boundary. Also seeds a synthetic top-level frame.
pub(crate) fn register_debug_probe(ctx: &Ctx<'_>, session: &DebugSession) -> Result<()> {
    session.push_frame("<script>".into(), "<entry>".into(), 1, 1);

    let probe_session = session.clone();
    let probe = Function::new(ctx.clone(), move |line: i64, column: i64| {
        probe_session.on_checkpoint(line, column);
    })
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    let enter_session = session.clone();
    let enter = Function::new(
        ctx.clone(),
        move |name: String, source: String, line: i64, column: i64| {
            enter_session.push_frame(name, source, line, column);
        },
    )
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    let leave_session = session.clone();
    let leave = Function::new(ctx.clone(), move || {
        leave_session.pop_frame();
    })
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    let term_session = session.clone();
    let terminate = Function::new(ctx.clone(), move || {
        term_session.signal_terminated();
    })
    .map_err(|e| XriptError::Engine(e.to_string()))?;

    ctx.globals()
        .set("__xript_dbg", probe)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    ctx.globals()
        .set("__xript_dbg_enter", enter)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    ctx.globals()
        .set("__xript_dbg_leave", leave)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    ctx.globals()
        .set("__xript_dbg_terminate", terminate)
        .map_err(|e| XriptError::Engine(e.to_string()))?;
    Ok(())
}

/// Rewrites `source` to inject a `__xript_dbg(line, column)` probe call at the
/// start of each statement-bearing line, binding instrumentation to real source
/// positions. A statement-bearing line is a non-blank line whose first
/// non-whitespace token is not a closing brace, a comment, or a bare block
/// opener. The host runs this before passing code to the runtime when it wants
/// breakpoints/stepping bound to source positions.
pub fn instrument_source(source: &str) -> String {
    let mut out = String::with_capacity(source.len() * 2);
    for (idx, raw_line) in source.lines().enumerate() {
        let line_no = idx as i64 + 1;
        let trimmed = raw_line.trim_start();
        let indent_len = raw_line.len() - trimmed.len();
        let column = indent_len as i64 + 1;
        if is_statement_boundary(trimmed) {
            out.push_str(&raw_line[..indent_len]);
            out.push_str(&format!("__xript_dbg({}, {}); ", line_no, column));
            out.push_str(trimmed);
        } else {
            out.push_str(raw_line);
        }
        out.push('\n');
    }
    out
}

fn is_statement_boundary(trimmed: &str) -> bool {
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
        return false;
    }
    let first = trimmed.chars().next().unwrap();
    if matches!(first, '}' | ')' | ']') {
        return false;
    }
    if trimmed == "{" {
        return false;
    }
    true
}
