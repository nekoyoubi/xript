//! With value fidelity on, a script number with an integral value reaches the
//! host as an integer whichever path produced it: a literal, arithmetic on a
//! host binding's return, a nested value, a hook result. With it off, a number
//! computed from a binding's return keeps arriving as a float.

use xript_runtime::{create_runtime, HostBindings, RuntimeOptions};

const MANIFEST: &str = r#"{
    "xript": "0.10",
    "name": "numbers",
    "bindings": {
        "util": {
            "description": "utilities",
            "members": {
                "clamp": { "description": "clamps a value" },
                "half": { "description": "halves a value" }
            }
        }
    },
    "hooks": { "tick": { "description": "a tick" } }
}"#;

fn runtime(value_fidelity: bool) -> xript_runtime::XriptRuntime {
    let mut bindings = HostBindings::new();
    bindings
        .namespace("util")
        .bind_sync("clamp", |args: &[serde_json::Value]| {
            let v = args[0].as_f64().unwrap_or(0.0);
            let lo = args[1].as_f64().unwrap_or(0.0);
            let hi = args[2].as_f64().unwrap_or(0.0);
            Ok(serde_json::json!(v.clamp(lo, hi)))
        })
        .bind_sync("half", |args: &[serde_json::Value]| {
            Ok(serde_json::json!(args[0].as_f64().unwrap_or(0.0) / 2.0))
        })
        .finish();
    create_runtime(
        MANIFEST,
        RuntimeOptions { host_bindings: bindings, value_fidelity, ..Default::default() },
    )
    .unwrap()
}

#[test]
fn an_integral_binding_result_matches_a_literal() {
    let rt = runtime(true);
    let via_binding = rt.execute("util.clamp(15, 0, 10)").unwrap().value;
    let literal = rt.execute("10").unwrap().value;
    assert_eq!(via_binding, literal);
    assert!(via_binding.is_i64());
    assert_eq!(rt.execute("({ n: util.clamp(15, 0, 10) })").unwrap().value, serde_json::json!({ "n": 10 }));
}

#[test]
fn a_fractional_result_stays_a_float() {
    let rt = runtime(true);
    assert_eq!(rt.execute("util.half(5)").unwrap().value, serde_json::json!(2.5));
    assert_eq!(rt.execute("util.half(4)").unwrap().value, serde_json::json!(2));
}

#[test]
fn a_hook_result_is_integral_too() {
    let rt = runtime(true);
    rt.execute("hooks.tick(function () { return util.clamp(99, 0, 3); });").unwrap();
    assert_eq!(rt.fire_hook("tick", &[]).unwrap(), vec![serde_json::json!(3)]);
}

#[test]
fn without_fidelity_a_computed_integral_stays_a_float() {
    let rt = runtime(false);
    let value = rt.execute("util.clamp(15, 0, 10)").unwrap().value;
    assert!(value.is_f64());
    assert_eq!(value.as_f64(), Some(10.0));
}
