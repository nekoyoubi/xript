//! A hook or event slot that declares its own `limits.timeout_ms` fires under
//! that budget, fresh per fire and shared by the fire's handlers, clamped by
//! the embedder's hard limit.

use std::collections::{HashMap, HashSet};

use xript_runtime::{create_runtime, HardLimits, RuntimeOptions, XriptError, XriptRuntime};

fn host_manifest(manifest_ms: u64, hook_ms: u64) -> String {
    format!(
        r#"{{
        "xript": "0.10",
        "name": "hook-limits-host",
        "limits": {{ "timeout_ms": {manifest_ms} }},
        "hooks": {{
            "bounded": {{ "description": "fires under its own budget", "limits": {{ "timeout_ms": {hook_ms} }} }},
            "inherited": {{ "description": "fires under the manifest budget" }}
        }},
        "slots": [
            {{
                "id": "on-bounded",
                "accepts": ["application/x-xript-hook"],
                "description": "an event slot with its own budget",
                "limits": {{ "timeout_ms": {hook_ms} }}
            }}
        ]
    }}"#
    )
}

/// Registers a handler on every hook that spins for `spin_ms` of wall clock.
fn spinner(spin_ms: u64) -> String {
    format!(
        "function spin() {{ var end = Date.now() + {spin_ms}; while (Date.now() < end) {{}} return 'finished'; }} \
         hooks.bounded(spin); hooks.inherited(spin); hooks['on-bounded'](spin);"
    )
}

fn runtime(manifest_ms: u64, hook_ms: u64, hard: Option<u64>) -> XriptRuntime {
    create_runtime(
        &host_manifest(manifest_ms, hook_ms),
        RuntimeOptions {
            hard_limits: hard.map(|timeout_ms| HardLimits { timeout_ms: Some(timeout_ms), ..Default::default() }),
            ..Default::default()
        },
    )
    .unwrap()
}

fn is_timeout(result: &Result<Vec<serde_json::Value>, XriptError>) -> bool {
    matches!(result, Err(XriptError::ExecutionLimit { limit }) if limit == "timeout_ms")
}

#[test]
fn a_hook_tightens_its_fire_below_the_manifest_budget() {
    let rt = runtime(10_000, 50, None);
    rt.execute(&spinner(3_000)).unwrap();
    let result = rt.fire_hook("bounded", &[]);
    assert!(is_timeout(&result), "the hook's 50ms budget should stop a 3s handler; got {result:?}");
}

#[test]
fn a_hook_widens_its_fire_past_the_manifest_budget() {
    let rt = runtime(50, 10_000, None);
    rt.execute(&spinner(300)).unwrap();
    assert_eq!(rt.fire_hook("bounded", &[]).unwrap(), vec![serde_json::json!("finished")]);
}

#[test]
fn a_hook_without_limits_fires_under_the_manifest_budget() {
    let rt = runtime(50, 10_000, None);
    rt.execute(&spinner(300)).unwrap();
    let result = rt.fire_hook("inherited", &[]);
    assert!(is_timeout(&result), "a hook declaring nothing inherits the manifest's 50ms; got {result:?}");
}

#[test]
fn an_event_slot_fires_under_its_own_budget() {
    let rt = runtime(50, 10_000, None);
    rt.execute(&spinner(300)).unwrap();
    assert_eq!(rt.fire_hook("on-bounded", &[]).unwrap(), vec![serde_json::json!("finished")]);

    let tight = runtime(10_000, 50, None);
    tight.execute(&spinner(3_000)).unwrap();
    let result = tight.fire_hook("on-bounded", &[]);
    assert!(is_timeout(&result), "the slot's 50ms budget should stop a 3s handler; got {result:?}");
}

#[test]
fn the_hard_limit_clamps_a_widening_hook() {
    let rt = runtime(50, 10_000, Some(100));
    rt.execute(&spinner(3_000)).unwrap();
    let result = rt.fire_hook("bounded", &[]);
    assert!(is_timeout(&result), "a hook must not buy more than the embedder allows; got {result:?}");
}

#[test]
fn the_budget_is_fresh_per_fire() {
    let rt = runtime(10_000, 400, None);
    rt.execute(&spinner(250)).unwrap();
    for _ in 0..3 {
        assert_eq!(rt.fire_hook("bounded", &[]).unwrap(), vec![serde_json::json!("finished")]);
    }
}

#[test]
fn an_event_slots_fills_run_under_its_budget() {
    let filler = r#"{
        "xript": "0.10", "name": "filler", "version": "1.0.0",
        "entry": { "script": "mod.js", "exports": { "spin": { "description": "spins" } } },
        "fills": { "on-bounded": [{ "handler": "spin" }] }
    }"#;
    let source = "xript.exports.register('spin', function () { var end = Date.now() + 300; while (Date.now() < end) {} return 'filled'; });";
    let rt = runtime(50, 10_000, None);
    rt.load_mod(filler, HashMap::from([("mod.js".to_string(), source.to_string())]), &HashSet::new(), None)
        .unwrap();
    assert_eq!(rt.fire_hook("on-bounded", &[]).unwrap(), vec![serde_json::json!("filled")]);
}
