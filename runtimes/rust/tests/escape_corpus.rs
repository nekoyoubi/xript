//! Every constructor chain a script can walk ends at a `Function` that refuses
//! to compile a string, checked against the shared escape corpus.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, Callback, HostBindings, HostFn, RuntimeMode, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/escape-tests.json");

fn probe() -> HostBindings {
    let mut members: HashMap<String, HostFn> = HashMap::new();
    members.insert(
        "data".into(),
        Arc::new(|_args: &[Value]| Ok(json!({ "list": [1, { "k": "v" }] }))),
    );
    members.insert(
        "fail".into(),
        Arc::new(|_args: &[Value]| Err("host failure".to_string())),
    );
    members.insert(
        "call".into(),
        Arc::new(|args: &[Value]| {
            let path = args[0].as_array().cloned().unwrap_or_default();
            let call_args = args[1].as_array().cloned().unwrap_or_default();
            let mut target = &args[2 + path[0].as_u64().unwrap() as usize];
            for step in &path[1..] {
                target = match step {
                    Value::String(key) => &target[key.as_str()],
                    other => &target[other.as_u64().unwrap() as usize],
                };
            }
            let callback = Callback::from_value(target).ok_or("not a callback")?;
            Ok(callback.call(&call_args)?)
        }),
    );
    let mut bindings = HostBindings::new();
    bindings.add_namespace("probe", members);
    bindings
}

#[test]
fn every_constructor_chain_is_blocked() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn every_constructor_chain_is_blocked_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}

fn run_corpus(mode: RuntimeMode) {
    let corpus: Value = serde_json::from_str(CORPUS).expect("the escape corpus is well-formed JSON");
    let template = corpus["template"].as_str().unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(!cases.is_empty());

    let mut failures = Vec::new();
    for entry in cases {
        let name = entry["name"].as_str().unwrap();
        let script = template.replace("EXPR", entry["expr"].as_str().unwrap());
        let runtime = create_runtime_from_value(
            corpus["manifest"].clone(),
            RuntimeOptions {
                host_bindings: probe(),
                mode,
                ..Default::default()
            },
        )
        .unwrap();
        match runtime.execute(&script) {
            Ok(result) if result.value == json!("blocked") => {}
            Ok(result) => failures.push(format!("{name}: {}", result.value)),
            Err(e) => failures.push(format!("{name}: error {e}")),
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
