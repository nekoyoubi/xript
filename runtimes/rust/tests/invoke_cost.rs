//! What one host-to-script call costs: an export invoked, a hook fired, an
//! event emitted, a retained callback called, each from a tight loop on the
//! host side. Ignored by default; run it in release:
//!
//! ```sh
//! cargo test --release --test invoke_cost -- --ignored --nocapture
//! ```

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, Callback, HostBindings, RetainedCallback, RuntimeMode, RuntimeOptions, XriptRuntime};

const ITERATIONS: u32 = 20_000;
const ROUNDS: usize = 5;

const MOD_MANIFEST: &str = r#"{
    "xript": "0.10", "name": "bench-mod", "version": "1.0.0",
    "entry": { "script": "bench.js", "format": "script", "exports": {
        "modEcho": { "description": "Returns its argument." }
    }}
}"#;

const MOD_SOURCE: &str = "xript.exports.register('modEcho', function (x) { return x; });";

struct Bench {
    rt: XriptRuntime,
    kept: Arc<Mutex<Vec<RetainedCallback>>>,
}

fn bench(mode: RuntimeMode, fidelity: bool) -> Bench {
    let kept: Arc<Mutex<Vec<RetainedCallback>>> = Arc::new(Mutex::new(Vec::new()));
    let keep_into = kept.clone();
    let mut bindings = HostBindings::new();
    bindings.add_function("keep", move |args: &[Value]| {
        let retained = args.first().and_then(Callback::from_value).ok_or("no callback")?.retain()?;
        keep_into.lock().unwrap().push(retained);
        Ok(Value::Null)
    });
    let rt = create_runtime_from_value(
        json!({
            "xript": "0.10",
            "name": "invoke-cost",
            "limits": { "timeout_ms": 600000 },
            "bindings": {
                "keep": {
                    "description": "Retains a callback.",
                    "params": [{ "name": "fn", "type": "function", "retain": true }]
                }
            },
            "hooks": {
                "one": { "description": "One handler." },
                "five": { "description": "Five handlers." }
            },
            "events": [{ "id": "ping", "description": "One subscriber." }]
        }),
        RuntimeOptions { host_bindings: bindings, value_fidelity: fidelity, mode, ..Default::default() },
    )
    .expect("runtime builds");
    rt.execute(
        "xript.exports.register('echo', function (x) { return x; });
         xript.exports.register('constant', function () { return 1; });
         hooks.one(function (x) { return x; });
         for (var i = 0; i < 5; i++) hooks.five(function (x) { return x; });
         events.on('ping', function (x) { return x; });
         keep(function (x) { return x; });",
    )
    .expect("setup runs");
    rt.load_mod(MOD_MANIFEST, HashMap::new(), &HashSet::new(), Some(MOD_SOURCE))
        .expect("mod loads");
    Bench { rt, kept }
}

/// Microseconds per call of `body`, best of [`ROUNDS`].
fn measure(mut body: impl FnMut(u32)) -> f64 {
    for i in 0..ITERATIONS / 10 {
        body(i);
    }
    (0..ROUNDS)
        .map(|_| {
            let start = Instant::now();
            for i in 0..ITERATIONS {
                body(i);
            }
            start.elapsed().as_nanos() as f64 / ITERATIONS as f64 / 1000.0
        })
        .fold(f64::INFINITY, f64::min)
}

#[test]
#[ignore = "a benchmark; run with --ignored in release"]
fn invoke_cost() {
    let small = json!({ "x": 1, "y": 2 });
    for (mode, fidelity) in [(RuntimeMode::Sync, false), (RuntimeMode::Sync, true), (RuntimeMode::Async, false), (RuntimeMode::Async, true)] {
        let Bench { rt, kept } = bench(mode, fidelity);
        let retained = kept.lock().unwrap()[0].clone();
        assert_eq!(rt.invoke_export("echo", &[json!(7)]).unwrap(), json!(7));
        assert_eq!(rt.invoke_mod_export("bench-mod", "modEcho", &[json!(7)]).unwrap(), json!(7));
        assert_eq!(rt.fire_hook("five", &[json!(7)]).unwrap().len(), 5);
        assert_eq!(rt.emit("ping", &[json!(7)]).unwrap(), vec![json!(7)]);
        assert_eq!(retained.call(&[json!(7)]).unwrap().as_f64(), Some(7.0));

        let cases: Vec<(&str, f64)> = vec![
            ("invoke_export echo(i)", measure(|i| {
                rt.invoke_export("echo", &[json!(i)]).unwrap();
            })),
            ("invoke_export constant()", measure(|_| {
                rt.invoke_export("constant", &[]).unwrap();
            })),
            ("invoke_mod_export modEcho(i)", measure(|i| {
                rt.invoke_mod_export("bench-mod", "modEcho", &[json!(i)]).unwrap();
            })),
            ("fire_hook one, no args", measure(|_| {
                rt.fire_hook("one", &[]).unwrap();
            })),
            ("fire_hook one, (i)", measure(|i| {
                rt.fire_hook("one", &[json!(i)]).unwrap();
            })),
            ("fire_hook one, ({x,y})", measure(|_| {
                rt.fire_hook("one", std::slice::from_ref(&small)).unwrap();
            })),
            ("fire_hook five, (i)", measure(|i| {
                rt.fire_hook("five", &[json!(i)]).unwrap();
            })),
            ("emit ping, (i)", measure(|i| {
                rt.emit("ping", &[json!(i)]).unwrap();
            })),
            ("retained callback (i)", measure(|i| {
                retained.call(&[json!(i)]).unwrap();
            })),
        ];
        println!("{mode:?}, value_fidelity = {fidelity}");
        for (label, us) in cases {
            println!("  {label:<34} {us:>8.3} us");
        }
    }
}
