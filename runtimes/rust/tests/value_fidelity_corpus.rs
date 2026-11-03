//! Conformance against the shared value-fidelity corpus in `spec/`, with
//! `value_fidelity` on: `undefined`, `NaN` and the infinities cross the host
//! boundary as markers and arrive in script as themselves.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use xript_runtime::{create_runtime_from_value, HostBindings, RuntimeOptions, XriptRuntime};

const CORPUS: &str = include_str!("../../../spec/value-fidelity-tests.json");

#[derive(Deserialize)]
struct Corpus {
    manifest: serde_json::Value,
    inbound: Vec<Inbound>,
    echo: Vec<Echo>,
    results: Vec<ResultCase>,
    hook: Vec<HookCase>,
    event: Vec<HookCase>,
    #[serde(rename = "eventResult")]
    event_result: Vec<EventResult>,
}

#[derive(Deserialize)]
struct EventResult {
    name: String,
    returns: String,
    expected: serde_json::Value,
}

#[derive(Deserialize)]
struct Inbound {
    name: String,
    #[serde(rename = "hostValue")]
    host_value: serde_json::Value,
    probe: String,
    expected: String,
}

#[derive(Deserialize)]
struct Echo {
    name: String,
    script: String,
    received: Vec<serde_json::Value>,
    expected: String,
}

#[derive(Deserialize)]
struct ResultCase {
    name: String,
    script: String,
    expected: serde_json::Value,
}

#[derive(Deserialize)]
struct HookCase {
    name: String,
    data: serde_json::Value,
    expected: String,
}

fn corpus() -> Corpus {
    serde_json::from_str(CORPUS).expect("corpus parses")
}

fn runtime(
    manifest: &serde_json::Value,
    host_value: serde_json::Value,
    received: Arc<Mutex<Vec<serde_json::Value>>>,
) -> XriptRuntime {
    let mut bindings = HostBindings::new();
    bindings.add_function("value", move |_: &[serde_json::Value]| Ok(host_value.clone()));
    bindings.add_function("echo", move |args: &[serde_json::Value]| {
        *received.lock().unwrap() = args.to_vec();
        Ok(serde_json::Value::Array(args.to_vec()))
    });
    create_runtime_from_value(
        manifest.clone(),
        RuntimeOptions { host_bindings: bindings, value_fidelity: true, ..Default::default() },
    )
    .expect("runtime builds")
}

#[test]
fn inbound_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.inbound {
        let rt = runtime(&corpus.manifest, case.host_value, Arc::default());
        let script = format!("(function () {{ var v = value(); return ({}); }})()", case.probe);
        match rt.execute(&script) {
            Ok(result) if result.value == serde_json::json!(case.expected) => {}
            Ok(result) => failures.push(format!("{}: expected {:?}, got {}", case.name, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "inbound failures:\n{}", failures.join("\n"));
}

#[test]
fn echo_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.echo {
        let received = Arc::new(Mutex::new(Vec::new()));
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, received.clone());
        match rt.execute(&case.script) {
            Ok(result) if result.value == serde_json::json!(case.expected) => {}
            Ok(result) => failures.push(format!("{}: expected {:?}, got {}", case.name, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
        let got = received.lock().unwrap().clone();
        if got != case.received {
            failures.push(format!("{}: host received {:?}, expected {:?}", case.name, got, case.received));
        }
    }
    assert!(failures.is_empty(), "echo failures:\n{}", failures.join("\n"));
}

#[test]
fn result_cases() {
    let corpus = corpus();
    let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
    let mut failures = Vec::new();
    for case in corpus.results {
        match rt.execute(&case.script) {
            Ok(result) if result.value == case.expected => {}
            Ok(result) => failures.push(format!("{}: expected {}, got {}", case.name, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "result failures:\n{}", failures.join("\n"));
}

#[test]
fn hook_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.hook {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
        rt.execute(
            "hooks.probe(function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })",
        )
        .expect("handler registers");
        match rt.fire_hook("probe", &[case.data]) {
            Ok(results) if results == vec![serde_json::json!(case.expected)] => {}
            Ok(results) => failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, results)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "hook failures:\n{}", failures.join("\n"));
}

#[test]
fn event_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.event {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
        rt.execute(
            "events.on('probed', function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })",
        )
        .expect("subscriber registers");
        match rt.emit("probed", &[case.data]) {
            Ok(results) if results == vec![serde_json::json!(case.expected)] => {}
            Ok(results) => failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, results)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    for case in corpus.event_result {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
        rt.execute(&format!("events.on('probed', function () {{ return {}; }})", case.returns))
            .expect("subscriber registers");
        match rt.emit("probed", &[]) {
            Ok(results) if results == vec![case.expected.clone()] => {}
            Ok(results) => failures.push(format!("{}: expected {}, got {:?}", case.name, case.expected, results)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "event failures:\n{}", failures.join("\n"));
}

#[test]
fn negative_zero_crosses_at_any_depth() {
    let corpus = corpus();
    let received = Arc::new(Mutex::new(Vec::new()));
    let rt = runtime(&corpus.manifest, serde_json::Value::Null, received.clone());
    let result = rt
        .execute("(function () { var r = echo({ z: -0, list: [-0, 1] }); return [Object.is(r[0].z, -0), Object.is(r[0].list[0], -0)].join('|'); })()")
        .unwrap();
    assert_eq!(result.value, serde_json::json!("true|true"));
    let neg_zero = xript_runtime::special::neg_zero();
    assert_eq!(
        *received.lock().unwrap(),
        vec![serde_json::json!({ "z": neg_zero.clone(), "list": [neg_zero.clone(), 1] })]
    );
    assert_eq!(rt.execute("({ z: -0 })").unwrap().value, serde_json::json!({ "z": neg_zero }));
}

#[test]
fn without_fidelity_specials_are_null() {
    let corpus = corpus();
    let mut bindings = HostBindings::new();
    let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = received.clone();
    bindings.add_function("value", |_: &[serde_json::Value]| Ok(serde_json::json!({ "$xript": "NaN" })));
    bindings.add_function("echo", move |args: &[serde_json::Value]| {
        *sink.lock().unwrap() = args.to_vec();
        Ok(serde_json::Value::Null)
    });
    let rt = create_runtime_from_value(
        corpus.manifest,
        RuntimeOptions { host_bindings: bindings, ..Default::default() },
    )
    .unwrap();
    assert_eq!(rt.execute("undefined").unwrap().value, serde_json::Value::Null);
    assert_eq!(rt.execute("0 / 0").unwrap().value, serde_json::Value::Null);
    rt.execute("echo(Infinity, undefined, 1)").unwrap();
    assert_eq!(*received.lock().unwrap(), vec![serde_json::Value::Null, serde_json::Value::Null, serde_json::json!(1)]);
    assert_eq!(rt.execute("typeof value()").unwrap().value, serde_json::json!("object"));
    let negative_zero = rt.execute("-0").unwrap().value;
    assert!(negative_zero.as_f64().is_some_and(|n| n == 0.0 && n.is_sign_negative()), "got {negative_zero:?}");
    rt.execute("echo(-0)").unwrap();
    assert_eq!(*received.lock().unwrap(), vec![serde_json::json!(0)]);
}
