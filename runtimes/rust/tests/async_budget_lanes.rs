//! On a yielding runtime one call's continuation can run inside another
//! call's poll. Its bytecode is charged to its own budget, not to the call
//! whose poll it happens to run in: a slow call keeps running under its own
//! deadline, and another call's tighter deadline does not stop it.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use std::time::Duration;

use serde_json::{json, Value};
use xript_runtime::{create_runtime, HostBindings, RuntimeMode, RuntimeOptions, XriptError};

fn after(ms: u64) -> impl Future<Output = ()> {
    let state: Arc<Mutex<(bool, Option<Waker>)>> = Arc::new(Mutex::new((false, None)));
    let timer = state.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        let mut guard = timer.lock().unwrap();
        guard.0 = true;
        if let Some(waker) = guard.1.take() {
            waker.wake();
        }
    });
    std::future::poll_fn(move |cx| {
        let mut guard = state.lock().unwrap();
        if guard.0 {
            Poll::Ready(())
        } else {
            guard.1 = Some(cx.waker().clone());
            Poll::Pending
        }
    })
}

/// Polls `first` before `second` every time, so a continuation `second`
/// queued is driven inside `first`'s poll.
fn join<A: Future, B: Future>(first: A, second: B) -> (A::Output, B::Output) {
    let mut first = Box::pin(first);
    let mut second = Box::pin(second);
    let (mut out_first, mut out_second) = (None, None);
    pollster::block_on(std::future::poll_fn(|cx| {
        if out_first.is_none()
            && let Poll::Ready(value) = first.as_mut().poll(cx)
        {
            out_first = Some(value);
        }
        if out_second.is_none()
            && let Poll::Ready(value) = second.as_mut().poll(cx)
        {
            out_second = Some(value);
        }
        if out_first.is_some() && out_second.is_some() { Poll::Ready(()) } else { Poll::Pending }
    }));
    (out_first.unwrap(), out_second.unwrap())
}

#[test]
fn a_slow_continuation_is_charged_to_its_own_call() {
    let mut bindings = HostBindings::new();
    bindings.add_async_function("wait", |args: &[Value]| {
        let ms = args.first().and_then(Value::as_u64).unwrap_or(0);
        async move {
            after(ms).await;
            Ok(json!(ms))
        }
    });
    let rt = create_runtime(
        r#"{ "xript": "0.10", "name": "budget-lanes",
             "bindings": { "wait": { "description": "Settles after a delay.", "async": true, "params": [{ "name": "ms", "type": "number" }] } } }"#,
        RuntimeOptions { host_bindings: bindings, mode: RuntimeMode::Async, ..Default::default() },
    )
    .unwrap();

    let tight = rt.execute_within_async("await wait(60); return 'tight';", Some(150));
    let slow = rt.execute_within_async(
        "await wait(10); var end = Date.now() + 300; while (Date.now() < end) {} return 'slow';",
        Some(5_000),
    );
    let (tight, slow) = join(tight, slow);

    assert_eq!(slow.expect("the slow call runs under its own 5s budget").value, json!("slow"));
    assert!(
        matches!(tight, Err(XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
        "the tight call still times out on its own clock; got {tight:?}"
    );
}
