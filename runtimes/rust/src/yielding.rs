//! Machinery behind [`RuntimeMode::Async`](crate::sandbox::RuntimeMode::Async):
//! host futures surfaced to script as genuinely pending promises, and the
//! execution budget enforced across the awaits a yielding call makes.
//!
//! The sync runtime's interrupt frames are pushed for the length of a call on
//! the thread running it. A yielding call is not contiguous: between polls it
//! holds neither the runtime lock nor the thread, and other calls on the same
//! runtime interleave with it. So here a frame is pushed for the length of one
//! poll, and a [`Watch`] carries the deadline and the cancellation tokens
//! across the gaps, where no bytecode runs and the interrupt handler cannot see
//! them.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll, Waker};
use std::time::{Duration, Instant};

use crate::error::XriptError;
use crate::pending::CallToken;
use crate::sandbox::{CancellationToken, InterruptFrame, XriptRuntime};

/// How often a watcher thread re-checks a parked call's deadline and tokens.
/// Cancellation of a call that is awaiting a host future is observed within
/// this interval.
const WATCH_TICK: Duration = Duration::from_millis(5);

/// Marks a value `Send` that never actually leaves the thread it was created
/// on. Used only where a closure or result is handed to an rquickjs entry point
/// that demands `Send` for the parallel feature while the work is driven to
/// completion on the calling thread.
pub(crate) struct AssertSend<T>(pub(crate) T);

// SAFETY: every use site drives the wrapped value to completion with
// `pollster::block_on` on the thread that created it, so it is never touched
// from another thread.
unsafe impl<T> Send for AssertSend<T> {}

impl<T> AssertSend<T> {
    pub(crate) fn into_inner(self) -> T {
        self.0
    }
}

/// The budget of one yielding call, shared between the poll wrapper, the
/// in-context abort check, and the watcher thread.
pub(crate) struct Watch {
    deadline: Instant,
    debug_clock: Option<Arc<AtomicU64>>,
    token: Option<CancellationToken>,
    call_token: Mutex<Option<CallToken>>,
    interrupted: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    waker: Mutex<Option<Waker>>,
    done: AtomicBool,
    watching: AtomicBool,
}

impl Watch {
    pub(crate) fn new(frame: &InterruptFrame) -> Arc<Self> {
        Arc::new(Self {
            deadline: frame.deadline,
            debug_clock: frame.debug_clock.clone(),
            token: frame.token.clone(),
            call_token: Mutex::new(frame.call_token.clone()),
            interrupted: frame.interrupted.clone(),
            cancelled: frame.cancelled.clone(),
            waker: Mutex::new(None),
            done: AtomicBool::new(false),
            watching: AtomicBool::new(false),
        })
    }

    fn call_token(&self) -> Option<CallToken> {
        self.call_token
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn adopt_call_token(&self, token: Option<CallToken>) {
        let mut slot = self.call_token.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            *slot = token;
        }
    }

    /// The error a parked call should settle with now, if its budget is spent
    /// or it was cancelled. Also latches the matching flag, so a classifier
    /// reading the flags afterwards agrees.
    pub(crate) fn tripped(&self) -> Option<XriptError> {
        let cancelled = self.cancelled.load(Ordering::Relaxed)
            || self.token.as_ref().map(|t| t.is_cancelled()).unwrap_or(false)
            || self.call_token().map(|t| t.is_cancelled()).unwrap_or(false);
        if cancelled {
            self.cancelled.store(true, Ordering::Relaxed);
            return Some(XriptError::Cancelled);
        }
        let paused = self
            .debug_clock
            .as_ref()
            .map(|c| Duration::from_millis(c.load(Ordering::Relaxed)))
            .unwrap_or_default();
        if self.interrupted.load(Ordering::Relaxed) || Instant::now() >= self.deadline + paused {
            self.interrupted.store(true, Ordering::Relaxed);
            return Some(XriptError::ExecutionLimit {
                limit: "timeout_ms".into(),
            });
        }
        None
    }

    /// Remembers who to wake and makes sure a watcher is running, so a call
    /// parked on a host future that never settles still times out or observes
    /// cancellation.
    fn arm(self: &Arc<Self>, waker: &Waker) {
        *self.waker.lock().unwrap_or_else(|p| p.into_inner()) = Some(waker.clone());
        if self.watching.swap(true, Ordering::SeqCst) {
            return;
        }
        let watch = self.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(WATCH_TICK);
                if watch.done.load(Ordering::SeqCst) {
                    return;
                }
                if watch.tripped().is_some() {
                    if let Some(waker) = watch.waker.lock().unwrap_or_else(|p| p.into_inner()).take() {
                        waker.wake();
                    }
                    return;
                }
            }
        });
    }

    fn finish(&self) {
        self.done.store(true, Ordering::SeqCst);
    }
}

/// Awaits `inner` inside the context unless the call's budget runs out or it
/// is cancelled first. Lives inside the `async_with!` body on purpose: giving
/// up there lets the body return normally while the runtime lock is held, so
/// every JS value it owns is released under the lock rather than dropped from
/// outside it.
pub(crate) struct Abortable<F> {
    inner: F,
    watch: Arc<Watch>,
}

impl<F> Abortable<F> {
    pub(crate) fn new(inner: F, watch: Arc<Watch>) -> Self {
        Self { inner, watch }
    }
}

impl<F: Future + Unpin> Future for Abortable<F> {
    type Output = std::result::Result<F::Output, XriptError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        if let Some(error) = self.watch.tripped() {
            return Poll::Ready(Err(error));
        }
        match Pin::new(&mut self.inner).poll(cx) {
            Poll::Ready(value) => Poll::Ready(Ok(value)),
            Poll::Pending => {
                self.watch.arm(cx.waker());
                Poll::Pending
            }
        }
    }
}

/// Wraps one yielding call so every poll runs inside an interrupt frame on the
/// polling thread, carrying that call's deadline and tokens and nobody else's.
///
/// Dropping it before it completes cancels the call: the call is driven to
/// its cancellation point on the dropping thread instead of being torn down
/// mid-flight, because the suspended body owns JS values that may only be
/// released while the runtime lock is held.
pub(crate) struct Governed<'a, F: Future> {
    runtime: &'a XriptRuntime,
    frame: InterruptFrame,
    watch: Arc<Watch>,
    inner: Option<Pin<Box<F>>>,
    started: bool,
}

impl<'a, F: Future> Governed<'a, F> {
    pub(crate) fn new(runtime: &'a XriptRuntime, frame: InterruptFrame, watch: Arc<Watch>, inner: F) -> Self {
        Self {
            runtime,
            frame,
            watch,
            inner: Some(Box::pin(inner)),
            started: false,
        }
    }

    fn poll_governed(&mut self, cx: &mut TaskContext<'_>) -> Poll<F::Output> {
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Pending;
        };
        self.started = true;
        self.watch.adopt_call_token(crate::sandbox::current_call_token());
        let mut frame = self.frame.clone();
        frame.call_token = self.watch.call_token();
        let _frame = self.runtime.push_interrupt_frame(frame);
        let polled = inner.as_mut().poll(cx);
        if polled.is_ready() {
            self.watch.finish();
            self.inner = None;
        }
        polled
    }
}

impl<F: Future> Future for Governed<'_, F> {
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        self.poll_governed(cx)
    }
}

impl<F: Future> Drop for Governed<'_, F> {
    fn drop(&mut self) {
        if self.inner.is_some() && self.started {
            self.watch.cancelled.store(true, Ordering::Relaxed);
            pollster::block_on(std::future::poll_fn(|cx| self.poll_governed(cx)));
        }
        self.watch.finish();
    }
}
