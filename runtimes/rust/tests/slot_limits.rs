use std::collections::{HashMap, HashSet};

use xript_runtime::{create_runtime, HardLimits, RuntimeOptions, XriptError};

/// A host whose manifest budget is generous, with two command slots that
/// disagree with it in opposite directions: one tightens well below it, one
/// says nothing and inherits it.
fn host_manifest(manifest_timeout_ms: u64, slot_timeout_ms: u64) -> String {
    format!(
        r#"{{
        "xript": "0.8",
        "name": "limits-host",
        "limits": {{ "timeout_ms": {manifest_timeout_ms} }},
        "slots": [
            {{
                "id": "bounded.commands",
                "accepts": ["application/x-xript-command"],
                "description": "fills here run under the slot's own budget",
                "multiple": true,
                "limits": {{ "timeout_ms": {slot_timeout_ms} }}
            }},
            {{
                "id": "inherited.commands",
                "accepts": ["application/x-xript-command"],
                "description": "fills here inherit the manifest budget",
                "multiple": true
            }}
        ]
    }}"#
    )
}

const SPINNER: &str = r#"{
    "xript": "0.8", "name": "spinner", "version": "1.0.0",
    "entry": { "path": "main.js", "format": "module", "exports": {
        "spin": { "description": "burns wall clock" },
        "quick": { "description": "returns at once" }
    }},
    "fills": {
        "bounded.commands": [
            { "id": "bounded.spin", "title": "Spin", "handler": "spin" },
            { "id": "bounded.quick", "title": "Quick", "handler": "quick" }
        ],
        "inherited.commands": [
            { "id": "inherited.spin", "title": "Spin", "handler": "spin" }
        ]
    }
}"#;

/// `spin` busies the interpreter for longer than any budget under test, so
/// whether it returns is decided entirely by the deadline in force.
const SPINNER_SOURCE: &str = r#"
export function spin() {
    var end = Date.now() + 3000;
    while (Date.now() < end) {}
    return "finished";
}
export function quick() {
    return "quick";
}
"#;

fn runtime(manifest_timeout_ms: u64, slot_timeout_ms: u64, hard: Option<u64>) -> xript_runtime::XriptRuntime {
    let rt = create_runtime(
        &host_manifest(manifest_timeout_ms, slot_timeout_ms),
        RuntimeOptions {
            hard_limits: hard.map(|timeout_ms| HardLimits {
                timeout_ms: Some(timeout_ms),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .unwrap();
    rt.load_mod(SPINNER, HashMap::new(), &HashSet::new(), Some(SPINNER_SOURCE))
        .unwrap();
    rt
}

fn invoke(rt: &xript_runtime::XriptRuntime, reference: &str) -> Result<serde_json::Value, XriptError> {
    let command = rt.resolve_command(reference).expect("command resolves");
    rt.invoke_command(&command, None)
}

#[test]
fn a_slot_can_tighten_below_the_manifest_budget() {
    let rt = runtime(10_000, 50, None);
    let result = invoke(&rt, "bounded.spin");
    assert!(
        matches!(result, Err(XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
        "the slot's 50ms budget should have stopped a 3s spin; got {result:?}"
    );
}

#[test]
fn a_slot_can_widen_past_the_manifest_budget() {
    // The manifest would stop this at 50ms; the slot says these fills run long.
    let rt = runtime(50, 10_000, None);
    let result = invoke(&rt, "bounded.spin");
    assert_eq!(
        result.expect("the slot's 10s budget should have let a 3s spin finish"),
        serde_json::json!("finished")
    );
}

#[test]
fn a_slot_without_limits_inherits_the_manifest_budget() {
    let rt = runtime(50, 10_000, None);
    let result = invoke(&rt, "inherited.spin");
    assert!(
        matches!(result, Err(XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
        "a slot declaring no limits must not pick up a neighbouring slot's; got {result:?}"
    );
}

#[test]
fn the_embedders_hard_ceiling_still_clamps_a_widening_slot() {
    // The host embedding the runtime allows 100ms; the manifest asks for 10s.
    let rt = runtime(50, 10_000, Some(100));
    let result = invoke(&rt, "bounded.spin");
    assert!(
        matches!(result, Err(XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
        "a manifest must not buy itself more budget than the embedder allowed; got {result:?}"
    );
}

#[test]
fn a_tightened_slot_does_not_disturb_a_call_that_fits() {
    let rt = runtime(10_000, 50, None);
    assert_eq!(
        invoke(&rt, "bounded.quick").expect("a fast fill fits inside a tight budget"),
        serde_json::json!("quick")
    );
}
