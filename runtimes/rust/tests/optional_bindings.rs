//! Optional bindings and the `xript.has` probe, checked against the shared
//! corpus every runtime answers to.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, HostBindings, HostNamespaceMember, RuntimeMode, RuntimeOptions, XriptError};

const CORPUS: &str = include_str!("../../../spec/optional-binding-tests.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("the optional-binding corpus is well-formed JSON")
}

fn numeric(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64()),
        Value::Array(items) => Value::Array(items.iter().map(numeric).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), numeric(v))).collect()),
        other => other.clone(),
    }
}

fn host(corpus: &Value) -> HostBindings {
    let mut bindings = HostBindings::new();
    let mut namespaces: HashMap<String, HashMap<String, HostNamespaceMember>> = HashMap::new();
    for (path, spec) in corpus["provided"].as_object().unwrap() {
        let returns = spec["returns"].clone();
        match path.split_once('.') {
            Some((ns, member)) => {
                namespaces.entry(ns.to_string()).or_default().insert(
                    member.to_string(),
                    HostNamespaceMember::Function(Arc::new(move |_| Ok(returns.clone()))),
                );
            }
            None if path == "echo" => {
                bindings.add_function("echo", |args: &[Value]| Ok(args.first().cloned().unwrap_or(Value::Null)))
            }
            None => bindings.add_function(path.clone(), move |_: &[Value]| Ok(returns.clone())),
        }
    }
    for (name, members) in namespaces {
        bindings.add_nested_namespace(name, members);
    }
    bindings
}

fn capabilities(corpus: &Value) -> Vec<String> {
    corpus["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect()
}

fn expected_missing(corpus: &Value) -> Vec<String> {
    corpus["missingBindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn has_follows_the_missing_check_for_an_eager_value() {
    let corpus = corpus();
    let eager = &corpus["eagerValue"];
    let mut members: HashMap<String, HostNamespaceMember> = HashMap::new();
    for (path, spec) in eager["provided"].as_object().unwrap() {
        let returns = spec["returns"].clone();
        let (_, member) = path.split_once('.').unwrap();
        members.insert(
            member.to_string(),
            HostNamespaceMember::Function(Arc::new(move |_| Ok(returns.clone()))),
        );
    }
    for (path, value) in eager["providedValues"].as_object().unwrap() {
        let (_, member) = path.split_once('.').unwrap();
        members.insert(member.to_string(), HostNamespaceMember::Property(value.clone()));
    }
    let mut bindings = HostBindings::new();
    bindings.add_nested_namespace("meta", members);
    let runtime = create_runtime_from_value(
        eager["manifest"].clone(),
        RuntimeOptions {
            host_bindings: bindings,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(runtime.missing_bindings(), expected_missing(eager));
    let result = runtime.execute(eager["script"].as_str().unwrap()).unwrap();
    assert_eq!(result.value, eager["expect"]["result"]);
}

#[test]
fn reports_only_the_non_optional_omission_as_missing() {
    let corpus = corpus();
    let runtime = create_runtime_from_value(
        corpus["manifest"].clone(),
        RuntimeOptions {
            host_bindings: host(&corpus),
            capabilities: capabilities(&corpus),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(runtime.missing_bindings(), expected_missing(&corpus));
}

#[test]
fn strict_construction_names_exactly_the_non_optional_omission() {
    let corpus = corpus();
    let result = create_runtime_from_value(
        corpus["manifest"].clone(),
        RuntimeOptions {
            host_bindings: host(&corpus),
            capabilities: capabilities(&corpus),
            strict_bindings: true,
            ..Default::default()
        },
    );
    match result {
        Err(XriptError::MissingBindings { missing }) => assert_eq!(missing, expected_missing(&corpus)),
        Err(other) => panic!("expected MissingBindings, got {other:?}"),
        Ok(_) => panic!("expected MissingBindings, got a runtime"),
    }
}

#[test]
fn strict_construction_succeeds_once_only_optional_bindings_are_omitted() {
    let corpus = corpus();
    let mut bindings = host(&corpus);
    bindings.add_function("legacy", |_: &[Value]| Ok(json!("late")));
    let runtime = create_runtime_from_value(
        corpus["manifest"].clone(),
        RuntimeOptions {
            host_bindings: bindings,
            capabilities: capabilities(&corpus),
            strict_bindings: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(runtime.missing_bindings().is_empty());
}

#[test]
fn every_corpus_case_holds() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn every_corpus_case_holds_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}

fn run_corpus(mode: RuntimeMode) {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());

    for entry in cases {
        let name = entry["name"].as_str().unwrap();
        let script = entry["script"].as_str().unwrap();
        let expect = &entry["expect"];
        let runtime = create_runtime_from_value(
            corpus["manifest"].clone(),
            RuntimeOptions {
                host_bindings: host(&corpus),
                capabilities: capabilities(&corpus),
                mode,
                ..Default::default()
            },
        )
        .unwrap_or_else(|e| panic!("{name}: runtime: {e}"));

        let outcome = runtime.execute(script);
        if let Some(parts) = expect.get("error").and_then(|v| v.as_array()) {
            let message = match outcome {
                Err(e) => e.to_string(),
                Ok(v) => panic!("{name}: expected an error, got {:?}", v.value),
            };
            for part in parts {
                let part = part.as_str().unwrap();
                assert!(message.contains(part), "{name}: {message:?} lacks {part:?}");
            }
        } else {
            let value = outcome.unwrap_or_else(|e| panic!("{name}: {e}")).value;
            assert_eq!(numeric(&value), numeric(&expect["result"]), "{name}");
        }
    }
}
