//! Which mod is running right now.
//!
//! One [`CallerContext`] per runtime is the single answer to "on whose behalf
//! is this script code running". The runtime enters a mod around its entry
//! evaluation, an export it owns, each of its hook and event handlers during a
//! dispatch, and a retained callback it supplied; host-run code (a plain
//! `execute`) runs with no mod entered.
//!
//! On a yielding runtime calls park on async bindings and resume in any order,
//! so one stack cannot answer the question: whatever another call pushed last
//! would be on top when a parked call resumes. Each yielding call therefore
//! runs in a **lane** of its own, seeded with the mod it runs for. Its polls,
//! and the resumptions an async binding it called hands back, enter that lane,
//! so attribution follows the logical call rather than the top of a stack.
//! A continuation that outlives its call finds the lane gone and runs on behalf
//! of no mod.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// The lane every runtime starts in, and the only one a sync runtime uses.
const ROOT: u64 = 0;

#[derive(Debug, Clone)]
struct Frame {
    id: u64,
    mod_id: Option<String>,
    /// Pushed by [`CallerContext::enter`], so a yielding call started under it
    /// may borrow it as its lane's base.
    seed: bool,
    /// How many live lanes borrowed this frame. A borrowed frame is hidden
    /// from its own lane, so a call that parked under it does not leak its
    /// owner into host code that runs meanwhile.
    lent: u32,
}

#[derive(Debug, Default)]
struct State {
    lanes: HashMap<u64, Vec<Frame>>,
    live: HashSet<u64>,
    active: u64,
    next_lane: u64,
    next_frame: u64,
}

impl State {
    fn new() -> Self {
        Self {
            lanes: HashMap::from([(ROOT, Vec::new())]),
            live: HashSet::from([ROOT]),
            active: ROOT,
            next_lane: ROOT + 1,
            next_frame: 0,
        }
    }

    fn push(&mut self, mod_id: Option<String>, seed: bool) -> (u64, u64) {
        self.next_frame += 1;
        let id = self.next_frame;
        let lane = self.active;
        self.lanes.entry(lane).or_default().push(Frame { id, mod_id, seed, lent: 0 });
        (lane, id)
    }

    /// Drops a lane that holds nothing and that no call owns any more.
    fn tidy(&mut self, lane: u64) {
        if !self.live.contains(&lane) && self.lanes.get(&lane).is_some_and(Vec::is_empty) {
            self.lanes.remove(&lane);
        }
    }
}

/// The mods currently running, kept per lane, innermost last. `None` entries
/// mark host-run regions nested inside a mod's.
#[derive(Debug, Clone)]
pub struct CallerContext {
    state: Arc<Mutex<State>>,
    /// The lane in force, readable without the lock, for the interrupt
    /// handler to charge running bytecode to the right call's budget.
    active: Arc<AtomicU64>,
}

impl Default for CallerContext {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::new())),
            active: Arc::new(AtomicU64::new(ROOT)),
        }
    }
}

impl CallerContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// The mod running right now, or `None` for host-run code.
    pub fn current(&self) -> Option<String> {
        let state = self.lock();
        state
            .lanes
            .get(&state.active)
            .and_then(|frames| frames.iter().rev().find(|frame| frame.lent == 0))
            .and_then(|frame| frame.mod_id.clone())
    }

    /// Enters `mod_id` until the returned guard is dropped.
    pub fn enter(&self, mod_id: Option<String>) -> CallerGuard {
        let (lane, frame) = self.lock().push(mod_id, true);
        CallerGuard {
            state: self.state.clone(),
            lane,
            frame,
        }
    }

    /// Enters `mod_id` without a guard, for a region whose end is signalled
    /// separately (a sandbox-side dispatch loop calling back per handler).
    /// Every `push` must be matched by a [`pop`](Self::pop).
    pub(crate) fn push(&self, mod_id: Option<String>) {
        self.lock().push(mod_id, false);
    }

    /// Leaves the innermost entered mod.
    pub(crate) fn pop(&self) {
        let mut state = self.lock();
        let lane = state.active;
        if let Some(frames) = state.lanes.get_mut(&lane) {
            frames.pop();
        }
        state.tidy(lane);
    }

    /// A guard that, when dropped, drops every mod entered after this point.
    ///
    /// An execution limit stops a script without running the `finally` blocks
    /// it was inside, so a sandbox-side dispatch's own [`pop`](Self::pop) may
    /// never happen; the outermost host entry restores the stack rather than
    /// leave a frame that would misattribute every later call.
    pub(crate) fn restore_point(&self) -> CallerRestorePoint {
        let state = self.lock();
        CallerRestorePoint {
            state: self.state.clone(),
            lane: state.active,
            depth: state.lanes.get(&state.active).map_or(0, Vec::len),
        }
    }

    /// Opens a lane for one yielding call, based on the mod in force now. The
    /// frame [`enter`](Self::enter) pushed for the call is borrowed into the
    /// lane and hidden where it was until the lane closes.
    pub(crate) fn fork(&self) -> CallerLane {
        let mut state = self.lock();
        let parent = state.active;
        let mut borrowed = None;
        let mut base = None;
        if let Some(frames) = state.lanes.get_mut(&parent)
            && let Some(top) = frames.iter_mut().rev().find(|frame| frame.lent == 0)
        {
            base = top.mod_id.clone();
            if top.seed {
                top.lent += 1;
                borrowed = Some(top.id);
            }
        }
        let id = state.next_lane;
        state.next_lane += 1;
        state.next_frame += 1;
        let frame = state.next_frame;
        state.lanes.insert(id, vec![Frame { id: frame, mod_id: base, seed: false, lent: 0 }]);
        state.live.insert(id);
        CallerLane {
            state: self.state.clone(),
            id,
            borrowed: borrowed.map(|frame| (parent, frame)),
        }
    }

    /// The lane in force right now, so a resumption can re-enter it later.
    pub(crate) fn active_lane(&self) -> u64 {
        self.active.load(Ordering::Relaxed)
    }

    /// Makes `lane` the one in force until the returned guard drops. A lane
    /// whose call has finished reads as empty: code run in it has no owner.
    pub(crate) fn activate(&self, lane: u64) -> ActiveLane {
        let mut state = self.lock();
        let previous = state.active;
        state.active = lane;
        self.active.store(lane, Ordering::Relaxed);
        ActiveLane {
            state: self.state.clone(),
            active: self.active.clone(),
            previous,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn lock(state: &Arc<Mutex<State>>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Leaves the mod its [`CallerContext::enter`] entered when dropped. It
/// removes its own frame wherever it sits, so calls that finish out of order
/// cannot pop each other's.
#[derive(Debug)]
pub struct CallerGuard {
    state: Arc<Mutex<State>>,
    lane: u64,
    frame: u64,
}

impl Drop for CallerGuard {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        if let Some(frames) = state.lanes.get_mut(&self.lane)
            && let Some(at) = frames.iter().rposition(|frame| frame.id == self.frame)
        {
            frames.remove(at);
        }
        state.tidy(self.lane);
    }
}

/// Truncates the stack back to its depth at [`CallerContext::restore_point`] when dropped.
#[derive(Debug)]
#[must_use = "the stack is restored as soon as the guard drops"]
pub(crate) struct CallerRestorePoint {
    state: Arc<Mutex<State>>,
    lane: u64,
    depth: usize,
}

impl Drop for CallerRestorePoint {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        if let Some(frames) = state.lanes.get_mut(&self.lane) {
            frames.truncate(self.depth);
        }
        state.tidy(self.lane);
    }
}

/// One yielding call's lane, closed when dropped.
#[derive(Debug)]
pub(crate) struct CallerLane {
    state: Arc<Mutex<State>>,
    id: u64,
    borrowed: Option<(u64, u64)>,
}

impl CallerLane {
    pub(crate) fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for CallerLane {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        state.live.remove(&self.id);
        state.lanes.remove(&self.id);
        if let Some((lane, frame)) = self.borrowed
            && let Some(frames) = state.lanes.get_mut(&lane)
            && let Some(found) = frames.iter_mut().find(|candidate| candidate.id == frame)
        {
            found.lent = found.lent.saturating_sub(1);
        }
    }
}

/// Restores the lane that was in force before [`CallerContext::activate`].
#[derive(Debug)]
#[must_use = "the lane is left as soon as the guard drops"]
pub(crate) struct ActiveLane {
    state: Arc<Mutex<State>>,
    active: Arc<AtomicU64>,
    previous: u64,
}

impl Drop for ActiveLane {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        let left = state.active;
        state.active = self.previous;
        self.active.store(self.previous, Ordering::Relaxed);
        state.tidy(left);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nests_and_restores() {
        let caller = CallerContext::new();
        assert_eq!(caller.current(), None);
        {
            let _alpha = caller.enter(Some("alpha".into()));
            assert_eq!(caller.current().as_deref(), Some("alpha"));
            {
                let _host = caller.enter(None);
                assert_eq!(caller.current(), None);
            }
            assert_eq!(caller.current().as_deref(), Some("alpha"));
        }
        assert_eq!(caller.current(), None);
    }

    #[test]
    fn guards_dropped_out_of_order_remove_their_own_frames() {
        let caller = CallerContext::new();
        let alpha = caller.enter(Some("alpha".into()));
        let beta = caller.enter(Some("beta".into()));
        drop(alpha);
        assert_eq!(caller.current().as_deref(), Some("beta"));
        drop(beta);
        assert_eq!(caller.current(), None);
    }

    #[test]
    fn lanes_keep_interleaved_calls_apart() {
        let caller = CallerContext::new();
        let alpha_guard = caller.enter(Some("alpha".into()));
        let alpha = caller.fork();
        assert_eq!(caller.current(), None, "a borrowed frame is hidden where it was");
        let beta_guard = caller.enter(Some("beta".into()));
        let beta = caller.fork();
        {
            let _in = caller.activate(alpha.id());
            assert_eq!(caller.current().as_deref(), Some("alpha"));
        }
        {
            let _in = caller.activate(beta.id());
            assert_eq!(caller.current().as_deref(), Some("beta"));
        }
        let finished = alpha.id();
        drop(alpha);
        drop(alpha_guard);
        {
            let _in = caller.activate(finished);
            assert_eq!(caller.current(), None, "a finished call's lane has no owner");
            caller.push(Some("gamma".into()));
            assert_eq!(caller.current().as_deref(), Some("gamma"));
            caller.pop();
        }
        drop(beta);
        drop(beta_guard);
        assert_eq!(caller.current(), None);
        assert_eq!(caller.lock().lanes.len(), 1);
    }
}
