//! Which contexts the calling thread is running right now.
//!
//! A host entry point (`execute`, `invoke_export`, `fire_hook`, `emit`, ...)
//! normally takes the runtime lock. Called from host code that the runtime is
//! itself running (a binding the script called, a console handler, a host
//! future an async binding started), that lock is already held further up the
//! same thread's stack, and taking it again would wait on itself forever:
//! rquickjs's sync lock is not reentrant, and its async lock is never released
//! while the outer call sits suspended in host code.
//!
//! So every stretch in which the runtime holds its lock on this thread records
//! the context here, and an entry point that finds its own context recorded
//! runs on that context in place instead of locking. A suspended async call
//! records its context only for the duration of each poll, so a lock released
//! between polls is never mistaken for a held one. A poll that is still waiting
//! for the lock runs no host code, so the record cannot be read while the lock
//! is not yet held.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::ptr::NonNull;
use std::task::{Context as TaskContext, Poll};

use rquickjs::{qjs, Ctx};

thread_local! {
    static HELD: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
    static REENTERED: Cell<usize> = const { Cell::new(0) };
}

/// The identity of a context: its address, stable for the context's life.
pub(crate) fn key_of(ctx: &Ctx<'_>) -> usize {
    ctx.as_raw().as_ptr() as usize
}

/// Records that the calling thread holds the lock of the context identified
/// by its key until dropped.
pub(crate) struct Holding(usize);

impl Holding {
    pub(crate) fn new(ctx: &Ctx<'_>) -> Self {
        Self::of(key_of(ctx))
    }

    pub(crate) fn of(key: usize) -> Self {
        HELD.with(|held| held.borrow_mut().push(key));
        Holding(key)
    }
}

impl Drop for Holding {
    fn drop(&mut self) {
        HELD.with(|held| {
            let mut held = held.borrow_mut();
            if let Some(position) = held.iter().rposition(|key| *key == self.0) {
                held.remove(position);
            }
        });
    }
}

/// The context identified by `key`, when the calling thread holds its lock.
pub(crate) fn held(key: usize) -> Option<NonNull<qjs::JSContext>> {
    let recorded = HELD.with(|held| held.borrow().contains(&key));
    if recorded { NonNull::new(key as *mut qjs::JSContext) } else { None }
}

/// True while a re-entered call runs on this thread. It runs to completion
/// before the host code that made it returns, so an async binding it reaches
/// is settled in place, as on a sync runtime, rather than left for an executor
/// that cannot run until the outer call resumes.
pub(crate) fn inside() -> bool {
    REENTERED.with(|depth| depth.get() > 0)
}

struct Reentered;

impl Reentered {
    fn enter() -> Self {
        REENTERED.with(|depth| depth.set(depth.get() + 1));
        Reentered
    }
}

impl Drop for Reentered {
    fn drop(&mut self) {
        REENTERED.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// Runs `body` on the held context `raw`.
///
/// # Safety
///
/// `raw` must come from [`held`] on the calling thread, so its runtime lock is
/// held further up this thread's stack for as long as `body` runs.
pub(crate) unsafe fn with_held<R>(raw: NonNull<qjs::JSContext>, body: impl for<'js> FnOnce(Ctx<'js>) -> R) -> R {
    // SAFETY: the caller guarantees the lock is held for the whole call, and
    // the `Ctx` cannot outlive `body`.
    let ctx = unsafe { Ctx::from_raw(raw) };
    let _reentered = Reentered::enter();
    let _entry = crate::stack_guard::enter(&ctx);
    body(ctx.clone())
}

/// Polls `inner` with the context identified by `key` recorded as held for
/// each poll alone: `inner` takes the runtime lock when polled and releases it
/// before returning, so the record must not outlive a poll.
pub(crate) struct HeldWhilePolled<F> {
    key: usize,
    inner: Pin<Box<F>>,
}

impl<F: Future> HeldWhilePolled<F> {
    pub(crate) fn new(key: usize, inner: F) -> Self {
        Self {
            key,
            inner: Box::pin(inner),
        }
    }
}

impl<F: Future> Future for HeldWhilePolled<F> {
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<F::Output> {
        let _held = Holding::of(self.key);
        self.inner.as_mut().poll(cx)
    }
}
