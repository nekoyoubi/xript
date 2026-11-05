use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, HostBindings, HostFn, RuntimeMode, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/binding-error-tests.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("corpus parses")
}

fn bindings() -> HostBindings {
    let mut bindings = HostBindings::new();
    bindings.add_function("boom", |_: &[Value]| Err("boom".to_string()));
    bindings.add_function("prefixed", |_: &[Value]| Err("prefixed(): already".to_string()));
    bindings.add_function("gated", |_: &[Value]| Ok(json!(1)));
    bindings.add_function("takesFn", |_: &[Value]| Ok(json!(1)));
    bindings.add_function("deep", |_: &[Value]| Ok(json!(1)));
    let inner: HostFn = Arc::new(|_: &[Value]| Err("inner fail".to_string()));
    bindings.add_namespace("nested", HashMap::from([("inner".to_string(), inner)]));
    bindings.add_async_function("later", |_: &[Value]| async { Err::<Value, String>("nope".to_string()) });
    bindings
}

/// Compares the fields `expected` names, numbers by value and
/// `messageStartsWith` as a prefix.
fn matches(actual: &Value, expected: &Value) -> Result<(), String> {
    let Some(fields) = expected.as_object() else {
        let same = match (actual, expected) {
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y || x.as_f64().is_some() && x.as_f64() == y.as_f64())
            }
            _ => actual == expected,
        };
        return if same { Ok(()) } else { Err(format!("got {actual}, expected {expected}")) };
    };
    for (field, want) in fields {
        let ok = match field.as_str() {
            "messageStartsWith" => actual["message"].as_str().is_some_and(|m| m.starts_with(want.as_str().unwrap_or_default())),
            _ => &actual[field] == want,
        };
        if !ok {
            return Err(format!("{field}: got {actual}, expected {want}"));
        }
    }
    Ok(())
}

fn run_corpus(mode: RuntimeMode) {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap_or_default();
        let rt = create_runtime_from_value(
            corpus["manifest"].clone(),
            RuntimeOptions { host_bindings: bindings(), mode, ..Default::default() },
        )
        .expect("host manifest loads");
        rt.execute(corpus["setup"].as_str().unwrap()).expect("setup runs");
        let script = case["script"].as_str().unwrap();
        let result = if case["async"].as_bool() == Some(true) {
            pollster::block_on(rt.execute_async(script))
        } else {
            rt.execute(script)
        };
        match result {
            Ok(result) => {
                if let Err(failure) = matches(&result.value, &case["expected"]) {
                    failures.push(format!("{name}: {failure}"));
                }
            }
            Err(error) => failures.push(format!("{name}: script failed: {error}")),
        }
    }
    assert!(failures.is_empty(), "{} case(s) failed ({mode:?}):\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn binding_error_corpus_sync_mode() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn binding_error_corpus_async_mode() {
    run_corpus(RuntimeMode::Async);
}
