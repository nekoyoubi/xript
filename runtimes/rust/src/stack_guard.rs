//! The engine's stack budget, measured from the thread that enters it.
//!
//! QuickJS stops a script with a catchable `RangeError` once its frames pass a
//! limit counted down from where the host entered the engine. A fixed limit is
//! wrong both ways: too small and ordinary recursion fails on a big thread, too
//! large and a small thread overflows natively and takes the process with it.
//! So at every entry the budget is set from what the calling thread actually
//! has left, less [`MARGIN`] for the frames that run after QuickJS's last check
//! (a host binding called from the deepest script frame, the bridge, the error
//! path), and capped by `max_stack_depth` when the manifest or host sets one.
//!
//! Entries nest: a host binding can call back into script through a callback.
//! Each thread keeps the floor of every live entry, and a nested entry never
//! reaches below the floor of the one it runs inside, so re-entry cannot widen
//! a budget past what the outer entry was given. When the nested entry ends,
//! the outer floor is put back for the rest of the outer call.
//!
//! The current position is the address of a local, and the thread's low bound
//! comes from the platform once per thread: `GetCurrentThreadStackLimits` on
//! Windows, `pthread_getattr_np` on Linux and Android, and
//! `pthread_get_stackaddr_np` less `pthread_get_stacksize_np` on macOS and iOS.
//! Anywhere else (an emscripten build among them) the budget is [`FALLBACK`].
//! The stack is assumed to grow down, as it does on every one of those.

use std::cell::RefCell;

use rquickjs::{qjs, Ctx, JsLifetime};

/// Stack kept back below the engine's limit, in bytes.
pub const MARGIN: usize = 256 * 1024;

/// The budget used where the thread's stack cannot be measured, in bytes.
pub const FALLBACK: usize = 512 * 1024;

/// The smallest budget an entry is given, in bytes, so a thread with almost
/// nothing left still fails a script with a catchable error.
const MINIMUM: usize = 16 * 1024;

thread_local! {
    static FLOORS: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
    static LOW_BOUND: std::cell::Cell<Option<Option<usize>>> = const { std::cell::Cell::new(None) };
}

/// The lowest address of the calling thread's stack, asked of the platform
/// once per thread. `None` where the platform cannot say.
fn low_bound() -> Option<usize> {
    LOW_BOUND.with(|cached| {
        if let Some(bound) = cached.get() {
            return bound;
        }
        let bound = platform::low_bound();
        cached.set(Some(bound));
        bound
    })
}

#[cfg(windows)]
mod platform {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadStackLimits(low_limit: *mut usize, high_limit: *mut usize);
    }

    pub(super) fn low_bound() -> Option<usize> {
        let (mut low, mut high) = (0usize, 0usize);
        // SAFETY: both pointers are to live locals the call writes once.
        unsafe { GetCurrentThreadStackLimits(&mut low, &mut high) };
        (low != 0 && high > low).then_some(low)
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod platform {
    use std::ffi::{c_int, c_void};

    /// Larger than `pthread_attr_t` on every Linux and Android ABI, and
    /// aligned for it, so the platform can fill it in place.
    #[repr(C, align(16))]
    struct Attr([u8; 128]);

    unsafe extern "C" {
        fn pthread_self() -> usize;
        fn pthread_getattr_np(thread: usize, attr: *mut Attr) -> c_int;
        fn pthread_attr_getstack(attr: *const Attr, addr: *mut *mut c_void, size: *mut usize) -> c_int;
        fn pthread_attr_destroy(attr: *mut Attr) -> c_int;
    }

    pub(super) fn low_bound() -> Option<usize> {
        let mut attr = Attr([0; 128]);
        // SAFETY: `attr` is zeroed, big enough and aligned for
        // `pthread_attr_t`; it is destroyed only after a successful init.
        unsafe {
            if pthread_getattr_np(pthread_self(), &mut attr) != 0 {
                return None;
            }
            let mut addr: *mut c_void = std::ptr::null_mut();
            let mut size = 0usize;
            let read = pthread_attr_getstack(&attr, &mut addr, &mut size);
            pthread_attr_destroy(&mut attr);
            (read == 0 && !addr.is_null() && size > 0).then_some(addr as usize)
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use std::ffi::c_void;

    unsafe extern "C" {
        fn pthread_self() -> usize;
        fn pthread_get_stackaddr_np(thread: usize) -> *mut c_void;
        fn pthread_get_stacksize_np(thread: usize) -> usize;
    }

    pub(super) fn low_bound() -> Option<usize> {
        // SAFETY: both calls only read the calling thread's own attributes.
        let (high, size) = unsafe {
            let thread = pthread_self();
            (pthread_get_stackaddr_np(thread) as usize, pthread_get_stacksize_np(thread))
        };
        (high != 0 && size > 0).then(|| high.saturating_sub(size))
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios")))]
mod platform {
    pub(super) fn low_bound() -> Option<usize> {
        None
    }
}

/// A runtime's `max_stack_depth`, in bytes, kept on its context.
#[derive(Clone, Copy)]
pub(crate) struct StackCap(pub Option<usize>);

// SAFETY: `StackCap` holds no JS values.
unsafe impl<'js> JsLifetime<'js> for StackCap {
    type Changed<'to> = StackCap;
}

/// Records the runtime's cap on its context.
pub(crate) fn install(ctx: &Ctx<'_>, cap_bytes: Option<usize>) {
    let _ = ctx.store_userdata(StackCap(cap_bytes));
}

#[inline(never)]
fn stack_position() -> usize {
    let marker = 0u8;
    std::hint::black_box(&marker as *const u8 as usize)
}

fn floor_for(ctx: &Ctx<'_>) -> usize {
    let here = stack_position();
    let cap = ctx.userdata::<StackCap>().and_then(|cap| cap.0);
    let measured = low_bound().map(|low| low.saturating_add(MARGIN));
    let mut floor = measured.unwrap_or_else(|| here.saturating_sub(cap.unwrap_or(FALLBACK)));
    if let Some(cap) = cap {
        floor = floor.max(here.saturating_sub(cap));
    }
    if let Some(outer) = FLOORS.with(|floors| floors.borrow().last().copied()) {
        floor = floor.max(outer);
    }
    floor.min(here.saturating_sub(MINIMUM))
}

fn apply(ctx: &Ctx<'_>, floor: usize) {
    let budget = stack_position().saturating_sub(floor).max(MINIMUM);
    // SAFETY: the context is live and its runtime is locked by the caller,
    // which is inside the engine.
    unsafe {
        let rt = qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
        qjs::JS_UpdateStackTop(rt);
        qjs::JS_SetMaxStackSize(rt, budget as _);
    }
}

/// One live entry into the engine on this thread.
pub(crate) struct Entry<'a, 'js> {
    ctx: &'a Ctx<'js>,
}

impl Drop for Entry<'_, '_> {
    fn drop(&mut self) {
        let outer = FLOORS.with(|floors| {
            let mut floors = floors.borrow_mut();
            floors.pop();
            floors.last().copied()
        });
        if let Some(outer) = outer {
            apply(self.ctx, outer);
        }
    }
}

/// Sets the budget for an entry that starts here and lasts until the returned
/// guard drops. Call it first thing inside every closure that enters the
/// engine synchronously.
pub(crate) fn enter<'a, 'js>(ctx: &'a Ctx<'js>) -> Entry<'a, 'js> {
    let floor = floor_for(ctx);
    apply(ctx, floor);
    FLOORS.with(|floors| floors.borrow_mut().push(floor));
    Entry { ctx }
}

/// Sets the budget for an entry whose body awaits, so it may be resumed on a
/// later poll: the budget is fitted to where the body starts and no guard is
/// held across the await.
pub(crate) fn fit(ctx: &Ctx<'_>) {
    let floor = floor_for(ctx);
    apply(ctx, floor);
}
