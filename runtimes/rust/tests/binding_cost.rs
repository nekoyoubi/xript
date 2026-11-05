//! What one sync host-binding call costs, measured as a tight loop inside one
//! `execute`. Ignored by default; run it in release:
//!
//! ```sh
//! cargo test --release --test binding_cost -- --ignored --nocapture
//! ```

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, HostBindings, HostFn, RuntimeOptions, XriptRuntime};

const ITERATIONS: u64 = 200_000;
const ROUNDS: usize = 5;

fn runtime(fidelity: bool) -> XriptRuntime {
    let mut bindings = HostBindings::new();
    bindings.add_function("nop", |_: &[Value]| Ok(Value::Null));
    bindings.add_function("one", |_: &[Value]| Ok(json!(1)));
    let mut members: HashMap<String, HostFn> = HashMap::new();
    members.insert("nop".into(), Arc::new(|_: &[Value]| Ok(Value::Null)));
    bindings.add_namespace("ns", members);
    create_runtime_from_value(
        json!({
            "xript": "0.10",
            "name": "binding-cost",
            "limits": { "timeout_ms": 600000 },
            "bindings": {
                "nop": { "description": "Does nothing." },
                "one": { "description": "Returns 1." },
                "ns": { "description": "A namespace.", "members": { "nop": { "description": "Does nothing." } } }
            }
        }),
        RuntimeOptions { host_bindings: bindings, value_fidelity: fidelity, ..Default::default() },
    )
    .expect("runtime builds")
}

/// Nanoseconds per iteration of `body`, best of [`ROUNDS`].
fn measure(rt: &XriptRuntime, body: &str) -> f64 {
    let script = format!("(function () {{ var held = {{ position: {{ x: 1, y: 2 }}, velocity: {{ x: 0, y: 0 }}, maxSpeed: 5 }}; var s = 0; for (var i = 0; i < {ITERATIONS}; i++) {{ {body} }} return s; }})()");
    rt.execute(&script).expect("warm-up runs");
    (0..ROUNDS)
        .map(|_| {
            let start = Instant::now();
            rt.execute(&script).expect("loop runs");
            start.elapsed().as_nanos() as f64 / ITERATIONS as f64
        })
        .fold(f64::INFINITY, f64::min)
}

const CASES: &[(&str, &str)] = &[
    ("pure JS Math.min(Math.max(i,0),10)", "s += Math.min(Math.max(i, 0), 10);"),
    ("nop(i)", "nop(i);"),
    ("ns.nop(i)", "ns.nop(i);"),
    ("nop(i, 2, 3)", "nop(i, 2, 3);"),
    ("nop('hello')", "nop('hello');"),
    ("nop({position,velocity,maxSpeed})", "nop({ position: { x: 1, y: 2 }, velocity: { x: 0, y: 0 }, maxSpeed: 5 });"),
    ("one() returning 1", "s += one();"),
    ("nop(held object)", "nop(held);"),
    ("pure JS JSON.stringify(held object)", "JSON.stringify(held);"),
];

#[test]
#[ignore = "a benchmark; run with --ignored in release"]
fn binding_cost() {
    for fidelity in [false, true] {
        let rt = runtime(fidelity);
        println!("value_fidelity = {fidelity}");
        for (label, body) in CASES {
            println!("  {label:<40} {:>8.3} us", measure(&rt, body) / 1000.0);
        }
    }
}
