//! Pool guarantees, asserted against the public API only: one home worker per
//! mod, exactly-once hook handlers, a caller thread that stays responsive, and
//! the execute-only rule for dedicated routes.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use xript_runtime::{
    CallDescriptor, HostBindings, ModPlacement, PoolConfig, PoolRouter, PoolView, Route,
    RuntimeOptions, WorkerId, XriptError, XriptHandle, XriptPool,
};

const APP: &str = r#"{
    "xript": "0.8",
    "name": "verify-app",
    "limits": { "timeout_ms": 30000 },
    "bindings": { "tick": { "description": "counts one handler run" } },
    "hooks": { "onTick": { "description": "fires every tick" } }
}"#;

fn counting_pool(workers: usize) -> (XriptPool, Arc<AtomicU32>) {
    let counter = Arc::new(AtomicU32::new(0));
    let sink = counter.clone();
    let factory = move |_id: WorkerId| {
        let sink = sink.clone();
        let mut bindings = HostBindings::new();
        bindings.add_function("tick", move |_args: &[serde_json::Value]| {
            sink.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::Value::Null)
        });
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        }
    };
    let (pool, ready) = XriptPool::spawn(
        APP.to_string(),
        factory,
        PoolConfig {
            workers,
            interactive: 2,
            ..PoolConfig::default()
        },
    );
    ready.wait().unwrap();
    (pool, counter)
}

// -- 1. one home, one increment per handler per fire --------------------------

#[test]
fn each_hook_handler_runs_exactly_once_per_fire_and_each_mod_has_one_home() {
    let (pool, counter) = counting_pool(5);

    let mut homes = Vec::new();
    for i in 0..4 {
        let manifest = format!(
            r#"{{ "xript": "0.8", "name": "m{i}", "version": "1.0.0", "entry": {{ "script": "main.js" }} }}"#
        );
        let placed = pool
            .load_mod(
                &manifest,
                HashMap::new(),
                &HashSet::new(),
                Some("hooks.onTick(function() { tick(); return 1; });"),
            )
            .wait()
            .unwrap();
        // `PoolMod::home` is singular by type: a mod cannot name two homes.
        homes.push(placed.home);
        assert_eq!(pool.home_of(&format!("m{i}")), Some(placed.home));
    }
    assert_eq!(counter.load(Ordering::SeqCst), 0, "loading must not fire");

    for fire in 1..=3u32 {
        let results = pool.fire_hook("onTick", &[]).wait().unwrap();
        assert_eq!(results.len(), 4, "one result per handler, fire {fire}");
        assert_eq!(
            counter.load(Ordering::SeqCst),
            4 * fire,
            "exactly 4 handler runs per fire; fire {fire} saw duplication"
        );
    }
    assert_eq!(counter.load(Ordering::SeqCst), 12);

    // The mods really are spread over more than one worker, so "once" is not
    // an artifact of them all landing in one place.
    let distinct: HashSet<WorkerId> = homes.iter().copied().collect();
    assert!(
        distinct.len() > 1,
        "expected the 4 mods to span >1 worker, got {homes:?}"
    );

    pool.shutdown().wait().unwrap();
}

/// The blocker-1 shape proper: two mods sharing one home worker. A fan-out
/// that dispatches per-mod instead of per-home-worker fires every handler on
/// that worker once per mod, doubling every side effect.
#[test]
fn two_mods_co_located_on_one_worker_still_run_each_handler_exactly_once() {
    let (pool, counter) = counting_pool(3);

    let mut home = None;
    for i in 0..3 {
        let manifest = format!(
            r#"{{ "xript": "0.8", "name": "co{i}", "version": "1.0.0", "entry": {{ "script": "main.js" }} }}"#
        );
        let entry = "hooks.onTick(function() { tick(); return 1; });";
        let placed = match home {
            None => pool
                .load_mod(&manifest, HashMap::new(), &HashSet::new(), Some(entry))
                .wait()
                .unwrap(),
            Some(worker) => pool
                .load_mod_on(worker, &manifest, HashMap::new(), &HashSet::new(), Some(entry))
                .wait()
                .unwrap(),
        };
        home = Some(placed.home);
    }

    let results = pool.fire_hook("onTick", &[]).wait().unwrap();
    assert_eq!(results.len(), 3, "three handlers, three results");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        3,
        "three co-located handlers must run 3 times, not 9"
    );

    pool.shutdown().wait().unwrap();
}

#[test]
fn module_scope_state_proves_a_single_home_across_calls() {
    let (pool, _counter) = counting_pool(4);
    let manifest = r#"{ "xript": "0.8", "name": "stateful", "version": "1.0.0",
        "entry": { "script": "main.js", "exports": { "next": { "description": "increments" } } } }"#;
    pool.load_mod(
        manifest,
        HashMap::new(),
        &HashSet::new(),
        Some("var n = 0; xript.exports.register('next', function() { n += 1; return n; });"),
    )
    .wait()
    .unwrap();

    for expected in 1..=6 {
        let value = pool.invoke_export("stateful", "next", &[]).wait().unwrap();
        assert_eq!(
            value.as_i64(),
            Some(expected),
            "a second home would restart the counter"
        );
    }
    pool.shutdown().wait().unwrap();
}

// -- 4. the handle does not block a thread that must stay responsive ----------

#[test]
fn a_responsive_thread_keeps_ticking_while_a_long_call_is_in_flight() {
    let manifest = r#"{ "xript": "0.8", "name": "verify-app", "limits": { "timeout_ms": 30000 } }"#;
    let (handle, ready) = XriptHandle::spawn(manifest.to_string(), RuntimeOptions::default());
    ready.wait().unwrap();

    let frames = Arc::new(AtomicU64::new(0));
    let worst = Arc::new(Mutex::new(Duration::ZERO));

    let issued = Instant::now();
    let mut pending = handle.execute("var s = 0; for (var i = 0; i < 3000000; i++) { s += i; } s;");
    let issue_cost = issued.elapsed();
    assert!(
        issue_cost < Duration::from_millis(50),
        "issuing the call blocked the caller for {issue_cost:?}"
    );

    // The "UI thread": it must keep servicing frames while the script runs.
    let started = Instant::now();
    loop {
        let frame = Instant::now();
        frames.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1));
        let elapsed = frame.elapsed();
        let mut w = worst.lock().unwrap();
        if elapsed > *w {
            *w = elapsed;
        }
        drop(w);
        if pending.try_take().is_some() {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the script never finished"
        );
    }

    let ticks = frames.load(Ordering::SeqCst);
    let worst_frame = *worst.lock().unwrap();
    eprintln!("issue cost {issue_cost:?}; {ticks} frames serviced; worst frame {worst_frame:?}");
    assert!(
        ticks > 20,
        "the caller only serviced {ticks} frames while the script ran"
    );
    assert!(
        worst_frame < Duration::from_millis(150),
        "a frame stalled for {worst_frame:?}; the handle blocked the caller"
    );

    // Reads answer while the thread is busy, too.
    assert_eq!(handle.manifest_name(), "verify-app");
    handle.shutdown().wait().unwrap();
}

// -- 5. Dedicated on a mod-resident call --------------------------------------

struct AlwaysDedicated;

impl PoolRouter for AlwaysDedicated {
    fn route(&self, _call: &CallDescriptor<'_>, _pool: &PoolView<'_>) -> Route {
        Route::Dedicated
    }
    fn place(&self, _placement: &ModPlacement<'_>, _pool: &PoolView<'_>) -> WorkerId {
        WorkerId::Worker(0)
    }
}

#[test]
fn dedicated_is_rejected_for_an_export_and_silently_bypassed_for_a_hook() {
    let counter = Arc::new(AtomicU32::new(0));
    let sink = counter.clone();
    let factory = move |_id: WorkerId| {
        let sink = sink.clone();
        let mut bindings = HostBindings::new();
        bindings.add_function("tick", move |_args: &[serde_json::Value]| {
            sink.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::Value::Null)
        });
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        }
    };
    let (pool, ready) = XriptPool::spawn(
        APP.to_string(),
        factory,
        PoolConfig {
            workers: 2,
            interactive: 1,
            router: Arc::new(AlwaysDedicated),
            ..PoolConfig::default()
        },
    );
    ready.wait().unwrap();

    let manifest = r#"{ "xript": "0.8", "name": "m", "version": "1.0.0",
        "entry": { "script": "main.js", "exports": { "go": { "description": "goes" } } } }"#;
    pool.load_mod(
        manifest,
        HashMap::new(),
        &HashSet::new(),
        Some("hooks.onTick(function() { tick(); return 1; }); xript.exports.register('go', function() { return 42; });"),
    )
    .wait()
    .unwrap();

    let error = pool.invoke_export("m", "go", &[]).wait().unwrap_err();
    match &error {
        XriptError::RouteUnsupported {
            kind, route, target, ..
        } => {
            assert_eq!(*kind, "InvokeExport");
            assert_eq!(*route, "Dedicated");
            assert_eq!(target, "m::go");
        }
        other => panic!("expected RouteUnsupported, got {other}"),
    }
    let text = error.to_string();
    assert!(
        text.contains("execute-only") && text.contains("Dedicated"),
        "the message must name the rule and the route: {text}"
    );

    // Hooks never consult the router at all: the fan-out targets home workers
    // directly, so a router that demands `Dedicated` is neither honored nor
    // rejected here.
    let results = pool.fire_hook("onTick", &[]).wait().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    pool.shutdown().wait().unwrap();
}
