//! The runtime pool: one home per mod, two lanes, and honest wedge handling.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use xript_runtime::{
    CallDescriptor, HealthConfig, HookDispatch, HostBindings,
    ModPlacement, PoolConfig, PoolRouter, PoolView, Route, RuntimeOptions, Saturation, WedgePolicy,
    WorkerId, XriptError, XriptPool,
};

const APP: &str = r#"{
    "xript": "0.8",
    "name": "pool-app",
    "limits": { "timeout_ms": 30000, "memory_mb": 32 },
    "hooks": {
        "onTick": { "description": "fires every tick" }
    },
    "events": [ { "id": "ready", "description": "ready" } ]
}"#;

fn no_bindings() -> impl Fn(WorkerId) -> RuntimeOptions + Send + Sync + 'static {
    |_| RuntimeOptions::default()
}

fn config(workers: usize) -> PoolConfig {
    PoolConfig {
        workers,
        interactive: 1,
        ..PoolConfig::default()
    }
}

fn pool(workers: usize) -> XriptPool {
    let (pool, ready) = XriptPool::spawn(APP.to_string(), no_bindings(), config(workers));
    ready.wait().unwrap();
    pool
}

/// A mod whose `onTick` handler bumps a host counter. One handler, one mod,
/// one increment per fire — that is the invariant the home-worker rule exists
/// to preserve.
fn counting_mod(name: &str) -> (String, String) {
    let manifest = format!(
        r#"{{
            "xript": "0.8",
            "name": "{name}",
            "version": "1.0.0",
            "entry": {{ "script": "main.js" }}
        }}"#
    );
    let entry = format!(r#"hooks.onTick(function(n) {{ bump("{name}"); return "{name}"; }});"#);
    (manifest, entry)
}

/// Counts every `bump()` call by argument. The binding is called from every
/// worker thread at once, which is the contract a pooled host binding signs.
fn counting_bindings() -> (
    impl Fn(WorkerId) -> RuntimeOptions + Send + Sync + 'static,
    Arc<Mutex<Vec<String>>>,
) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink = log.clone();
    let factory = move |_id: WorkerId| {
        let sink = sink.clone();
        let mut bindings = HostBindings::new();
        bindings.add_function("bump", move |args: &[serde_json::Value]| {
            let who = args
                .first()
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            sink.lock().unwrap().push(who);
            Ok(serde_json::Value::Null)
        });
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        }
    };
    (factory, log)
}

const COUNTING_APP: &str = r#"{
    "xript": "0.8",
    "name": "pool-app",
    "limits": { "timeout_ms": 30000 },
    "bindings": { "bump": { "description": "counts a handler run" } },
    "hooks": { "onTick": { "description": "fires every tick" } },
    "events": [ { "id": "ready", "description": "ready" } ]
}"#;

fn counting_pool(workers: usize) -> (XriptPool, Arc<Mutex<Vec<String>>>) {
    let (factory, log) = counting_bindings();
    let (pool, ready) = XriptPool::spawn(COUNTING_APP.to_string(), factory, config(workers));
    ready.wait().unwrap();
    (pool, log)
}

fn load(pool: &XriptPool, manifest: &str, entry: &str) -> WorkerId {
    pool.load_mod(manifest, HashMap::new(), &HashSet::new(), Some(entry))
        .wait()
        .unwrap()
        .home
}

fn load_on(pool: &XriptPool, home: WorkerId, manifest: &str, entry: &str) -> WorkerId {
    pool.load_mod_on(home, manifest, HashMap::new(), &HashSet::new(), Some(entry))
        .wait()
        .unwrap()
        .home
}

// -- the blocker-1 regression ------------------------------------------------

#[test]
fn a_hook_handler_runs_exactly_once_with_three_mods_across_three_workers() {
    let (pool, log) = counting_pool(3);
    let mut homes = Vec::new();
    for (index, name) in ["mod-a", "mod-b", "mod-c"].into_iter().enumerate() {
        let (manifest, entry) = counting_mod(name);
        homes.push(load_on(&pool, WorkerId::Worker(index), &manifest, &entry));
    }

    let results = pool.fire_hook("onTick", &[serde_json::json!(1)]).wait().unwrap();

    let calls = log.lock().unwrap().clone();
    assert_eq!(
        calls.len(),
        3,
        "every handler must run exactly once, not once per worker: {calls:?}"
    );
    assert_eq!(results.len(), 3, "one result per handler");
    assert_eq!(
        results,
        vec![
            serde_json::json!("mod-a"),
            serde_json::json!("mod-b"),
            serde_json::json!("mod-c")
        ],
        "results are ordered by (load_seq, intra-mod index)"
    );
    assert_eq!(
        homes.iter().collect::<HashSet<_>>().len(),
        3,
        "the three mods live on three different interpreters"
    );
}

#[test]
fn merged_hook_results_match_a_single_runtime_under_both_dispatch_settings() {
    let names = ["mod-a", "mod-b", "mod-c", "mod-d"];

    let single = {
        let (factory, _log) = counting_bindings();
        let (pool, ready) = XriptPool::spawn(COUNTING_APP.to_string(), factory, config(1));
        ready.wait().unwrap();
        for name in names {
            let (manifest, entry) = counting_mod(name);
            load(&pool, &manifest, &entry);
        }
        pool.fire_hook("onTick", &[serde_json::json!(1)]).wait().unwrap()
    };

    for dispatch in [HookDispatch::Concurrent, HookDispatch::Sequential] {
        let (factory, _log) = counting_bindings();
        let (pool, ready) = XriptPool::spawn(
            COUNTING_APP.to_string(),
            factory,
            PoolConfig {
                hook_dispatch: dispatch,
                ..config(4)
            },
        );
        ready.wait().unwrap();
        for (index, name) in names.into_iter().enumerate() {
            let (manifest, entry) = counting_mod(name);
            load_on(&pool, WorkerId::Worker(index), &manifest, &entry);
        }
        let merged = pool.fire_hook("onTick", &[serde_json::json!(1)]).wait().unwrap();
        assert_eq!(
            merged, single,
            "{dispatch:?} must reproduce single-runtime order"
        );
    }
}

#[test]
fn an_event_reaches_each_subscriber_once() {
    let (pool, log) = counting_pool(3);
    for (index, name) in ["ev-a", "ev-b"].into_iter().enumerate() {
        let manifest = format!(
            r#"{{ "xript": "0.8", "name": "{name}", "version": "1.0.0", "entry": {{ "script": "main.js" }} }}"#
        );
        let entry =
            format!(r#"events.on("ready", function() {{ bump("{name}"); return "{name}"; }});"#);
        load_on(&pool, WorkerId::Worker(index), &manifest, &entry);
    }

    let results = pool.emit("ready", &[]).wait().unwrap();
    assert_eq!(
        results,
        vec![serde_json::json!("ev-a"), serde_json::json!("ev-b")],
        "one result per subscription, in load order"
    );
    let mut ran = log.lock().unwrap().clone();
    ran.sort();
    assert_eq!(
        ran,
        vec!["ev-a".to_string(), "ev-b".to_string()],
        "each subscriber runs exactly once; the order they run in across workers is deliberately not guaranteed under Concurrent"
    );
}

#[test]
fn a_hook_no_mod_handles_fires_nothing() {
    let (pool, log) = counting_pool(2);
    let results = pool.fire_hook("onTick", &[serde_json::json!(1)]).wait().unwrap();
    assert!(results.is_empty());
    assert!(log.lock().unwrap().is_empty());
}

#[test]
fn the_interactive_mod_cap_pushes_further_brief_mods_to_the_long_lane() {
    let (factory, _log) = counting_bindings();
    let (pool, ready) = XriptPool::spawn(
        COUNTING_APP.to_string(),
        factory,
        PoolConfig {
            interactive_mod_cap: 1,
            ..config(3)
        },
    );
    ready.wait().unwrap();

    let (first, entry) = counting_mod("first");
    assert_eq!(load(&pool, &first, &entry), WorkerId::Worker(0));
    let (second, entry) = counting_mod("second");
    assert_ne!(load(&pool, &second, &entry), WorkerId::Worker(0));
}

// -- residency ---------------------------------------------------------------

#[test]
fn a_mod_declaring_a_long_export_never_homes_on_the_interactive_lane() {
    let pool = pool(3);
    let manifest = r#"{
        "xript": "0.8",
        "name": "grinder",
        "version": "1.0.0",
        "entry": {
            "script": "main.js",
            "exports": { "crunch": { "description": "grinds", "execution": { "duration": "long" } } }
        }
    }"#;
    let placed = pool
        .load_mod(
            manifest,
            HashMap::new(),
            &HashSet::new(),
            Some(r#"xript.exports.register("crunch", function() { return 1; });"#),
        )
        .wait()
        .unwrap();

    assert_ne!(
        placed.home,
        WorkerId::Worker(0),
        "worker 0 is the interactive lane; a long mod must not home there"
    );
    assert_eq!(pool.home_of("grinder"), Some(placed.home));
}

#[test]
fn a_brief_mod_homes_on_the_interactive_lane() {
    let pool = pool(3);
    let manifest = r#"{
        "xript": "0.8",
        "name": "quick",
        "version": "1.0.0",
        "entry": { "script": "main.js", "exports": { "tick": { "description": "ticks" } } }
    }"#;
    let placed = pool
        .load_mod(
            manifest,
            HashMap::new(),
            &HashSet::new(),
            Some(r#"xript.exports.register("tick", function() { return 7; });"#),
        )
        .wait()
        .unwrap();
    assert_eq!(placed.home, WorkerId::Worker(0));
}

#[test]
fn an_export_is_invoked_on_its_home_worker_and_nowhere_else() {
    let pool = pool(3);
    let manifest = r#"{
        "xript": "0.8",
        "name": "stateful",
        "version": "1.0.0",
        "entry": { "script": "main.js", "exports": { "next": { "description": "counts" } } }
    }"#;
    pool.load_mod(
        manifest,
        HashMap::new(),
        &HashSet::new(),
        Some(r#"var n = 0; xript.exports.register("next", function() { n += 1; return n; });"#),
    )
    .wait()
    .unwrap();

    // Module-scope state only survives if every call lands on the same
    // interpreter. A replayed mod would restart the counter somewhere.
    let mut seen = Vec::new();
    for _ in 0..5 {
        seen.push(pool.invoke_export("stateful", "next", &[]).wait().unwrap());
    }
    assert_eq!(
        seen,
        vec![
            serde_json::json!(1),
            serde_json::json!(2),
            serde_json::json!(3),
            serde_json::json!(4),
            serde_json::json!(5)
        ]
    );
}

#[test]
fn invoking_an_export_of_an_unloaded_mod_names_the_mod() {
    let pool = pool(2);
    let error = pool.invoke_export("nobody", "nothing", &[]).wait().unwrap_err();
    assert!(matches!(error, XriptError::UnknownMod { .. }), "{error}");
}

// -- routing -----------------------------------------------------------------

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
fn a_custom_router_choosing_dedicated_for_an_export_fails_loudly() {
    let (pool, ready) = XriptPool::spawn(
        APP.to_string(),
        no_bindings(),
        PoolConfig {
            router: Arc::new(AlwaysDedicated),
            ..config(2)
        },
    );
    ready.wait().unwrap();
    pool.load_mod(
        r#"{ "xript": "0.8", "name": "m", "version": "1.0.0", "entry": { "script": "main.js", "exports": { "go": { "description": "goes" } } } }"#,
        HashMap::new(),
        &HashSet::new(),
        Some(r#"xript.exports.register("go", function() { return 1; });"#),
    )
    .wait()
    .unwrap();

    let error = pool.invoke_export("m", "go", &[]).wait().unwrap_err();
    match error {
        XriptError::RouteUnsupported { kind, route, .. } => {
            assert_eq!(kind, "InvokeExport");
            assert_eq!(route, "Dedicated");
        }
        other => panic!("expected RouteUnsupported, got {other}"),
    }
    assert!(
        error.to_string().contains("execute-only"),
        "the message names the rule: {error}"
    );
}

#[test]
fn the_default_router_clamps_an_isolated_export_to_home_and_records_it() {
    let pool = pool(3);
    let manifest = r#"{
        "xript": "0.8",
        "name": "loner",
        "version": "1.0.0",
        "entry": {
            "script": "main.js",
            "exports": { "go": { "description": "goes", "execution": { "affinity": "isolated" } } }
        }
    }"#;
    let placed = pool
        .load_mod(
            manifest,
            HashMap::new(),
            &HashSet::new(),
            Some(r#"xript.exports.register("go", function() { return 42; });"#),
        )
        .wait()
        .unwrap();

    // Twice, to prove the clamp is recorded once per (mod, target).
    assert_eq!(
        pool.invoke_export("loner", "go", &[]).wait().unwrap(),
        serde_json::json!(42)
    );
    assert_eq!(
        pool.invoke_export("loner", "go", &[]).wait().unwrap(),
        serde_json::json!(42)
    );
    assert_eq!(pool.home_of("loner"), Some(placed.home));
    // `IntentRouter`'s residency rule fires before affinity, so no clamp is
    // even reached: the call was never a candidate for a dedicated runtime.
    assert_eq!(pool.stats().route_clamps, 0);
}

#[test]
fn an_isolated_execute_gets_a_dedicated_runtime() {
    let pool = pool(2);
    let intent = xript_runtime::ResolvedIntent {
        duration: xript_runtime::IntentDuration::Brief,
        affinity: xript_runtime::IntentAffinity::Isolated,
    };
    let result = pool.execute_with("1 + 1", intent).wait().unwrap();
    assert_eq!(result.value, serde_json::json!(2));
    assert_eq!(
        pool.stats().dedicated_live,
        0,
        "a dedicated runtime is torn down after its one call"
    );
}

#[test]
fn a_long_execute_lands_off_the_interactive_lane() {
    let pool = pool(3);
    let intent = xript_runtime::ResolvedIntent {
        duration: xript_runtime::IntentDuration::Long,
        affinity: xript_runtime::IntentAffinity::Any,
    };
    // Routing is observable through where the interpreter state lands.
    pool.execute_with("globalThis.__here = 'long';", intent)
        .wait()
        .unwrap();
    let interactive = pool
        .on(WorkerId::Worker(0))
        .unwrap()
        .execute("typeof globalThis.__here")
        .wait()
        .unwrap();
    assert_eq!(interactive.value, serde_json::json!("undefined"));
}

// -- no serialization across workers ----------------------------------------

#[test]
fn two_workers_can_be_inside_the_same_host_binding_at_once() {
    let inside = Arc::new(AtomicU32::new(0));
    let peak = Arc::new(AtomicU32::new(0));
    let both = Arc::new(AtomicBool::new(false));

    let factory = {
        let inside = inside.clone();
        let peak = peak.clone();
        let both = both.clone();
        move |_id: WorkerId| {
            let inside = inside.clone();
            let peak = peak.clone();
            let both = both.clone();
            let mut bindings = HostBindings::new();
            bindings.add_function("overlap", move |_args: &[serde_json::Value]| {
                let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                let deadline = Instant::now() + Duration::from_secs(3);
                while inside.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
                    std::thread::yield_now();
                }
                if inside.load(Ordering::SeqCst) >= 2 {
                    both.store(true, Ordering::SeqCst);
                }
                inside.fetch_sub(1, Ordering::SeqCst);
                Ok(serde_json::Value::Null)
            });
            RuntimeOptions {
                host_bindings: bindings,
                ..RuntimeOptions::default()
            }
        }
    };

    let manifest = r#"{
        "xript": "0.8",
        "name": "pool-app",
        "limits": { "timeout_ms": 30000 },
        "bindings": { "overlap": { "description": "waits for a second caller" } }
    }"#;
    let (pool, ready) = XriptPool::spawn(manifest.to_string(), factory, config(2));
    ready.wait().unwrap();

    let a = pool.on(WorkerId::Worker(0)).unwrap().execute("overlap()");
    let b = pool.on(WorkerId::Worker(1)).unwrap().execute("overlap()");
    a.wait().unwrap();
    b.wait().unwrap();

    assert!(
        both.load(Ordering::SeqCst),
        "the pool must not serialize host bindings; a per-binding lock here would \
         let a long-lane call block an interactive-lane one"
    );
    assert_eq!(peak.load(Ordering::SeqCst), 2);
}

// -- saturation --------------------------------------------------------------

const HOLD_APP: &str = r#"{
    "xript": "0.8",
    "name": "pool-app",
    "limits": { "timeout_ms": 30000 },
    "bindings": { "hold": { "description": "blocks the runtime thread" } }
}"#;

/// A pool whose one long-lane worker blocks inside `hold()` until released.
fn blocking_pool(saturation: Saturation, queue_depth: usize) -> (XriptPool, mpsc::Sender<()>) {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let factory = move |_id: WorkerId| {
        let release_rx = release_rx.clone();
        let mut bindings = HostBindings::new();
        bindings.add_function("hold", move |_args: &[serde_json::Value]| {
            let _unused = release_rx.lock().unwrap().recv();
            Ok(serde_json::json!("released"))
        });
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        }
    };
    let (pool, ready) = XriptPool::spawn(
        HOLD_APP.to_string(),
        factory,
        PoolConfig {
            workers: 2,
            interactive: 1,
            queue_depth,
            saturation,
            ..PoolConfig::default()
        },
    );
    ready.wait().unwrap();
    (pool, release_tx)
}

fn long() -> xript_runtime::ResolvedIntent {
    xript_runtime::ResolvedIntent {
        duration: xript_runtime::IntentDuration::Long,
        affinity: xript_runtime::IntentAffinity::Any,
    }
}

fn wait_for(mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
fn reject_says_so_immediately_instead_of_growing_the_queue() {
    let (pool, release) = blocking_pool(Saturation::Reject, 2);
    let occupying = pool.execute_with("hold()", long());
    let queued = pool.execute_with("1", long());
    assert!(wait_for(|| pool.stats().queued >= 2));

    match pool.execute_with("1", long()).wait() {
        Err(XriptError::Saturated { lane, limit, .. }) => {
            assert_eq!(lane, "long");
            assert_eq!(limit, 2);
        }
        other => panic!("expected Saturated, got {other:?}"),
    }

    let _ = release.send(());
    occupying.wait().unwrap();
    queued.wait().unwrap();
}

#[test]
fn shed_oldest_drops_a_queued_call_and_never_the_running_one() {
    let (pool, release) = blocking_pool(Saturation::ShedOldest, 2);
    let running = pool.execute_with("hold()", long());
    // Not merely queued: dispatched. A call still sitting in the queue is a
    // legitimate shed target, and the point here is that a dispatched one
    // never is.
    assert!(wait_for(|| pool
        .on(WorkerId::Worker(1))
        .map(|w| w.in_flight().is_some())
        .unwrap_or(false)));
    let doomed = pool.execute_with("2", long());
    assert!(wait_for(|| pool.stats().queued >= 2));
    let survivor = pool.execute_with("3", long());

    match doomed.wait() {
        Err(XriptError::Shed { .. }) => {}
        other => panic!("expected the oldest queued call to be shed, got {other:?}"),
    }
    let _ = release.send(());
    assert_eq!(
        running.wait().unwrap().value,
        serde_json::json!("released"),
        "the running call is never shed: shedding rides the pre-dispatch token check"
    );
    assert_eq!(survivor.wait().unwrap().value, serde_json::json!(3));
}

#[test]
fn the_interactive_lane_never_sheds_or_rejects() {
    let (pool, release) = blocking_pool(Saturation::Reject, 1);
    let occupying = pool.interactive().execute("hold()");
    // Each of these is past `queue_depth` on the interactive lane and is
    // admitted anyway: dropping a UI event is worse than waiting for it.
    let queued: Vec<_> = (0..4).map(|n| pool.execute(&format!("{n}"))).collect();
    let _ = release.send(());
    occupying.wait().unwrap();
    for (n, pending) in queued.into_iter().enumerate() {
        assert_eq!(pending.wait().unwrap().value, serde_json::json!(n));
    }
}

#[test]
fn dropping_a_queued_pending_cancels_only_that_call() {
    let (pool, release) = blocking_pool(Saturation::Backpressure, 64);
    let running = pool.execute_with("hold()", long());
    assert!(wait_for(|| pool.stats().queued >= 1));

    drop(pool.execute_with("2", long()));
    let after = pool.execute_with("3", long());

    let _ = release.send(());
    running.wait().unwrap();
    assert_eq!(
        after.wait().unwrap().value,
        serde_json::json!(3),
        "a dropped call must not poison the one behind it"
    );
}

// -- wedge detection ---------------------------------------------------------

const WEDGE_APP: &str = r#"{
    "xript": "0.8",
    "name": "pool-app",
    "limits": { "timeout_ms": 60000, "memory_mb": 16 },
    "bindings": { "wedge": { "description": "never returns until released" } }
}"#;

const WEDGE_MOD: &str = r#"{
    "xript": "0.8",
    "name": "waiter",
    "version": "1.0.0",
    "entry": {
        "script": "main.js",
        "exports": {
            "block": { "description": "parks the thread in a host binding" },
            "ping": { "description": "answers instantly" }
        }
    }
}"#;

const WEDGE_ENTRY: &str = r#"
    xript.exports.register("block", function() { return wedge(); });
    xript.exports.register("ping", function() { return "pong"; });
"#;

/// The shipped thresholds are measured in seconds; the tests run a compressed
/// clock so they stay fast without changing what is being tested.
fn quick_health(seen: Arc<Mutex<Vec<String>>>) -> HealthConfig {
    HealthConfig {
        interval: Duration::from_millis(20),
        wedge_threshold: Duration::from_millis(150),
        unbounded_threshold: Duration::from_millis(400),
        heartbeat_stall: Duration::from_millis(100),
        on_wedge: Some(Arc::new(move |wedged| {
            seen.lock()
                .unwrap()
                .push(wedged.binding.clone().unwrap_or_default());
        })),
        ..HealthConfig::default()
    }
}

/// A two-worker pool with a mod homed on the long-lane worker whose `block`
/// export parks that worker's thread inside a host binding.
fn wedging_pool(policy: WedgePolicy) -> (XriptPool, mpsc::Sender<()>, Arc<Mutex<Vec<String>>>) {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let factory = move |_id: WorkerId| {
        let release_rx = release_rx.clone();
        let mut bindings = HostBindings::new();
        bindings.add_function("wedge", move |_args: &[serde_json::Value]| {
            let _unused = release_rx.lock().unwrap().recv();
            Ok(serde_json::Value::Null)
        });
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        }
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (pool, ready) = XriptPool::spawn(
        WEDGE_APP.to_string(),
        factory,
        PoolConfig {
            workers: 2,
            interactive: 1,
            wedge_policy: policy,
            health: quick_health(seen.clone()),
            ..PoolConfig::default()
        },
    );
    ready.wait().unwrap();
    load_on(&pool, WorkerId::Worker(1), WEDGE_MOD, WEDGE_ENTRY);
    (pool, release_tx, seen)
}

#[test]
fn a_blocking_binding_trips_wedge_detection_and_names_itself() {
    let (pool, release, seen) = wedging_pool(WedgePolicy::FailFast);
    let wedged_call = pool.invoke_export("waiter", "block", &[]);

    assert!(
        wait_for(|| !pool.stats().wedged.is_empty()),
        "a thread parked in a host binding must be detected"
    );
    let stats = pool.stats();
    let record = &stats.wedged[0];
    assert_eq!(record.id, WorkerId::Worker(1));
    assert_eq!(
        record.binding.as_deref(),
        Some("wedge"),
        "the report names the binding the thread is stuck in"
    );
    assert_eq!(record.homed_mods, vec!["waiter".to_string()]);
    assert_eq!(seen.lock().unwrap().as_slice(), &["wedge".to_string()]);

    // The mod is homed there, so it cannot be reached. FailFast says so rather
    // than queueing behind something that may never return.
    let error = pool.invoke_export("waiter", "ping", &[]).wait().unwrap_err();
    match error {
        XriptError::WorkerWedged { ref binding, .. } => {
            assert_eq!(binding.as_deref(), Some("wedge"));
        }
        ref other => panic!("expected WorkerWedged, got {other}"),
    }
    assert!(
        error.to_string().contains("cannot interrupt a host binding"),
        "the message is honest about what xript will not do: {error}"
    );

    let _ = release.send(());
    let _ = wedged_call.wait();
}

#[test]
fn the_healthy_worker_keeps_serving_while_another_is_wedged() {
    let (pool, release, _seen) = wedging_pool(WedgePolicy::FailFast);
    let wedged_call = pool.invoke_export("waiter", "block", &[]);
    assert!(wait_for(|| !pool.stats().wedged.is_empty()));

    // Routing excludes the unhealthy worker, so ordinary work keeps flowing.
    assert_eq!(
        pool.execute("40 + 2").wait().unwrap().value,
        serde_json::json!(42)
    );
    let _ = release.send(());
    let _ = wedged_call.wait();
}

#[test]
fn calls_queued_behind_a_wedged_one_are_answered_rather_than_stranded() {
    let (pool, release, _seen) = wedging_pool(WedgePolicy::FailFast);
    let wedged_call = pool.invoke_export("waiter", "block", &[]);
    // Queued before detection, so it is genuinely sitting behind the wedge.
    let queued = pool.invoke_export("waiter", "ping", &[]);
    assert!(wait_for(|| !pool.stats().wedged.is_empty()));

    match queued.wait() {
        Err(XriptError::WorkerWedged { stalled_ms, .. }) => {
            assert!(stalled_ms > 0);
        }
        other => panic!("expected the queued call to be answered, got {other:?}"),
    }
    let _ = release.send(());
    let _ = wedged_call.wait();
}

#[test]
fn a_script_that_legitimately_runs_long_is_never_marked_wedged() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (pool, ready) = XriptPool::spawn(
        r#"{ "xript": "0.8", "name": "pool-app", "limits": { "timeout_ms": 60000 } }"#.to_string(),
        no_bindings(),
        PoolConfig {
            workers: 2,
            interactive: 1,
            health: quick_health(seen.clone()),
            ..PoolConfig::default()
        },
    );
    ready.wait().unwrap();

    // A grind far past `wedge_threshold`. The interrupt handler fires the
    // whole time, so the heartbeat advances and the second condition never
    // holds. Both conditions are required, and this is why.
    let grind = pool.execute_with(
        "var n = 0; var t = Date.now(); while (Date.now() - t < 1200) { n += 1; } n > 0",
        long(),
    );

    assert!(grind.wait().unwrap().value.as_bool().unwrap_or(false));
    assert!(
        pool.stats().wedged.is_empty(),
        "a running script must never read as wedged; that is what limits are for"
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn retiring_a_wedged_worker_abandons_it_and_says_so() {
    let (pool, release, _seen) = wedging_pool(WedgePolicy::FailFast);
    let wedged_call = pool.invoke_export("waiter", "block", &[]);
    assert!(wait_for(|| !pool.stats().wedged.is_empty()));

    pool.retire_worker(WorkerId::Worker(1)).wait().unwrap();
    assert!(pool.on(WorkerId::Worker(1)).is_none());
    assert_eq!(pool.stats().retired, vec![WorkerId::Worker(1)]);
    assert_eq!(
        pool.home_of("waiter"),
        Some(WorkerId::Worker(1)),
        "home_of still answers, so a host can tell unreachable from never-loaded"
    );

    let report = pool.shutdown().wait().unwrap();
    assert!(
        report.abandoned.contains(&WorkerId::Worker(1)),
        "a retired worker is abandoned, never joined"
    );
    assert!(
        report.leaked_bytes_estimate > 0,
        "the report states the memory that is never coming back"
    );
    assert!(report.joined.contains(&WorkerId::Worker(0)));

    let _ = release.send(());
    let _ = wedged_call.wait();
}

// -- routing surface ---------------------------------------------------------

#[test]
fn a_brief_execute_lands_on_the_interactive_lane() {
    let pool = pool(3);
    pool.execute("globalThis.__here = 'brief';").wait().unwrap();
    let interactive = pool
        .on(WorkerId::Worker(0))
        .unwrap()
        .execute("globalThis.__here")
        .wait()
        .unwrap();
    assert_eq!(interactive.value, serde_json::json!("brief"));
}

#[test]
fn audit_records_name_the_worker_that_raised_them_and_are_ordered_per_worker() {
    let (tx, rx) = mpsc::channel();
    let factory = move |_id: WorkerId| {
        let mut bindings = HostBindings::new();
        bindings.add_function("ping", |_args: &[serde_json::Value]| {
            Ok(serde_json::json!("pong"))
        });
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        }
        .with_audit_channel(tx.clone())
    };
    let manifest = r#"{
        "xript": "0.8",
        "name": "pool-app",
        "limits": { "timeout_ms": 30000 },
        "bindings": { "ping": { "description": "pings" } }
    }"#;
    let (pool, ready) = XriptPool::spawn(manifest.to_string(), factory, config(2));
    ready.wait().unwrap();

    for _ in 0..3 {
        pool.on(WorkerId::Worker(0)).unwrap().execute("ping()").wait().unwrap();
        pool.on(WorkerId::Worker(1)).unwrap().execute("ping()").wait().unwrap();
    }

    let mut by_worker: HashMap<Option<usize>, Vec<u64>> = HashMap::new();
    for _ in 0..6 {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        by_worker.entry(event.worker).or_default().push(event.seq);
    }
    assert_eq!(by_worker.len(), 2, "each worker stamps its own id");
    for (worker, seqs) in by_worker {
        assert!(worker.is_some());
        // Total order per worker; the cross-worker interleaving is only
        // partial and deliberately not reconstructible.
        assert_eq!(seqs, vec![0, 1, 2], "worker {worker:?} sequences its own");
    }
}

#[test]
fn each_worker_gets_its_own_interpreter_state() {
    let pool = pool(2);
    pool.on(WorkerId::Worker(0))
        .unwrap()
        .execute("globalThis.__mine = 'zero';")
        .wait()
        .unwrap();
    let other = pool
        .on(WorkerId::Worker(1))
        .unwrap()
        .execute("typeof globalThis.__mine")
        .wait()
        .unwrap();
    assert_eq!(
        other.value,
        serde_json::json!("undefined"),
        "workers are built one at a time from the factory and share no runtime state; \
         sharing a library registry in particular would let one worker's load phase \
         authorize another's dynamic import"
    );
}

#[test]
fn shutdown_reports_every_worker_it_stopped() {
    let pool = pool(3);
    let report = pool.shutdown().wait().unwrap();
    assert_eq!(report.joined.len(), 3);
    assert!(report.abandoned.is_empty());
    assert_eq!(report.leaked_bytes_estimate, 0);
}
