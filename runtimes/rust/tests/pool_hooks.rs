//! A pool fires a hook at every handler registered for it, whenever and on
//! whichever worker it was registered, and merges the results into the order
//! one runtime would give: handlers in registration order, then hook fills.

#![cfg(feature = "threads")]

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use xript_runtime::{create_runtime, HookDispatch, PoolConfig, RuntimeOptions, WorkerId, XriptPool};

const HOST: &str = r#"{
    "xript": "0.10",
    "name": "pool-hooks-host",
    "hooks": { "save": { "description": "A save.", "phases": ["pre"] } },
    "slots": [{ "id": "tick", "accepts": ["application/x-xript-hook"], "description": "A tick mods fill." }]
}"#;

const MOD_SOURCE: &str = r#"
xript.exports.register('on', function (tag) {
    hooks.tick(function (x) { return tag + ':' + x; });
    return true;
});
xript.exports.register('onSave', function (tag) {
    hooks.save.pre(function (x) { return tag + ':pre:' + x; });
    return true;
});
xript.exports.register('fill', function (x) { return 'fill:' + x; });
"#;

fn mod_manifest(name: &str, fills: bool) -> String {
    let mut manifest = json!({
        "xript": "0.10", "name": name, "version": "1.0.0",
        "entry": { "script": "mod.js", "exports": {
            "on": { "description": "registers a tick handler" },
            "onSave": { "description": "registers a save handler" },
            "fill": { "description": "fills tick" }
        } }
    });
    if fills {
        manifest["fills"] = json!({ "tick": [{ "handler": "fill" }] });
    }
    manifest.to_string()
}

fn sources() -> HashMap<String, String> {
    HashMap::from([("mod.js".to_string(), MOD_SOURCE.to_string())])
}

/// The script every scenario runs, as `(mod, export, tag)` steps after loading
/// `mod-a` (with a fill) and then `mod-b`.
const STEPS: &[(&str, &str, &str)] = &[
    ("mod-b", "on", "b1"),
    ("mod-a", "on", "a1"),
    ("mod-b", "on", "b2"),
    ("mod-a", "onSave", "a"),
    ("mod-b", "onSave", "b"),
    ("mod-a", "on", "a2"),
];

fn single_runtime_results() -> (Vec<Value>, Vec<Value>) {
    let rt = create_runtime(HOST, RuntimeOptions::default()).unwrap();
    rt.load_mod(&mod_manifest("mod-a", true), sources(), &HashSet::new(), None).unwrap();
    rt.load_mod(&mod_manifest("mod-b", false), sources(), &HashSet::new(), None).unwrap();
    for (mod_id, export, tag) in STEPS {
        rt.invoke_mod_export(mod_id, export, &[json!(tag)]).unwrap();
    }
    rt.execute("hooks.tick(function (x) { return 'host:' + x; })").unwrap();
    (
        rt.fire_hook("tick", &[json!(1)]).unwrap(),
        rt.fire_hook_phase("save", "pre", Some(&json!(2))).unwrap(),
    )
}

fn pool_results(dispatch: HookDispatch) -> (Vec<Value>, Vec<Value>) {
    let config = PoolConfig { workers: 2, interactive: 1, hook_dispatch: dispatch, ..PoolConfig::default() };
    let (pool, ready) = XriptPool::spawn(HOST.to_string(), |_| RuntimeOptions::default(), config);
    ready.wait().unwrap();
    pool.load_mod_on(WorkerId::Worker(0), &mod_manifest("mod-a", true), sources(), &HashSet::new(), None)
        .wait()
        .unwrap();
    pool.load_mod_on(WorkerId::Worker(1), &mod_manifest("mod-b", false), sources(), &HashSet::new(), None)
        .wait()
        .unwrap();
    for (mod_id, export, tag) in STEPS {
        pool.invoke_export(mod_id, export, &[json!(tag)]).wait().unwrap();
    }
    pool.on(WorkerId::Worker(1))
        .unwrap()
        .execute("hooks.tick(function (x) { return 'host:' + x; })")
        .wait()
        .unwrap();
    (
        pool.fire_hook("tick", &[json!(1)]).wait().unwrap(),
        pool.fire_hook_phase("save", "pre", Some(&json!(2))).wait().unwrap(),
    )
}

#[test]
fn handlers_registered_after_load_are_reached_in_registration_order() {
    let (tick, save) = single_runtime_results();
    assert_eq!(tick, vec![json!("b1:1"), json!("a1:1"), json!("b2:1"), json!("a2:1"), json!("host:1"), json!("fill:1")]);
    assert_eq!(save, vec![json!("a:pre:2"), json!("b:pre:2")]);
    for dispatch in [HookDispatch::Concurrent, HookDispatch::Sequential] {
        assert_eq!(pool_results(dispatch), (tick.clone(), save.clone()), "{dispatch:?}");
    }
}
