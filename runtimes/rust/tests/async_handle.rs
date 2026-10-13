//! `XriptHandle` and `XriptPool` over `RuntimeMode::Async` runtimes: calls
//! parked on async host bindings stay parked while later calls run.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{mpsc, Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use xript_runtime::{
    HealthConfig, HostBindings, IntentAffinity, IntentDuration, PoolConfig, ResolvedIntent,
    RuntimeMode, RuntimeOptions, WorkerId, XriptError, XriptHandle, XriptPool,
};

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

const APP: &str = r#"{
    "xript": "0.9",
    "name": "host",
    "limits": { "timeout_ms": 30000 },
    "bindings": {
        "slow": { "description": "resolves after N ms", "params": [{ "name": "ms", "type": "number" }] },
        "hold": { "description": "blocks the thread until released" }
    }
}"#;

const MOD: &str = r#"{
    "xript": "0.9",
    "name": "mod-a",
    "version": "1.0.0",
    "entry": { "script": "main.js", "format": "module", "exports": { "fetch": { "description": "awaits slow" }, "block": { "description": "holds the thread" } } }
}"#;

const MOD_SOURCE: &str = r#"
const ready = await slow(10);
export async function fetch(ms) { return ready + ' then ' + (await slow(ms)); }
export function block() { return hold(); }
"#;

fn yielding_options(release: Option<Arc<Mutex<mpsc::Receiver<()>>>>) -> RuntimeOptions {
    let mut bindings = HostBindings::new();
    bindings.add_async_function("slow", |args: &[Value]| {
        let ms = args.first().and_then(|v| v.as_u64()).unwrap_or(0);
        async move {
            sleep(ms).await;
            Ok(json!(format!("slept {ms}")))
        }
    });
    bindings.add_function("hold", move |_args: &[Value]| {
        if let Some(ref release) = release {
            let _unused = release.lock().unwrap().recv();
        }
        Ok(Value::Null)
    });
    RuntimeOptions {
        host_bindings: bindings,
        mode: RuntimeMode::Async,
        ..RuntimeOptions::default()
    }
}

fn handle() -> XriptHandle {
    XriptHandle::new(APP.to_string(), yielding_options(None)).unwrap()
}

#[test]
fn a_later_call_completes_while_an_earlier_one_is_parked() {
    let handle = handle();
    let started = Instant::now();
    let slow = handle.execute("slow(400)");
    let quick = handle.execute("40 + 2");
    assert_eq!(quick.wait().unwrap().value, json!(42));
    assert!(started.elapsed() < Duration::from_millis(300), "{:?}", started.elapsed());
    assert_eq!(slow.wait().unwrap().value, json!("slept 400"));
}

#[test]
fn several_parked_calls_are_reported_in_flight() {
    let handle = handle();
    let a = handle.execute("slow(300)");
    let b = handle.execute("slow(300)");
    let deadline = Instant::now() + Duration::from_secs(2);
    while handle.in_flight_all().len() < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(handle.in_flight_all().len(), 2);
    assert_eq!(handle.in_flight().unwrap().kind, "execute");
    assert_eq!(a.wait().unwrap().value, json!("slept 300"));
    assert_eq!(b.wait().unwrap().value, json!("slept 300"));
    assert!(handle.in_flight_all().is_empty());
}

#[test]
fn load_mod_is_a_barrier_and_async_exports_interleave() {
    let handle = handle();
    let loaded = handle.load_mod(MOD, HashMap::new(), &HashSet::new(), Some(MOD_SOURCE));
    let first = handle.invoke_export("fetch", &[json!(300)]);
    let second = handle.invoke_mod_export("mod-a", "fetch", &[json!(20)]);
    loaded.wait().unwrap();
    let started = Instant::now();
    assert_eq!(second.wait().unwrap(), json!("slept 10 then slept 20"));
    assert!(started.elapsed() < Duration::from_millis(250));
    assert_eq!(first.wait().unwrap(), json!("slept 10 then slept 300"));
}

#[test]
fn dropping_a_parked_calls_pending_cancels_only_that_call() {
    let handle = handle();
    let doomed = handle.execute("slow(10000)");
    std::thread::sleep(Duration::from_millis(30));
    drop(doomed);
    let deadline = Instant::now() + Duration::from_secs(2);
    while !handle.in_flight_all().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(handle.in_flight_all().is_empty(), "the dropped call should have unparked and finished");
    assert_eq!(handle.execute("'alive'").wait().unwrap().value, json!("alive"));
}

#[test]
fn shutdown_waits_for_parked_calls_and_kill_cancels_them() {
    let handle = handle();
    let parked = handle.execute("slow(150)");
    std::thread::sleep(Duration::from_millis(20));
    let report = handle.shutdown().wait().unwrap();
    assert!(report.stopped);
    assert_eq!(parked.wait().unwrap().value, json!("slept 150"));

    let handle = self::handle();
    let parked = handle.execute("slow(10000)");
    std::thread::sleep(Duration::from_millis(30));
    let started = Instant::now();
    let report = handle.kill().wait().unwrap();
    assert!(report.stopped);
    assert!(matches!(parked.wait(), Err(XriptError::Cancelled)));
    assert!(started.elapsed() < Duration::from_secs(2));
}

fn quick_health() -> HealthConfig {
    HealthConfig {
        interval: Duration::from_millis(20),
        wedge_threshold: Duration::from_millis(150),
        unbounded_threshold: Duration::from_millis(400),
        heartbeat_stall: Duration::from_millis(100),
        ..HealthConfig::default()
    }
}

fn long() -> ResolvedIntent {
    ResolvedIntent {
        duration: IntentDuration::Long,
        affinity: IntentAffinity::Any,
    }
}

#[test]
fn a_pool_worker_parked_on_an_async_binding_is_not_wedged() {
    let (pool, ready) = XriptPool::spawn(
        APP.to_string(),
        |_id: WorkerId| yielding_options(None),
        PoolConfig {
            workers: 2,
            interactive: 1,
            health: quick_health(),
            ..PoolConfig::default()
        },
    );
    ready.wait().unwrap();
    let parked = pool.execute_with("slow(700)", long());
    assert_eq!(parked.wait().unwrap().value, json!("slept 700"));
    assert!(pool.stats().wedged.is_empty(), "{:?}", pool.stats().wedged);
}

#[test]
fn a_pool_worker_inside_a_sync_binding_is_still_wedged() {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let (pool, ready) = XriptPool::spawn(
        APP.to_string(),
        move |_id: WorkerId| yielding_options(Some(release_rx.clone())),
        PoolConfig {
            workers: 2,
            interactive: 1,
            health: quick_health(),
            ..PoolConfig::default()
        },
    );
    ready.wait().unwrap();
    let held = pool.execute_with("hold()", long());
    let deadline = Instant::now() + Duration::from_secs(5);
    while pool.stats().wedged.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let stats = pool.stats();
    assert_eq!(stats.wedged.len(), 1);
    assert_eq!(stats.wedged[0].binding.as_deref(), Some("hold"));
    let _ = release_tx.send(());
    let _ = held.wait();
}
