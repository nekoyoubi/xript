//! A pool has one events bus. Mods homed on different workers subscribe,
//! emit, claim, declare and cancel against the same catalogue and the same
//! subscriptions, and an emit reaches every handler in subscription order,
//! wherever it lives, with the results a single runtime would give.

#![cfg(feature = "threads")]

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use xript_runtime::{PoolConfig, RuntimeOptions, WorkerId, XriptPool};

const HOST: &str = r#"{
    "xript": "0.10",
    "name": "pool-bus-host",
    "capabilities": {
        "events.claim": { "description": "claim a namespace" },
        "events.declare": { "description": "declare an event" },
        "events.off": { "description": "cancel others' subscriptions" }
    },
    "events": [
        { "id": "note.posted", "description": "A note was posted.", "emit": "mods" },
        { "id": "note.echoed", "description": "A note was echoed back.", "emit": "mods" },
        { "id": "rich", "description": "Carries values JSON cannot spell.", "emit": "mods" },
        { "id": "tick", "description": "The host ticked." }
    ]
}"#;

const MOD_SOURCE: &str = r#"
var subs = [];
xript.exports.register('listen', function (tag, event) {
    subs.push(events.on(event || 'note.posted', function (x) { return tag + ':' + x; }));
    return subs.length;
});
xript.exports.register('listenOnce', function (tag) {
    events.once('note.posted', function (x) { return tag + '-once:' + x; });
    return true;
});
xript.exports.register('post', function (x) { return events.emit('note.posted', x); });
xript.exports.register('postAsync', function (x) { return events.emitAsync('note.posted', x); });
xript.exports.register('relay', function (tag) {
    events.on('note.posted', function (x) { return events.emit('note.echoed', x).join('+'); });
    return true;
});
xript.exports.register('dropFirst', function () { return subs.length ? subs[0].cancel() : null; });
xript.exports.register('claim', function (prefix) { return events.claim(prefix); });
xript.exports.register('ownerOf', function (id) { return events.ownerOf(id); });
xript.exports.register('declare', function (id) { return events.declare({ id: id, description: 'declared at runtime', emit: 'mods' }); });
xript.exports.register('describe', function (id) { var entry = events.describe(id); return entry && entry.id; });
xript.exports.register('count', function (id) { return events.listenerCount(id); });
xript.exports.register('owners', function (id) { return events.subscribers(id).owners; });
xript.exports.register('describeRich', function (tag) {
    events.on('rich', function (u, n, i, ni, z, arr, f) {
        return [tag, typeof u, arguments.length, Number.isNaN(n), i === Infinity, ni === -Infinity, Object.is(z, -0),
            arr.length, typeof arr[0], typeof f, f && f['$xriptCallback']].join('|');
    });
    return true;
});
xript.exports.register('answerRich', function () {
    events.on('rich', function () { return [undefined, NaN, -0, Infinity, function () {}]; });
    return true;
});
xript.exports.register('postRich', function () {
    var results = events.emit('rich', { u: undefined, n: NaN, i: Infinity, ni: -Infinity, z: -0, arr: [undefined, 1], f: function () {} });
    return results.map(function (r) {
        return typeof r === 'string' ? r
            : [r.length, typeof r[0], Number.isNaN(r[1]), Object.is(r[2], -0), r[3], typeof r[4], r[4] && r[4]['$xriptCallback']].join('|');
    });
});
"#;

const EXPORTS: &[&str] = &[
    "listen", "listenOnce", "post", "postAsync", "relay", "dropFirst", "claim", "ownerOf", "declare", "describe", "count", "owners",
    "describeRich", "answerRich", "postRich",
];

fn pool() -> XriptPool {
    let config = PoolConfig { workers: 2, interactive: 1, ..PoolConfig::default() };
    let (pool, ready) = XriptPool::spawn(
        HOST.to_string(),
        |_| RuntimeOptions {
            capabilities: vec!["events.claim".into(), "events.declare".into()],
            ..RuntimeOptions::default()
        },
        config,
    );
    ready.wait().unwrap();
    pool
}

fn load(pool: &XriptPool, name: &str, worker: usize) {
    let exports: serde_json::Map<String, Value> =
        EXPORTS.iter().map(|e| (e.to_string(), json!({ "description": e }))).collect();
    let manifest = json!({
        "xript": "0.10", "name": name, "version": "1.0.0",
        "entry": { "script": "mod.js", "exports": exports }
    });
    let granted: HashSet<String> = ["events.claim", "events.declare"].iter().map(|c| c.to_string()).collect();
    let loaded = pool
        .load_mod_on(
            WorkerId::Worker(worker),
            &manifest.to_string(),
            HashMap::from([("mod.js".to_string(), MOD_SOURCE.to_string())]),
            &granted,
            None,
        )
        .wait()
        .unwrap();
    assert_eq!(loaded.home, WorkerId::Worker(worker));
}

fn call(pool: &XriptPool, mod_id: &str, export: &str, args: &[Value]) -> Value {
    pool.invoke_export(mod_id, export, args).wait().unwrap()
}

#[test]
fn a_host_emit_reaches_every_worker_in_subscription_order() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-b", "listen", &[json!("b1")]);
    call(&pool, "mod-a", "listen", &[json!("a1")]);
    call(&pool, "mod-b", "listen", &[json!("b2")]);
    call(&pool, "mod-a", "listen", &[json!("a2")]);
    assert_eq!(pool.emit("note.posted", &[json!("x")]).wait().unwrap(), vec![json!("b1:x"), json!("a1:x"), json!("b2:x"), json!("a2:x")]);
}

#[test]
fn a_mod_emit_reaches_handlers_on_other_workers() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-a", "listen", &[json!("a")]);
    call(&pool, "mod-b", "listen", &[json!("b")]);
    assert_eq!(call(&pool, "mod-a", "post", &[json!(1)]), json!(["a:1", "b:1"]));
    assert_eq!(call(&pool, "mod-b", "post", &[json!(2)]), json!(["a:2", "b:2"]));
}

#[test]
fn emits_that_cross_back_and_forth_do_not_deadlock() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-b", "relay", &[json!("b")]);
    call(&pool, "mod-a", "listen", &[json!("a"), json!("note.echoed")]);
    call(&pool, "mod-b", "listen", &[json!("b"), json!("note.echoed")]);
    assert_eq!(call(&pool, "mod-a", "post", &[json!("hi")]), json!(["a:hi+b:hi"]));
    assert_eq!(pool.emit("note.posted", &[json!("yo")]).wait().unwrap(), vec![json!("a:yo+b:yo")]);
}

#[test]
fn a_once_subscription_fires_once_across_the_pool() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-b", "listenOnce", &[json!("b")]);
    assert_eq!(call(&pool, "mod-a", "post", &[json!(1)]), json!(["b-once:1"]));
    assert_eq!(call(&pool, "mod-a", "post", &[json!(2)]), json!([]));
    assert_eq!(pool.emit("note.posted", &[json!(3)]).wait().unwrap(), Vec::<Value>::new());
}

#[test]
fn introspection_and_cancellation_agree_on_every_worker() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-a", "listen", &[json!("a")]);
    call(&pool, "mod-b", "listen", &[json!("b")]);
    call(&pool, "mod-b", "listen", &[json!("b")]);
    for mod_id in ["mod-a", "mod-b"] {
        assert_eq!(call(&pool, mod_id, "count", &[json!("note.posted")]), json!(3));
        assert_eq!(
            call(&pool, mod_id, "owners", &[json!("note.posted")]),
            json!([{ "owner": "mod-a", "count": 1 }, { "owner": "mod-b", "count": 2 }])
        );
    }
    assert_eq!(pool.cancel_owned(Some("mod-b")).wait().unwrap(), 2);
    assert_eq!(call(&pool, "mod-a", "count", &[json!("note.posted")]), json!(1));
    assert_eq!(pool.emit("note.posted", &[json!("x")]).wait().unwrap(), vec![json!("a:x")]);
    assert_eq!(call(&pool, "mod-a", "dropFirst", &[]), json!({ "cancelled": true, "spent": false }));
    assert_eq!(call(&pool, "mod-b", "count", &[json!("note.posted")]), json!(0));
}

#[test]
fn claims_and_declarations_are_pool_wide() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    assert_eq!(call(&pool, "mod-a", "claim", &[json!("stat")]), json!(true));
    assert_eq!(call(&pool, "mod-b", "claim", &[json!("stat")]), json!(false));
    assert_eq!(call(&pool, "mod-b", "ownerOf", &[json!("stat.hero.changed")]), json!("mod-a"));

    call(&pool, "mod-a", "declare", &[json!("mod.made")]);
    assert_eq!(call(&pool, "mod-b", "describe", &[json!("mod.made")]), json!("mod.made"));
    pool.declare_event(json!({ "id": "host.made", "description": "declared by the host", "emit": "mods" }))
        .wait()
        .unwrap();
    assert_eq!(call(&pool, "mod-a", "describe", &[json!("host.made")]), json!("host.made"));
    assert_eq!(call(&pool, "mod-b", "describe", &[json!("host.made")]), json!("host.made"));
}

#[test]
fn a_worker_on_its_own_sees_the_same_bus() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-a", "listen", &[json!("a")]);
    call(&pool, "mod-b", "listen", &[json!("b")]);
    let direct = pool.on(WorkerId::Worker(1)).unwrap();
    assert_eq!(direct.emit("note.posted", &[json!("x")]).wait().unwrap(), vec![json!("a:x"), json!("b:x")]);
    assert_eq!(
        direct.execute("events.listenerCount('note.posted')").wait().unwrap().value,
        json!(2)
    );
}

#[test]
fn a_mod_emit_waiting_on_a_stuck_worker_stops_at_its_own_budget() {
    let host = r#"{
        "xript": "0.10", "name": "stuck-host",
        "limits": { "timeout_ms": 300 },
        "bindings": { "block": { "description": "Holds the thread in host code." } },
        "events": [{ "id": "note.posted", "description": "A note was posted.", "emit": "mods" }]
    }"#;
    let config = PoolConfig { workers: 2, interactive: 1, ..PoolConfig::default() };
    let (pool, ready) = XriptPool::spawn(
        host.to_string(),
        |_| {
            let mut bindings = xript_runtime::HostBindings::new();
            bindings.add_function("block", |_: &[Value]| {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                Ok(Value::Null)
            });
            RuntimeOptions { host_bindings: bindings, ..RuntimeOptions::default() }
        },
        config,
    );
    ready.wait().unwrap();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-b", "listen", &[json!("b")]);
    let stuck = pool.on(WorkerId::Worker(1)).unwrap().execute("block()");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let started = std::time::Instant::now();
    let posted = pool.invoke_export("mod-a", "post", &[json!(1)]).wait();
    assert!(
        matches!(posted, Err(xript_runtime::XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
        "got {posted:?}"
    );
    assert!(started.elapsed() < std::time::Duration::from_millis(1200), "the wait outlived its budget");
    stuck.wait().unwrap();
}

#[test]
fn values_reach_a_handler_on_another_worker_as_they_left() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-a", "describeRich", &[json!("local")]);
    call(&pool, "mod-b", "describeRich", &[json!("remote")]);
    call(&pool, "mod-b", "answerRich", &[]);
    assert_eq!(
        call(&pool, "mod-a", "postRich", &[]),
        json!([
            "local|undefined|7|true|true|true|true|2|undefined|function|",
            "remote|undefined|7|true|true|true|true|2|undefined|object|cross-worker",
            "5|undefined|true|true|Infinity|object|cross-worker"
        ])
    );
}

#[test]
fn a_yielding_worker_keeps_working_while_a_host_emit_waits_on_another() {
    let host = r#"{
        "xript": "0.10", "name": "yielding-host",
        "bindings": { "block": { "description": "Holds the thread in host code." } },
        "events": [{ "id": "note.posted", "description": "A note was posted.", "emit": "mods" }]
    }"#;
    let config = PoolConfig { workers: 2, interactive: 1, ..PoolConfig::default() };
    let (pool, ready) = XriptPool::spawn(
        host.to_string(),
        |id| {
            let mut bindings = xript_runtime::HostBindings::new();
            bindings.add_function("block", |_: &[Value]| {
                std::thread::sleep(std::time::Duration::from_millis(400));
                Ok(Value::Null)
            });
            let mode = if id == WorkerId::Worker(0) {
                xript_runtime::RuntimeMode::Async
            } else {
                xript_runtime::RuntimeMode::Sync
            };
            RuntimeOptions { host_bindings: bindings, mode, ..RuntimeOptions::default() }
        },
        config,
    );
    ready.wait().unwrap();
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-a", "listen", &[json!("a")]);
    pool.on(WorkerId::Worker(1))
        .unwrap()
        .execute("events.on('note.posted', function (x) { block(); return 'slow:' + x; })")
        .wait()
        .unwrap();

    let started = std::time::Instant::now();
    let emitted = pool.emit("note.posted", &[json!("x")]);
    std::thread::sleep(std::time::Duration::from_millis(50));
    let meanwhile = pool.on(WorkerId::Worker(0)).unwrap().execute("'free'").wait().unwrap();
    let answered_after = started.elapsed();
    assert_eq!(meanwhile.value, json!("free"));
    assert!(
        answered_after < std::time::Duration::from_millis(300),
        "the yielding worker was held for {answered_after:?} while its emit waited"
    );
    assert_eq!(emitted.wait().unwrap(), vec![json!("a:x"), json!("slow:x")]);
}

/// A pool whose worker 0 yields and whose worker 1 does not, both able to
/// call `block()`, which holds the thread in host code for `block_ms`.
fn mixed_pool(timeout_ms: Option<u64>, block_ms: u64) -> XriptPool {
    let limits = timeout_ms.map(|ms| format!(r#""limits": {{ "timeout_ms": {ms} }},"#)).unwrap_or_default();
    let host = format!(
        r#"{{
        "xript": "0.10", "name": "mixed-host", {limits}
        "bindings": {{ "block": {{ "description": "Holds the thread in host code." }} }},
        "events": [
            {{ "id": "note.posted", "description": "A note was posted.", "emit": "mods" }},
            {{ "id": "note.echoed", "description": "A note was echoed back.", "emit": "mods" }},
            {{ "id": "tick", "description": "The host ticked." }}
        ]
    }}"#
    );
    let config = PoolConfig { workers: 2, interactive: 1, ..PoolConfig::default() };
    let (pool, ready) = XriptPool::spawn(
        host,
        move |id| {
            let mut bindings = xript_runtime::HostBindings::new();
            bindings.add_function("block", move |_: &[Value]| {
                std::thread::sleep(std::time::Duration::from_millis(block_ms));
                Ok(Value::Null)
            });
            let mode = if id == WorkerId::Worker(0) {
                xript_runtime::RuntimeMode::Async
            } else {
                xript_runtime::RuntimeMode::Sync
            };
            RuntimeOptions { host_bindings: bindings, mode, ..RuntimeOptions::default() }
        },
        config,
    );
    ready.wait().unwrap();
    pool
}

#[test]
fn a_yielding_worker_keeps_working_while_a_mod_emit_async_waits_on_another() {
    let pool = mixed_pool(None, 400);
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-a", "listen", &[json!("a")]);
    pool.on(WorkerId::Worker(1))
        .unwrap()
        .execute("events.on('note.posted', function (x) { block(); return 'slow:' + x; })")
        .wait()
        .unwrap();
    call(&pool, "mod-b", "listen", &[json!("b")]);

    let started = std::time::Instant::now();
    let posted = pool.invoke_export("mod-a", "postAsync", &[json!("x")]);
    std::thread::sleep(std::time::Duration::from_millis(50));
    let meanwhile = pool.on(WorkerId::Worker(0)).unwrap().execute("'free'").wait().unwrap();
    let answered_after = started.elapsed();
    assert_eq!(meanwhile.value, json!("free"));
    assert!(
        answered_after < std::time::Duration::from_millis(300),
        "the yielding worker was held for {answered_after:?} while its emitAsync waited"
    );
    assert_eq!(posted.wait().unwrap(), json!(["a:x", "slow:x", "b:x"]));
    assert_eq!(call(&pool, "mod-a", "post", &[json!("y")]), json!(["a:y", "slow:y", "b:y"]));
}

#[test]
fn an_emit_async_answers_like_emit_across_a_yielding_pool() {
    let pool = mixed_pool(None, 0);
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-b", "relay", &[json!("b")]);
    call(&pool, "mod-a", "listen", &[json!("a"), json!("note.echoed")]);
    call(&pool, "mod-b", "listen", &[json!("b"), json!("note.echoed")]);
    call(&pool, "mod-a", "listen", &[json!("a")]);
    call(&pool, "mod-b", "listenOnce", &[json!("b")]);
    assert_eq!(
        call(&pool, "mod-a", "postAsync", &[json!("hi")]),
        json!(["a:hi+b:hi", "a:hi", "b-once:hi"]),
        "a handler on the other worker emitting back into the parked one is served"
    );
    assert_eq!(call(&pool, "mod-a", "post", &[json!("hi")]), json!(["a:hi+b:hi", "a:hi"]));
    let from_sync_worker = pool
        .on(WorkerId::Worker(1))
        .unwrap()
        .execute("events.emitAsync('note.posted', 'yo')")
        .wait()
        .unwrap();
    assert_eq!(from_sync_worker.value, json!(["a:yo+b:yo", "a:yo"]));
    let refused = pool
        .on(WorkerId::Worker(0))
        .unwrap()
        .execute(
            "events.emitAsync('tick').then(function () { return 'resolved'; }, function (e) { return e.name + ':' + e.binding; })",
        )
        .wait()
        .unwrap();
    assert_eq!(refused.value, json!("BindingError:events.emitAsync"));
}

#[test]
fn a_mod_emit_async_waiting_on_a_stuck_worker_stops_at_its_own_budget() {
    let pool = mixed_pool(Some(300), 1500);
    load(&pool, "mod-a", 0);
    load(&pool, "mod-b", 1);
    call(&pool, "mod-b", "listen", &[json!("b")]);
    let stuck = pool.on(WorkerId::Worker(1)).unwrap().execute("block()");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let started = std::time::Instant::now();
    let posted = pool.invoke_export("mod-a", "postAsync", &[json!(1)]).wait();
    assert!(
        matches!(posted, Err(xript_runtime::XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
        "got {posted:?}"
    );
    assert!(started.elapsed() < std::time::Duration::from_millis(1200), "the wait outlived its budget");
    stuck.wait().unwrap();
}

#[test]
fn an_event_nobody_hears_answers_empty() {
    let pool = pool();
    load(&pool, "mod-a", 0);
    assert_eq!(pool.emit("tick", &[]).wait().unwrap(), Vec::<Value>::new());
    assert_eq!(pool.emit("not.declared", &[]).wait().unwrap(), Vec::<Value>::new());
}
