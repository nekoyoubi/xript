//! `RuntimeMode::Async`: async host bindings return pending promises, a script
//! awaiting one yields, and other work on the same runtime proceeds.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use xript_runtime::{
    create_async_runtime, create_runtime, CancellationToken, HostBindings, RuntimeMode,
    RuntimeOptions, XriptError, XriptRuntime,
};

/// A timer that needs no executor: a thread sleeps, then wakes whoever polled.
struct Sleep {
    shared: Arc<Mutex<(bool, Option<Waker>)>>,
    duration: Duration,
    started: bool,
}

fn sleep(ms: u64) -> Sleep {
    Sleep {
        shared: Arc::new(Mutex::new((false, None))),
        duration: Duration::from_millis(ms),
        started: false,
    }
}

impl Future for Sleep {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut state = self.shared.lock().unwrap();
        if state.0 {
            return Poll::Ready(());
        }
        state.1 = Some(cx.waker().clone());
        drop(state);
        if !self.started {
            self.started = true;
            let shared = self.shared.clone();
            let duration = self.duration;
            std::thread::spawn(move || {
                std::thread::sleep(duration);
                let mut state = shared.lock().unwrap();
                state.0 = true;
                if let Some(waker) = state.1.take() {
                    waker.wake();
                }
            });
        }
        Poll::Pending
    }
}

/// Polls two futures to completion on the current thread, alternating, and
/// returns both outputs.
fn join<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = Box::pin(a);
    let mut b = Box::pin(b);
    let mut out_a = None;
    let mut out_b = None;
    pollster::block_on(std::future::poll_fn(|cx| {
        if out_a.is_none()
            && let Poll::Ready(v) = a.as_mut().poll(cx)
        {
            out_a = Some(v);
        }
        if out_b.is_none()
            && let Poll::Ready(v) = b.as_mut().poll(cx)
        {
            out_b = Some(v);
        }
        if out_a.is_some() && out_b.is_some() {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }));
    (out_a.unwrap(), out_b.unwrap())
}

const APP: &str = r#"{
    "xript": "0.9",
    "name": "host",
    "limits": { "timeout_ms": 5000 },
    "bindings": {
        "slow": { "description": "resolves after N ms", "params": [{ "name": "ms", "type": "number" }] },
        "failing": { "description": "always rejects" },
        "mark": { "description": "records a label", "params": [{ "name": "label", "type": "string" }] },
        "gated": { "description": "capability-gated async", "capability": "net.fetch" }
    },
    "hooks": { "beforeSave": { "description": "before save" } },
    "events": [ { "id": "tick", "description": "tick" } ],
    "slots": [ { "id": "sidebar.left", "accepts": ["text/html"] } ]
}"#;

type Log = Arc<Mutex<Vec<String>>>;

fn bindings(log: &Log) -> HostBindings {
    let mut bindings = HostBindings::new();
    bindings.add_async_function("slow", |args: &[Value]| {
        let ms = args.first().and_then(|v| v.as_u64()).unwrap_or(0);
        async move {
            sleep(ms).await;
            Ok(json!(format!("slept {ms}")))
        }
    });
    bindings.add_async_function("failing", |_: &[Value]| async {
        sleep(10).await;
        Err("boom".to_string())
    });
    bindings.add_async_function("gated", |_: &[Value]| async { Ok(json!("fetched")) });
    let log = log.clone();
    bindings.add_function("mark", move |args: &[Value]| {
        log.lock()
            .unwrap()
            .push(args.first().and_then(|v| v.as_str()).unwrap_or("").to_string());
        Ok(Value::Null)
    });
    bindings
}

fn options(log: &Log) -> RuntimeOptions {
    RuntimeOptions {
        host_bindings: bindings(log),
        ..RuntimeOptions::default()
    }
}

fn async_runtime() -> (XriptRuntime, Log) {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let rt = create_async_runtime(APP, options(&log)).unwrap();
    (rt, log)
}

const AWAITS_SLOW: &str = "(async () => { mark('A:start'); const v = await slow(300); mark('A:end'); return v; })()";
const QUICK: &str = "mark('B'); 40 + 2";

#[test]
fn reports_its_mode() {
    let (rt, _) = async_runtime();
    assert_eq!(rt.mode(), RuntimeMode::Async);
    let sync = create_runtime(APP, RuntimeOptions::default()).unwrap();
    assert_eq!(sync.mode(), RuntimeMode::Sync);
}

#[test]
fn async_binding_returns_a_pending_promise() {
    let (rt, _) = async_runtime();
    let result = rt
        .execute("(() => { const p = slow(50); globalThis.__p = p; let settled = false; p.then(() => { settled = true; }); return settled; })()")
        .unwrap();
    assert_eq!(result.value, json!(false));
}

#[test]
fn awaiting_a_slow_binding_yields_to_a_second_script() {
    let (rt, log) = async_runtime();
    let started = Instant::now();
    let finished_b = Arc::new(Mutex::new(None));
    let stamp = finished_b.clone();
    let (a, b) = join(rt.execute_async(AWAITS_SLOW), async {
        let result = rt.execute_async(QUICK).await;
        *stamp.lock().unwrap() = Some(started.elapsed());
        result
    });
    let elapsed = started.elapsed();

    assert_eq!(a.unwrap().value, json!("slept 300"));
    assert_eq!(b.unwrap().value, json!(42));
    assert_eq!(*log.lock().unwrap(), vec!["A:start", "B", "A:end"]);
    let b_done = finished_b.lock().unwrap().unwrap();
    assert!(b_done < Duration::from_millis(250), "B waited on A's binding: {b_done:?}");
    assert!(elapsed >= Duration::from_millis(300));
}

#[test]
fn a_second_call_completes_first_when_the_first_is_slower() {
    let (rt, _) = async_runtime();
    let order: Log = Arc::new(Mutex::new(Vec::new()));
    let (o1, o2) = (order.clone(), order.clone());
    let (a, b) = join(
        async {
            let r = rt.execute_async("slow(300)").await;
            o1.lock().unwrap().push("first".into());
            r
        },
        async {
            let r = rt.execute_async("slow(20)").await;
            o2.lock().unwrap().push("second".into());
            r
        },
    );
    assert_eq!(a.unwrap().value, json!("slept 300"));
    assert_eq!(b.unwrap().value, json!("slept 20"));
    assert_eq!(*order.lock().unwrap(), vec!["second", "first"]);
}

#[test]
fn sync_mode_still_blocks_on_the_same_scripts() {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let rt = create_runtime(APP, options(&log)).unwrap();
    let (a, b) = join(rt.execute_async(AWAITS_SLOW), rt.execute_async(QUICK));
    assert_eq!(a.unwrap().value, json!("slept 300"));
    assert_eq!(b.unwrap().value, json!(42));
    assert_eq!(*log.lock().unwrap(), vec!["A:start", "A:end", "B"]);
}

#[test]
fn the_blocking_methods_drive_a_yielding_call_to_completion() {
    let (rt, _) = async_runtime();
    let result = rt.execute("(async () => (await slow(30)) + '!')()").unwrap();
    assert_eq!(result.value, json!("slept 30!"));
}

#[test]
fn rejection_propagates_to_script_and_to_the_host() {
    let (rt, _) = async_runtime();
    let caught = pollster::block_on(
        rt.execute_async("(async () => { try { await failing(); return 'no'; } catch (e) { return e.message; } })()"),
    )
    .unwrap();
    assert_eq!(caught.value, json!("boom"));

    let uncaught = pollster::block_on(rt.execute_async("(async () => { await failing(); })()"));
    match uncaught {
        Err(XriptError::Script(message)) => assert!(message.contains("boom"), "{message}"),
        other => panic!("expected a script error, got {other:?}"),
    }
}

#[test]
fn the_budget_covers_time_spent_awaiting() {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let manifest = APP.replace("\"timeout_ms\": 5000", "\"timeout_ms\": 100");
    let rt = create_async_runtime(&manifest, options(&log)).unwrap();
    let started = Instant::now();
    let result = pollster::block_on(rt.execute_async("slow(5000)"));
    assert!(
        matches!(result, Err(XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
        "{result:?}"
    );
    assert!(started.elapsed() < Duration::from_millis(2000));

    assert_eq!(rt.execute("1 + 1").unwrap().value, json!(2));
}

#[test]
fn the_interrupt_still_cuts_a_runaway_loop_before_and_after_an_await() {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let manifest = APP.replace("\"timeout_ms\": 5000", "\"timeout_ms\": 150");
    let rt = create_async_runtime(&manifest, options(&log)).unwrap();

    let spin = pollster::block_on(rt.execute_async("while (true) {}"));
    assert!(matches!(spin, Err(XriptError::ExecutionLimit { .. })), "{spin:?}");

    let after_await = pollster::block_on(rt.execute_async("(async () => { await slow(10); while (true) {} })()"));
    assert!(matches!(after_await, Err(XriptError::ExecutionLimit { .. })), "{after_await:?}");

    assert_eq!(rt.execute("2 + 2").unwrap().value, json!(4));
}

#[test]
fn one_call_timing_out_does_not_take_its_neighbour_down() {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let manifest = APP.replace("\"timeout_ms\": 5000", "\"timeout_ms\": 400");
    let rt = create_async_runtime(&manifest, options(&log)).unwrap();
    let (a, b) = join(rt.execute_async("slow(5000)"), rt.execute_async("slow(50)"));
    assert!(matches!(a, Err(XriptError::ExecutionLimit { .. })), "{a:?}");
    assert_eq!(b.unwrap().value, json!("slept 50"));
}

#[test]
fn cancellation_reaches_a_call_parked_on_a_binding() {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let token = CancellationToken::new();
    let rt = create_async_runtime(
        APP,
        RuntimeOptions {
            cancellation: Some(token.clone()),
            ..options(&log)
        },
    )
    .unwrap();
    let canceller = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        canceller.cancel();
    });
    let started = Instant::now();
    let result = pollster::block_on(rt.execute_async("slow(5000)"));
    assert!(matches!(result, Err(XriptError::Cancelled)), "{result:?}");
    assert!(started.elapsed() < Duration::from_millis(2000));
}

#[test]
fn dropping_an_in_flight_call_cancels_it_and_leaves_the_runtime_usable() {
    let (rt, _) = async_runtime();
    {
        let mut call = Box::pin(rt.execute_async("(async () => { await slow(5000); return 'late'; })()"));
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        assert!(call.as_mut().poll(&mut cx).is_pending());
    }
    assert_eq!(rt.execute("'still here'").unwrap().value, json!("still here"));
}

#[test]
fn capability_gates_apply_to_async_bindings() {
    let (rt, _) = async_runtime();
    let denied = rt
        .execute("(async () => { try { await gated(); return 'no'; } catch (e) { return e.message; } })()")
        .unwrap();
    assert!(denied.value.as_str().unwrap().contains("net.fetch"));

    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let granted = create_async_runtime(
        APP,
        RuntimeOptions {
            capabilities: vec!["net.fetch".into()],
            ..options(&log)
        },
    )
    .unwrap();
    assert_eq!(granted.execute("gated()").unwrap().value, json!("fetched"));
}

#[test]
fn hooks_and_events_dispatch_in_async_mode() {
    let (rt, _) = async_runtime();
    rt.execute("hooks.beforeSave(function(doc) { return doc + '!'; }); events.on('tick', function(n) { return n + 1; });")
        .unwrap();
    let hooked = pollster::block_on(rt.fire_hook_async("beforeSave", &[json!("draft")])).unwrap();
    assert_eq!(hooked, vec![json!("draft!")]);
    let ticked = pollster::block_on(rt.emit_async("tick", &[json!(1)])).unwrap();
    assert_eq!(ticked, vec![json!(2)]);
    assert_eq!(rt.fire_hook("beforeSave", &[json!("x")]).unwrap(), vec![json!("x!")]);
}

const MOD: &str = r#"{
    "xript": "0.3",
    "name": "mod-a",
    "version": "1.0.0",
    "entry": { "script": "src/mod.js", "format": "module", "exports": { "fetchTwice": { "description": "awaits twice" } } },
    "fragments": [
        { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
    ]
}"#;

const MOD_SOURCE: &str = r#"
const warm = await slow(20);
export async function fetchTwice(ms) {
    const a = await slow(ms);
    const b = await slow(ms);
    return [warm, a, b];
}
hooks.fragment.mount('panel', function(bindings, fragment) { fragment.setText('p', 'mounted'); });
"#;

#[test]
fn mods_load_with_top_level_await_and_async_exports_settle() {
    let (rt, _) = async_runtime();
    pollster::block_on(rt.load_mod_async(MOD, HashMap::new(), &HashSet::new(), Some(MOD_SOURCE))).unwrap();

    let value = pollster::block_on(rt.invoke_export_async("fetchTwice", &[json!(10)])).unwrap();
    assert_eq!(value, json!(["slept 20", "slept 10", "slept 10"]));
    assert_eq!(
        rt.invoke_mod_export("mod-a", "fetchTwice", &[json!(5)]).unwrap(),
        json!(["slept 20", "slept 5", "slept 5"])
    );

    let ops = pollster::block_on(rt.fire_fragment_hook_async("panel", "mount", None)).unwrap();
    assert_eq!(ops.len(), 1);
}

#[test]
fn concurrent_exports_interleave() {
    let (rt, _) = async_runtime();
    rt.load_mod(MOD, HashMap::new(), &HashSet::new(), Some(MOD_SOURCE)).unwrap();
    let started = Instant::now();
    let (a, b) = join(
        rt.invoke_export_async("fetchTwice", &[json!(150)]),
        rt.invoke_export_async("fetchTwice", &[json!(150)]),
    );
    assert_eq!(a.unwrap(), json!(["slept 20", "slept 150", "slept 150"]));
    assert_eq!(b.unwrap(), json!(["slept 20", "slept 150", "slept 150"]));
    assert!(started.elapsed() < Duration::from_millis(550), "{:?}", started.elapsed());
}

#[test]
fn fire_and_forget_work_settles_on_idle() {
    let (rt, log) = async_runtime();
    rt.execute("void slow(30).then(() => mark('later'))").unwrap();
    assert!(log.lock().unwrap().is_empty());
    pollster::block_on(rt.idle());
    assert_eq!(*log.lock().unwrap(), vec!["later"]);
}

#[test]
fn the_runtime_and_its_futures_are_send() {
    fn assert_send<T: Send>(_: &T) {}
    let (rt, _) = async_runtime();
    assert_send(&rt);
    let call = rt.execute_async("1");
    assert_send(&call);
    drop(call);
    let moved = std::thread::spawn(move || rt.execute("3 * 3").unwrap().value)
        .join()
        .unwrap();
    assert_eq!(moved, json!(9));
}

#[test]
fn a_debug_breakpoint_pauses_and_resumes_in_async_mode() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use xript_runtime::{instrument_source, DebugOptions, SourceBreakpoint};

    let stops = Arc::new(AtomicUsize::new(0));
    let counted = stops.clone();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let rt = Arc::new(
        create_async_runtime(
            APP,
            RuntimeOptions {
                debug: Some(DebugOptions {
                    on_stopped: Some(Arc::new(move |_event| {
                        counted.fetch_add(1, Ordering::SeqCst);
                    })),
                    ..Default::default()
                }),
                ..options(&log)
            },
        )
        .unwrap(),
    );
    let session = rt.debug_session().unwrap().clone();
    session.set_breakpoints(
        "inline",
        &[SourceBreakpoint {
            line: 2,
            column: None,
            condition: None,
        }],
    );
    let runner = rt.clone();
    let exec = std::thread::spawn(move || {
        let code = instrument_source("var x = 1;\nvar y = x + 1;\ny;");
        pollster::block_on(runner.execute_async(&code))
    });
    while !exec.is_finished() {
        std::thread::sleep(Duration::from_millis(5));
        if !session.stack_trace().is_empty() {
            session.resume();
            break;
        }
    }
    let result = exec.join().unwrap().unwrap();
    assert_eq!(result.value, json!(2));
    assert!(stops.load(Ordering::SeqCst) >= 1);
}

#[test]
fn a_callback_survives_a_real_yield_and_expires_when_the_binding_settles() {
    use xript_runtime::Callback;

    let kept: Arc<Mutex<Option<Callback>>> = Arc::new(Mutex::new(None));
    let kept_in = kept.clone();
    let mut bindings = HostBindings::new();
    bindings.add_async_function("later", move |args: &[Value]| {
        let callback = args.first().and_then(Callback::from_value);
        *kept_in.lock().unwrap() = callback.clone();
        async move {
            let callback = callback.ok_or("no callback")?;
            sleep(40).await;
            let first = callback.call(&[json!(1)])?;
            sleep(40).await;
            let second = callback.call(&[json!(2)])?;
            Ok(json!([first, second]))
        }
    });
    let manifest = r#"{
        "xript": "0.9",
        "name": "host",
        "bindings": { "later": { "description": "calls back after a delay", "async": true } }
    }"#;
    let rt = create_async_runtime(
        manifest,
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        },
    )
    .unwrap();
    let (a, b) = join(
        rt.execute_async("(async () => await later((n) => n * 10))()"),
        rt.execute_async("'meanwhile'"),
    );
    assert_eq!(a.unwrap().value, json!([10, 20]));
    assert_eq!(b.unwrap().value, json!("meanwhile"));
    let kept = kept.lock().unwrap().clone().unwrap();
    assert_eq!(kept.call(&[]).unwrap_err().reason(), "expired");
}
