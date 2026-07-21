//! The non-blocking result of a call into a runtime thread.
//!
//! Every [`XriptHandle`](crate::handle::XriptHandle) verb returns a
//! [`Pending<T>`] instead of blocking the caller. A `Pending` can be awaited as
//! a [`Future`], polled once per frame with [`Pending::try_take`], handed a
//! callback with [`Pending::on_complete`], or blocked on explicitly with
//! [`Pending::wait`].
//!
//! The oneshot behind it is hand-rolled so the crate keeps its dependency set:
//! a `Pending` is a real `Future` under tokio, async-std, smol, `pollster`, or
//! no executor at all, and no foreign type appears in the public API.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use crate::error::{Result, XriptError};

/// A cancellation flag scoped to one call.
///
/// Unlike [`CancellationToken`](crate::sandbox::CancellationToken), which is
/// runtime-wide and sticky, a `CallToken` is created per command and dies with
/// it, so cancelling one call never poisons the runtime for the next.
///
/// # What a tripped token actually stops
///
/// A token tripped **before** the command is dequeued skips the call outright,
/// unconditionally. A token tripped **while** the call runs is observed by the
/// QuickJS interrupt handler, which only fires while bytecode is executing —
/// so a call sitting inside a blocking host binding does not observe it until
/// the binding returns. See `spec/execution.md`: xript's limits bound script
/// execution, not host-binding execution.
#[derive(Debug, Clone, Default)]
pub struct CallToken {
    flag: Arc<AtomicBool>,
}

impl CallToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Whether two tokens govern the same call. Identity, not equality: a
    /// pool needs to tell the call its worker is *running* from the ones still
    /// queued behind it, and only the former is beyond reach.
    pub fn same_call(&self, other: &CallToken) -> bool {
        Arc::ptr_eq(&self.flag, &other.flag)
    }
}

/// What a dropped [`Pending`] does to the call behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropPolicy {
    /// Trip the call's [`CallToken`]. The default: a host that stops caring
    /// about a result stops paying for it.
    Cancel,
    /// Leave the call running. What [`Pending::detach`] installs.
    Detach,
}

const EMPTY: u8 = 0;
const READY: u8 = 1;
const TAKEN: u8 = 2;

type Callback<T> = Box<dyn FnOnce(Result<T>) + Send + 'static>;

struct Waiters<T> {
    waker: Option<Waker>,
    on_complete: Option<Callback<T>>,
}

struct Slot<T> {
    state: AtomicU8,
    value: std::cell::UnsafeCell<Option<Result<T>>>,
    waiters: Mutex<Waiters<T>>,
    ready: Condvar,
}

// The value cell is written exactly once by the producer while it holds
// `waiters`, and read exactly once by whichever consumer wins the
// READY -> TAKEN compare-exchange. No other access exists.
unsafe impl<T: Send> Send for Slot<T> {}
unsafe impl<T: Send> Sync for Slot<T> {}

impl<T> Slot<T> {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(EMPTY),
            value: std::cell::UnsafeCell::new(None),
            waiters: Mutex::new(Waiters {
                waker: None,
                on_complete: None,
            }),
            ready: Condvar::new(),
        }
    }

    /// Claims the value if one is ready. At most one caller ever wins.
    fn take(&self) -> Option<Result<T>> {
        if self
            .state
            .compare_exchange(READY, TAKEN, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        unsafe { (*self.value.get()).take() }
    }
}

/// The producer half. Completing it wakes whatever the consumer is doing.
pub(crate) struct Completer<T> {
    slot: Arc<Slot<T>>,
    done: bool,
}

impl<T: Send + 'static> Completer<T> {
    pub(crate) fn complete(mut self, value: Result<T>) {
        self.done = true;
        self.deliver(value);
    }

    fn deliver(&self, value: Result<T>) {
        let mut waiters = self.slot.waiters.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            *self.slot.value.get() = Some(value);
        }
        self.slot.state.store(READY, Ordering::Release);
        let callback = waiters.on_complete.take();
        let waker = waiters.waker.take();
        drop(waiters);

        if let Some(callback) = callback {
            if let Some(value) = self.slot.take() {
                callback(value);
            }
            return;
        }
        self.slot.ready.notify_all();
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<T> Drop for Completer<T> {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        // The worker went away without replying. Fail the call rather than
        // leaving the consumer parked forever.
        let mut waiters = self.slot.waiters.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            *self.slot.value.get() = Some(Err(XriptError::Engine(
                "runtime thread dropped response".into(),
            )));
        }
        self.slot.state.store(READY, Ordering::Release);
        let callback = waiters.on_complete.take();
        let waker = waiters.waker.take();
        drop(waiters);
        if let Some(callback) = callback {
            if let Some(value) = self.slot.take() {
                callback(value);
            }
            return;
        }
        self.slot.ready.notify_all();
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

/// A call in flight on a runtime thread.
///
/// Four ways to consume one, none of which block unless named:
///
/// ```ignore
/// handle.execute("2 + 2").await?;              // Future — the Tauri shape
/// if let Some(r) = pending.try_take() { .. }   // immediate-mode loop, no executor
/// pending.on_complete(|r| { .. });             // callback host
/// handle.execute("2 + 2").wait()?;             // explicit opt-in to blocking
/// ```
///
/// **Dropping a `Pending` cancels its call** unless [`Pending::detach`] was
/// called. `let _ = handle.execute(..);` therefore cancels; bind the value or
/// detach it.
#[must_use = "a dropped Pending cancels its call; use .wait(), .detach(), .on_complete(), or await it"]
pub struct Pending<T> {
    slot: Arc<Slot<T>>,
    token: CallToken,
    on_drop: DropPolicy,
}

impl<T: Send + 'static> Pending<T> {
    pub(crate) fn new(token: CallToken) -> (Completer<T>, Self) {
        let slot = Arc::new(Slot::new());
        (
            Completer {
                slot: slot.clone(),
                done: false,
            },
            Self {
                slot,
                token,
                on_drop: DropPolicy::Cancel,
            },
        )
    }

    /// An already-complete `Pending` with no channel and no thread behind it.
    /// This is what the off-thread fast lane returns.
    pub fn ready(value: Result<T>) -> Self {
        let (completer, pending) = Self::new(CallToken::new());
        completer.complete(value);
        pending
    }

    /// The result if the call has finished, `None` while it is still running.
    ///
    /// Returns `None` forever once the value has been taken.
    pub fn try_take(&mut self) -> Option<Result<T>> {
        self.slot.take()
    }

    /// True when a result is waiting to be taken.
    pub fn is_ready(&self) -> bool {
        self.slot.state.load(Ordering::Acquire) == READY
    }

    /// Blocks the calling thread until the call completes.
    ///
    /// This is the pre-`Pending` behavior, kept under a name that says so. Do
    /// not call it from a UI thread.
    pub fn wait(self) -> Result<T> {
        self.wait_inner(None)
    }

    /// Blocks for at most `timeout`.
    ///
    /// `Err(XriptError::Timeout { still_running: true })` means **the caller
    /// stopped waiting**, never that the call stopped. Nothing about a timed-out
    /// wait interrupts the work; see `spec/execution.md`.
    pub fn wait_timeout(self, timeout: Duration) -> Result<T> {
        self.wait_inner(Some(timeout))
    }

    fn wait_inner(self, timeout: Option<Duration>) -> Result<T> {
        let deadline = timeout.map(|t| std::time::Instant::now() + t);
        loop {
            if let Some(value) = self.slot.take() {
                return value;
            }
            if self.slot.state.load(Ordering::Acquire) == TAKEN {
                return Err(XriptError::Engine(
                    "this Pending's result was already taken".into(),
                ));
            }
            let waiters = self.slot.waiters.lock().unwrap_or_else(|e| e.into_inner());
            if self.slot.state.load(Ordering::Acquire) != EMPTY {
                continue;
            }
            match deadline {
                None => {
                    let _unused = self.slot.ready.wait(waiters).unwrap_or_else(|e| e.into_inner());
                }
                Some(deadline) => {
                    let now = std::time::Instant::now();
                    if now >= deadline {
                        return Err(XriptError::Timeout {
                            still_running: true,
                        });
                    }
                    let (_unused, result) = self
                        .slot
                        .ready
                        .wait_timeout(waiters, deadline - now)
                        .unwrap_or_else(|e| e.into_inner());
                    if result.timed_out() && self.slot.state.load(Ordering::Acquire) == EMPTY {
                        return Err(XriptError::Timeout {
                            still_running: true,
                        });
                    }
                }
            }
        }
    }

    /// Hands the result to `f` when the call completes, and returns now.
    ///
    /// `f` runs **on the runtime thread**, immediately after the call it
    /// belongs to. A callback that blocks holds that thread exactly as a
    /// blocking host binding would. If the call has already completed, `f` runs
    /// on the calling thread before this returns.
    ///
    /// Registering a callback detaches the call: it will not be cancelled.
    pub fn on_complete(self, f: impl FnOnce(Result<T>) + Send + 'static) {
        let mut me = self;
        me.on_drop = DropPolicy::Detach;
        let mut waiters = me.slot.waiters.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(value) = me.slot.take() {
            drop(waiters);
            f(value);
            return;
        }
        waiters.on_complete = Some(Box::new(f));
    }

    /// Trips this call's token.
    ///
    /// A call that has not been dequeued yet is skipped outright. A call that
    /// is running observes this the next time the interpreter executes
    /// bytecode — which for a call blocked inside a host binding is when that
    /// binding returns, and for a wedged one is never.
    pub fn cancel(&self) {
        self.token.cancel();
    }

    /// Opts out of cancel-on-drop: the call runs to completion and its result
    /// is discarded.
    pub fn detach(mut self) {
        self.on_drop = DropPolicy::Detach;
    }

    /// This call's token, for a host that wants to cancel from elsewhere.
    pub fn token(&self) -> CallToken {
        self.token.clone()
    }

    /// What a drop of this `Pending` will do.
    pub fn drop_policy(&self) -> DropPolicy {
        self.on_drop
    }
}

impl<T> Drop for Pending<T> {
    fn drop(&mut self) {
        if self.on_drop == DropPolicy::Cancel && self.slot.state.load(Ordering::Acquire) == EMPTY {
            self.token.cancel();
        }
    }
}

impl<T: Send + 'static> Future for Pending<T> {
    type Output = Result<T>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let me = self.get_mut();
        if let Some(value) = me.slot.take() {
            return Poll::Ready(value);
        }
        let mut waiters = me.slot.waiters.lock().unwrap_or_else(|e| e.into_inner());
        waiters.waker = Some(cx.waker().clone());
        drop(waiters);
        // Re-check: the producer may have completed between the take above and
        // the waker being registered.
        match me.slot.take() {
            Some(value) => Poll::Ready(value),
            None => Poll::Pending,
        }
    }
}

impl<T> std::fmt::Debug for Pending<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pending")
            .field("ready", &(self.slot.state.load(Ordering::Acquire) == READY))
            .field("on_drop", &self.on_drop)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn try_take_is_none_until_complete() {
        let (completer, mut pending) = Pending::<u32>::new(CallToken::new());
        assert!(pending.try_take().is_none());
        completer.complete(Ok(7));
        assert_eq!(pending.try_take().unwrap().unwrap(), 7);
        assert!(pending.try_take().is_none());
    }

    #[test]
    fn ready_needs_no_thread() {
        let pending = Pending::ready(Ok(3u32));
        assert!(pending.is_ready());
        assert_eq!(pending.wait().unwrap(), 3);
    }

    #[test]
    fn wait_blocks_until_a_producer_completes() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            completer.complete(Ok(11));
        });
        assert_eq!(pending.wait().unwrap(), 11);
    }

    #[test]
    fn wait_timeout_bounds_the_caller_not_the_call() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        let err = pending.wait_timeout(Duration::from_millis(20)).unwrap_err();
        assert!(matches!(
            err,
            XriptError::Timeout {
                still_running: true
            }
        ));
        // The call is untouched; completing it still works.
        completer.complete(Ok(1));
    }

    #[test]
    fn dropping_cancels_by_default() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        let token = pending.token();
        drop(pending);
        assert!(token.is_cancelled());
        completer.complete(Ok(1));
    }

    #[test]
    fn detach_opts_out_of_cancel_on_drop() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        let token = pending.token();
        pending.detach();
        assert!(!token.is_cancelled());
        completer.complete(Ok(1));
    }

    #[test]
    fn dropping_a_completed_pending_does_not_cancel() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        let token = pending.token();
        completer.complete(Ok(1));
        drop(pending);
        assert!(!token.is_cancelled());
    }

    #[test]
    fn on_complete_runs_on_the_producer_thread() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        let (tx, rx) = std::sync::mpsc::channel();
        let producer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            let id = std::thread::current().id();
            completer.complete(Ok(5));
            id
        });
        pending.on_complete(move |r| {
            let _unused = tx.send((std::thread::current().id(), r.unwrap()));
        });
        let (callback_thread, value) = rx.recv().unwrap();
        assert_eq!(value, 5);
        assert_eq!(callback_thread, producer.join().unwrap());
    }

    #[test]
    fn on_complete_after_completion_runs_inline() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        completer.complete(Ok(9));
        let seen = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        pending.on_complete(move |r| *sink.lock().unwrap() = Some(r.unwrap()));
        assert_eq!(*seen.lock().unwrap(), Some(9));
    }

    #[test]
    fn on_complete_does_not_cancel() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        let token = pending.token();
        pending.on_complete(|_unused| {});
        assert!(!token.is_cancelled());
        completer.complete(Ok(1));
    }

    #[test]
    fn a_dropped_completer_fails_the_call() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        drop(completer);
        assert!(pending.wait().is_err());
    }

    #[test]
    fn awaits_under_pollster() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            completer.complete(Ok(42));
        });
        assert_eq!(pollster::block_on(pending).unwrap(), 42);
    }

    #[test]
    fn awaits_when_already_complete() {
        let (completer, pending) = Pending::<u32>::new(CallToken::new());
        completer.complete(Ok(8));
        assert_eq!(pollster::block_on(pending).unwrap(), 8);
    }

    #[test]
    fn poll_after_a_spurious_wake_still_resolves() {
        let (completer, mut pending) = Pending::<u32>::new(CallToken::new());
        let waker = Waker::noop().clone();
        let mut cx = Context::from_waker(&waker);
        assert!(Pin::new(&mut pending).poll(&mut cx).is_pending());
        assert!(Pin::new(&mut pending).poll(&mut cx).is_pending());
        completer.complete(Ok(2));
        match Pin::new(&mut pending).poll(&mut cx) {
            Poll::Ready(v) => assert_eq!(v.unwrap(), 2),
            Poll::Pending => panic!("completed Pending polled Pending"),
        }
    }

    #[test]
    fn call_tokens_are_independent() {
        let a = CallToken::new();
        let b = CallToken::new();
        a.cancel();
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled());
    }

    /// Producer, consumer and drop interleave every way the scheduler allows.
    /// Exactly one of "value observed" or "consumer gone" must hold each round,
    /// and nothing may hang.
    #[test]
    fn stress_producer_consumer_drop() {
        for round in 0..10_000u32 {
            let (completer, mut pending) = Pending::<u32>::new(CallToken::new());
            let producer = std::thread::spawn(move || completer.complete(Ok(round)));
            match round % 4 {
                0 => {
                    assert_eq!(pending.wait().unwrap(), round);
                }
                1 => {
                    assert_eq!(pollster::block_on(pending).unwrap(), round);
                }
                2 => {
                    let mut seen = None;
                    while seen.is_none() {
                        seen = pending.try_take();
                        std::thread::yield_now();
                    }
                    assert_eq!(seen.unwrap().unwrap(), round);
                }
                _ => {
                    drop(pending);
                }
            }
            producer.join().unwrap();
        }
    }
}
