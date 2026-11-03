//! One events bus shared by several runtimes.
//!
//! Each runtime in an [`XriptPool`](crate::XriptPool) has its own interpreter,
//! and a handler can only run in the interpreter that subscribed it. What the
//! workers can share is everything else: the catalogue, the namespace claims,
//! and the subscription records (owner, event, order, `once`), which this hub
//! holds as the JSON state the bus kernel reads and commits. A commit names the
//! version it read and is refused if another worker committed first, so the
//! kernel retries against the newer state; no lock is ever held while script
//! runs.
//!
//! Delivery to a handler that lives on another worker is a request queued for
//! that worker. The emitting worker waits for the answer in short slices, and
//! while it waits it serves any request queued for itself, so two workers
//! emitting into each other cannot deadlock. An idle worker is woken to serve
//! its queue; a busy one serves it before its next command.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// How long one wait for a reply blocks before handing control back to the
/// kernel, which re-checks the waiting call's own budget between slices.
const POLL_SLICE: Duration = Duration::from_millis(5);

const SKIPPED: &str = r#"{"ran":false}"#;

type Waker = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct HubState {
    version: u64,
    state: Option<String>,
    inbox: HashMap<usize, VecDeque<String>>,
    replies: HashMap<u64, String>,
    awaiting: HashMap<u64, usize>,
    next_ticket: u64,
    wakers: HashMap<usize, Waker>,
    retired: HashSet<usize>,
    hook_seq: u64,
    hook_workers: HashMap<String, std::collections::BTreeSet<usize>>,
    /// Wakers of callers awaiting an answer rather than blocking on one.
    reply_wakers: HashMap<u64, std::task::Waker>,
}

/// The bus state a pool's workers share.
#[derive(Default)]
pub(crate) struct BusHub {
    state: Mutex<HubState>,
    signal: Condvar,
}

/// One runtime's seat on a shared bus.
#[derive(Clone)]
pub(crate) struct BusPeer {
    pub(crate) hub: Arc<BusHub>,
    pub(crate) worker: usize,
}

impl BusHub {
    fn lock(&self) -> MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The next hook-registration sequence number, pool-wide, recording that
    /// `worker` now holds a handler for `hook`.
    pub(crate) fn next_hook_seq(&self, worker: usize, hook: &str) -> u64 {
        let mut hub = self.lock();
        hub.hook_seq += 1;
        hub.hook_workers.entry(hook.to_string()).or_default().insert(worker);
        hub.hook_seq
    }

    /// Every live worker holding a handler registered for `hook`.
    pub(crate) fn hook_workers(&self, hook: &str) -> Vec<usize> {
        let hub = self.lock();
        hub.hook_workers
            .get(hook)
            .map(|workers| workers.iter().copied().filter(|w| !hub.retired.contains(w)).collect())
            .unwrap_or_default()
    }

    /// The shared state as `{ "version": n, "state": {...} }`.
    pub(crate) fn read(&self) -> String {
        let hub = self.lock();
        format!(
            r#"{{"version":{},"state":{}}}"#,
            hub.version,
            hub.state.as_deref().unwrap_or("{}")
        )
    }

    /// Commits `state` if nobody committed since `version` was read.
    pub(crate) fn write(&self, version: u64, state: String) -> bool {
        let mut hub = self.lock();
        if hub.version != version {
            return false;
        }
        hub.version += 1;
        hub.state = Some(state);
        true
    }

    /// Lets `worker` be woken when a request is queued for it.
    pub(crate) fn register(&self, worker: usize, waker: Waker) {
        let mut hub = self.lock();
        hub.retired.remove(&worker);
        hub.wakers.insert(worker, waker);
    }

    /// Takes `worker` off the bus: what is queued for it, and anything asked of
    /// it from now on, is answered as a handler that did not run.
    pub(crate) fn retire(&self, worker: usize) {
        let mut hub = self.lock();
        hub.retired.insert(worker);
        hub.wakers.remove(&worker);
        let queued: Vec<String> = hub.inbox.remove(&worker).map(Vec::from).unwrap_or_default();
        for request in queued {
            if let Some(id) = request_id(&request) {
                hub.replies.insert(id, done(SKIPPED));
                hub.awaiting.remove(&id);
            }
        }
        let stranded: Vec<u64> = hub
            .awaiting
            .iter()
            .filter(|(_, target)| **target == worker)
            .map(|(id, _)| *id)
            .collect();
        for id in stranded {
            hub.awaiting.remove(&id);
            hub.replies.insert(id, done(SKIPPED));
        }
        let wakers: Vec<std::task::Waker> = hub.reply_wakers.drain().map(|(_, waker)| waker).collect();
        drop(hub);
        self.signal.notify_all();
        for waker in wakers {
            waker.wake();
        }
    }

    /// Queues `request` (the kernel's `{ "token", "args" }`) for `worker` and
    /// returns the ticket its answer will arrive under.
    pub(crate) fn call(&self, worker: usize, request: &str) -> u64 {
        let mut hub = self.lock();
        hub.next_ticket += 1;
        let ticket = hub.next_ticket;
        if hub.retired.contains(&worker) || !hub.wakers.contains_key(&worker) {
            hub.replies.insert(ticket, done(SKIPPED));
            return ticket;
        }
        let body = request.strip_prefix('{').unwrap_or("}");
        let separator = if body.starts_with('}') { "" } else { "," };
        hub.inbox
            .entry(worker)
            .or_default()
            .push_back(format!(r#"{{"id":{ticket}{separator}{body}"#));
        hub.awaiting.insert(ticket, worker);
        let waker = hub.wakers.get(&worker).cloned();
        drop(hub);
        self.signal.notify_all();
        if let Some(waker) = waker {
            waker();
        }
        ticket
    }

    /// Waits one slice for `ticket`'s answer or for a request queued for
    /// `worker`, whichever comes first. `None` when the slice ran out.
    pub(crate) fn poll(&self, worker: usize, ticket: u64) -> Option<String> {
        let mut hub = self.lock();
        let mut waited = false;
        loop {
            if let Some(answer) = hub.replies.remove(&ticket) {
                return Some(answer);
            }
            if let Some(request) = hub.inbox.get_mut(&worker).and_then(VecDeque::pop_front) {
                return Some(format!(r#"{{"serve":{request}}}"#));
            }
            if waited {
                return None;
            }
            let (next, _) = self
                .signal
                .wait_timeout(hub, POLL_SLICE)
                .unwrap_or_else(|p| p.into_inner());
            hub = next;
            waited = true;
        }
    }

    /// The next request queued for `worker`, without waiting.
    pub(crate) fn take(&self, worker: usize) -> Option<String> {
        self.lock().inbox.get_mut(&worker).and_then(VecDeque::pop_front)
    }

    /// Whether anything is queued for `worker`.
    pub(crate) fn pending(&self, worker: usize) -> bool {
        self.lock().inbox.get(&worker).is_some_and(|queue| !queue.is_empty())
    }

    /// Answers request `id` with the kernel's outcome.
    pub(crate) fn reply(&self, id: u64, outcome: &str) {
        let mut hub = self.lock();
        let waker = if hub.awaiting.remove(&id).is_some() {
            hub.replies.insert(id, done(outcome));
            hub.reply_wakers.remove(&id)
        } else {
            None
        };
        drop(hub);
        self.signal.notify_all();
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// The outcome of `ticket` once it is answered, without blocking: the
    /// kernel's outcome alone, as `peer.reply` gave it. A caller polling this
    /// holds no thread while it waits.
    pub(crate) fn poll_answer(&self, ticket: u64, cx: &mut std::task::Context<'_>) -> std::task::Poll<String> {
        let mut hub = self.lock();
        if let Some(answer) = hub.replies.remove(&ticket) {
            hub.reply_wakers.remove(&ticket);
            let outcome = serde_json::from_str::<serde_json::Value>(&answer)
                .ok()
                .and_then(|parsed| parsed.get("outcome").map(|o| o.to_string()))
                .unwrap_or_else(|| SKIPPED.to_string());
            return std::task::Poll::Ready(outcome);
        }
        hub.reply_wakers.insert(ticket, cx.waker().clone());
        std::task::Poll::Pending
    }

    /// Stops waiting for `ticket`; a late answer is dropped.
    pub(crate) fn abandon(&self, ticket: u64) {
        let mut hub = self.lock();
        hub.reply_wakers.remove(&ticket);
        hub.replies.remove(&ticket);
    }

    /// The worker holding the earliest live subscription to `event`, and the
    /// owners of every subscription to it, read from the shared state.
    pub(crate) fn subscribers_of(&self, event: &str) -> Option<(usize, Vec<String>)> {
        let hub = self.lock();
        let state: serde_json::Value = serde_json::from_str(hub.state.as_deref()?).ok()?;
        let tokens = state.get("byEvent")?.get(event)?.as_array()?;
        let subscriptions = state.get("subscriptions")?;
        let mut first = None;
        let mut owners = Vec::new();
        for token in tokens.iter().filter_map(|t| t.as_str()) {
            let Some(subscription) = subscriptions.get(token) else { continue };
            if let Some(owner) = subscription.get("owner").and_then(|o| o.as_str()) {
                owners.push(owner.to_string());
            }
            let worker = subscription.get("worker").and_then(|w| w.as_u64()).map(|w| w as usize);
            if first.is_none()
                && let Some(worker) = worker
                && !hub.retired.contains(&worker)
            {
                first = Some(worker);
            }
        }
        first.map(|worker| (worker, owners))
    }
}

fn done(outcome: &str) -> String {
    format!(r#"{{"done":true,"outcome":{outcome}}}"#)
}

fn request_id(request: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(request).ok()?.get("id")?.as_u64()
}
