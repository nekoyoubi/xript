//! The non-blocking handle: nothing blocks the caller unless the caller asks.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use xript_runtime::{
    HostBindings, RuntimeOptions, ShutdownReport, XriptError, XriptHandle,
};

const APP: &str = r#"{
    "xript": "0.7",
    "name": "test-app",
    "limits": { "timeout_ms": 30000 },
    "slots": [ { "id": "sidebar.left", "accepts": ["text/html"] } ],
    "events": [ { "id": "ready", "description": "ready" } ]
}"#;

const MOD: &str = r#"{
    "xript": "0.3",
    "name": "test-mod",
    "version": "1.0.0",
    "fragments": [
        { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
    ]
}"#;

fn handle() -> XriptHandle {
    XriptHandle::new(APP.to_string(), RuntimeOptions::default()).unwrap()
}

/// A handle whose `hold()` binding blocks the runtime thread until the returned
/// sender is used. This is the shape the pillar exists for: a host binding the
/// interpreter cannot be interrupted out of.
fn blocking_handle() -> (XriptHandle, mpsc::Sender<()>, Arc<AtomicBool>) {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = std::sync::Mutex::new(release_rx);
    let entered = Arc::new(AtomicBool::new(false));
    let flag = entered.clone();

    let mut bindings = HostBindings::new();
    bindings.add_function("hold", move |_args: &[serde_json::Value]| {
        flag.store(true, Ordering::SeqCst);
        let _unused = release_rx.lock().unwrap().recv();
        Ok(serde_json::json!("released"))
    });

    let manifest = r#"{
        "xript": "0.7",
        "name": "test-app",
        "limits": { "timeout_ms": 200 },
        "bindings": { "hold": { "description": "blocks the runtime thread" } }
    }"#;

    let handle = XriptHandle::new(
        manifest.to_string(),
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        },
    )
    .unwrap();
    (handle, release_tx, entered)
}

#[test]
fn execute_returns_before_the_call_finishes() {
    let (handle, release, entered) = blocking_handle();
    let started = Instant::now();
    let pending = handle.execute("hold()");
    let returned_in = started.elapsed();

    assert!(
        returned_in < Duration::from_millis(200),
        "execute() blocked the caller for {returned_in:?}"
    );
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }
    assert!(!pending.is_ready());

    release.send(()).unwrap();
    assert_eq!(pending.wait().unwrap().value, serde_json::json!("released"));
}

/// A `Pending` is held across an `.await` in an async Tauri command, so it has
/// to be `Send`.
#[test]
fn a_pending_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<xript_runtime::Pending<xript_runtime::ExecutionResult>>();
    assert_send::<xript_runtime::CallToken>();
}

#[test]
fn a_pending_awaits_as_a_future() {
    let handle = handle();
    let value = pollster::block_on(handle.execute("2 + 2")).unwrap().value;
    assert_eq!(value, serde_json::json!(4));
}

#[test]
fn try_take_drives_an_immediate_mode_loop() {
    let (handle, release, entered) = blocking_handle();
    let mut pending = handle.execute("hold()");
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }

    let mut frames = 0u32;
    assert!(pending.try_take().is_none());
    release.send(()).unwrap();
    loop {
        if let Some(result) = pending.try_take() {
            assert_eq!(result.unwrap().value, serde_json::json!("released"));
            break;
        }
        frames += 1;
        assert!(frames < 100_000, "try_take never produced a result");
        std::thread::yield_now();
    }
}

#[test]
fn on_complete_hands_the_result_to_a_callback() {
    let handle = handle();
    let (tx, rx) = mpsc::channel();
    handle.execute("6 * 7").on_complete(move |result| {
        let _unused = tx.send(result.unwrap().value);
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        serde_json::json!(42)
    );
}

#[test]
fn blocking_mirrors_every_verb() {
    let handle = handle();
    assert_eq!(
        handle.blocking().execute("1 + 1").unwrap().value,
        serde_json::json!(2)
    );
    assert_eq!(handle.blocking().manifest_name(), "test-app");
}

#[test]
fn dropping_a_pending_cancels_its_queued_call() {
    let (handle, release, entered) = blocking_handle();
    let held = handle.execute("hold()");
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }

    // Queued behind the blocked call, then abandoned.
    let abandoned = handle.execute("1 + 1");
    let token = abandoned.token();
    drop(abandoned);
    assert!(token.is_cancelled());

    let survivor = handle.execute("3 + 4");
    release.send(()).unwrap();
    held.wait().unwrap();

    // A per-call cancellation is not sticky: the next call is unaffected.
    assert_eq!(survivor.wait().unwrap().value, serde_json::json!(7));
}

#[test]
fn cancelling_a_queued_call_skips_it_with_no_interrupt() {
    let (handle, release, entered) = blocking_handle();
    let held = handle.execute("hold()");
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }

    let queued = handle.execute("1 + 1");
    queued.cancel();

    release.send(()).unwrap();
    held.wait().unwrap();
    assert!(matches!(queued.wait(), Err(XriptError::Cancelled)));

    // and the runtime is still usable
    assert_eq!(
        handle.execute("5 + 5").wait().unwrap().value,
        serde_json::json!(10)
    );
}

#[test]
fn cancelling_a_running_script_interrupts_it_without_poisoning_the_runtime() {
    let manifest = r#"{ "xript": "0.7", "name": "test-app", "limits": { "timeout_ms": 60000 } }"#;
    let handle = XriptHandle::new(manifest.to_string(), RuntimeOptions::default()).unwrap();

    let spinning = handle.execute("while (true) {}");
    let token = spinning.token();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        token.cancel();
    });
    assert!(matches!(spinning.wait(), Err(XriptError::Cancelled)));

    assert_eq!(
        handle.execute("8 + 8").wait().unwrap().value,
        serde_json::json!(16)
    );
}

#[test]
fn wait_timeout_bounds_the_caller_and_leaves_the_call_running() {
    let (handle, release, entered) = blocking_handle();
    let held = handle.execute("hold()");
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }
    let err = held.wait_timeout(Duration::from_millis(30)).unwrap_err();
    assert!(matches!(
        err,
        XriptError::Timeout {
            still_running: true
        }
    ));

    // The call was never interrupted; the binding still holds the thread.
    release.send(()).unwrap();
    assert_eq!(
        handle.execute("2 + 2").wait().unwrap().value,
        serde_json::json!(4)
    );
}

#[test]
fn slot_and_role_reads_do_not_queue_behind_execution() {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = std::sync::Mutex::new(release_rx);
    let entered = Arc::new(AtomicBool::new(false));
    let flag = entered.clone();
    let mut bindings = HostBindings::new();
    bindings.add_function("hold", move |_args: &[serde_json::Value]| {
        flag.store(true, Ordering::SeqCst);
        let _unused = release_rx.lock().unwrap().recv();
        Ok(serde_json::Value::Null)
    });

    let manifest = r#"{
        "xript": "0.7",
        "name": "test-app",
        "limits": { "timeout_ms": 30000 },
        "slots": [ { "id": "sidebar.left", "accepts": ["text/html"] } ],
        "bindings": { "hold": { "description": "blocks" } }
    }"#;
    let handle = XriptHandle::new(
        manifest.to_string(),
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        },
    )
    .unwrap();

    handle
        .load_mod(MOD, HashMap::new(), &HashSet::new(), None)
        .wait()
        .unwrap();

    let held = handle.execute("hold()");
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }

    let started = Instant::now();
    let contributions = handle.resolve_slot("sidebar.left").wait().unwrap();
    let single = handle.resolve_slot_single("sidebar.left").wait().unwrap();
    let roles = handle.resolve_role_all("anything").wait().unwrap();
    let name = handle.manifest_name().to_string();
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_millis(200),
        "fast-lane reads queued behind execution ({elapsed:?})"
    );
    assert_eq!(contributions.len(), 1);
    assert_eq!(single.unwrap().fragment_id, "panel");
    assert!(roles.is_empty());
    assert_eq!(name, "test-app");

    release_tx.send(()).unwrap();
    held.wait().unwrap();
}

#[test]
fn the_manifest_is_readable_without_the_runtime_thread() {
    let handle = handle();
    assert_eq!(handle.manifest().name, "test-app");
    assert_eq!(handle.manifest_name(), "test-app");
}

#[test]
fn spawn_queues_commands_sent_before_init_finishes() {
    let (handle, ready) = XriptHandle::spawn(APP.to_string(), RuntimeOptions::default());
    let queued = handle.execute("21 * 2");
    ready.wait().unwrap();
    assert_eq!(queued.wait().unwrap().value, serde_json::json!(42));
}

#[test]
fn a_failed_init_fails_every_command_instead_of_hanging() {
    let broken = r#"{ "xript": "0.7", "name": "test-app", "bindings": { "oops": 42 } }"#;
    let (handle, ready) = XriptHandle::spawn(broken.to_string(), RuntimeOptions::default());
    let queued = handle.execute("1 + 1");

    assert!(ready.wait().is_err());
    assert!(matches!(
        queued.wait(),
        Err(XriptError::InitFailed { .. }) | Err(XriptError::Engine(_))
    ));
    assert!(matches!(
        handle.execute("1 + 1").wait(),
        Err(XriptError::InitFailed { .. })
    ));
}

#[test]
fn fire_fragment_hook_is_reachable_through_the_handle() {
    let manifest = r#"{
        "xript": "0.7",
        "name": "test-app",
        "slots": [ { "id": "sidebar.left", "accepts": ["text/html"] } ]
    }"#;
    let handle = XriptHandle::new(manifest.to_string(), RuntimeOptions::default()).unwrap();
    handle
        .load_mod(MOD, HashMap::new(), &HashSet::new(), None)
        .wait()
        .unwrap();
    // No handler is registered, so the op list is empty -- the point is that the
    // verb exists on the handle at all.
    let ops = handle
        .fire_fragment_hook("panel", "mount", None)
        .wait()
        .unwrap();
    assert!(ops.is_empty());
}

#[test]
fn shutdown_drains_the_queue_and_reports() {
    let handle = handle();
    let counted = Arc::new(AtomicU32::new(0));
    for _unused in 0..8 {
        let sink = counted.clone();
        handle.execute("1 + 1").on_complete(move |result| {
            if result.is_ok() {
                sink.fetch_add(1, Ordering::SeqCst);
            }
        });
    }
    let report: ShutdownReport = handle.shutdown().wait().unwrap();
    assert!(report.stopped);
    assert!(!report.joined);
    assert_eq!(report.dropped, 0);
    assert_eq!(counted.load(Ordering::SeqCst), 8);
}

#[test]
fn kill_drops_the_queue() {
    let (handle, release, entered) = blocking_handle();
    let held = handle.execute("hold()");
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }
    let queued: Vec<_> = (0..4).map(|_unused| handle.execute("1 + 1")).collect();

    let report = handle.kill();
    release.send(()).unwrap();
    held.wait().unwrap();

    let report = report.wait().unwrap();
    assert!(report.stopped);
    assert_eq!(report.dropped, 4);
    for pending in queued {
        assert!(matches!(pending.wait(), Err(XriptError::Cancelled)));
    }
}

#[test]
fn join_waits_for_the_thread_and_says_so() {
    let handle = handle();
    handle.execute("1 + 1").wait().unwrap();
    let report = handle.join().unwrap();
    assert!(report.stopped);
    assert!(report.joined);
}

#[test]
fn dropping_a_handle_does_not_wait_for_a_wedged_thread() {
    let (handle, release, entered) = blocking_handle();
    let held = handle.execute("hold()");
    held.detach();
    while !entered.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }

    let started = Instant::now();
    drop(handle);
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(500),
        "dropping a handle joined a wedged runtime thread ({elapsed:?})"
    );

    // The thread is abandoned, not reclaimed. Releasing it lets it exit.
    release.send(()).unwrap();
}

#[test]
fn a_gone_runtime_thread_fails_calls_rather_than_hanging() {
    let handle = handle();
    handle.shutdown().wait().unwrap();
    // The loop has broken; the sender still exists, so the call is dropped by
    // the completer rather than dispatched.
    assert!(handle.execute("1 + 1").wait().is_err());
}

#[test]
fn the_handle_is_usable_from_several_threads_at_once() {
    let handle = Arc::new(handle());
    let mut threads = Vec::new();
    for n in 0..8u32 {
        let handle = handle.clone();
        threads.push(std::thread::spawn(move || {
            handle.execute(&format!("{n} + {n}")).wait().unwrap().value
        }));
    }
    for (n, thread) in threads.into_iter().enumerate() {
        assert_eq!(thread.join().unwrap(), serde_json::json!(n * 2));
    }
}
