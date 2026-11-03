//! Accessor bindings, checked against the shared corpus every runtime answers to.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use xript_runtime::{
    create_runtime_from_value, AuditEvent, HostAccessor, HostBindings, RuntimeMode,
    RuntimeOptions, XriptError,
};

const CORPUS: &str = include_str!("../../../spec/accessor-tests.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("the accessor corpus is well-formed JSON")
}

fn numeric(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64()),
        Value::Array(items) => Value::Array(items.iter().map(numeric).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), numeric(v))).collect()),
        other => other.clone(),
    }
}

struct ProbeState {
    reads: u64,
    writes: Vec<Value>,
    speed: Value,
}

fn probe(state: Arc<Mutex<ProbeState>>) -> HostBindings {
    let reads = state.clone();
    let read_speed = state.clone();
    let write_speed = state.clone();

    let mut bindings = HostBindings::new();
    bindings
        .namespace("clock")
        .accessor(
            "now",
            HostAccessor::new(move || {
                let mut s = reads.lock().unwrap();
                s.reads += 1;
                Ok(json!(s.reads))
            }),
        )
        .accessor(
            "speed",
            HostAccessor::new(move || Ok(read_speed.lock().unwrap().speed.clone())).with_setter(move |value| {
                let mut s = write_speed.lock().unwrap();
                s.writes.push(value.clone());
                s.speed = value;
                Ok(())
            }),
        )
        .accessor("broken", HostAccessor::new(|| Err("clock offline".into())))
        .accessor(
            "jammed",
            HostAccessor::new(|| Ok(json!(0))).with_setter(|_| Err("rejected value".into())),
        )
        .accessor("locked", HostAccessor::new(|| Ok(json!("secret"))))
        .finish();
    bindings.add_accessor("phase", HostAccessor::new(|| Ok(json!("day"))));
    bindings
}

fn fresh_state() -> Arc<Mutex<ProbeState>> {
    Arc::new(Mutex::new(ProbeState {
        reads: 0,
        writes: Vec::new(),
        speed: json!(1),
    }))
}

#[test]
fn reports_the_omitted_non_optional_accessor_as_missing() {
    let corpus = corpus();
    let runtime = create_runtime_from_value(
        corpus["manifest"].clone(),
        RuntimeOptions {
            host_bindings: probe(fresh_state()),
            ..Default::default()
        },
    )
    .unwrap();
    let expected: Vec<String> = corpus["missingBindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(runtime.missing_bindings(), expected);
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
        let state = fresh_state();
        let runtime = create_runtime_from_value(
            corpus["manifest"].clone(),
            RuntimeOptions {
                host_bindings: probe(state.clone()),
                mode,
                ..Default::default()
            },
        )
        .unwrap_or_else(|e| panic!("{name}: runtime: {e}"));

        let outcome = runtime.execute(script);
        if expect.get("limit").is_some() {
            assert!(
                matches!(outcome, Err(XriptError::ExecutionLimit { .. })),
                "{name}: expected an execution limit, got {outcome:?}"
            );
            continue;
        }
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
        let s = state.lock().unwrap();
        if let Some(reads) = expect.get("reads").and_then(|v| v.as_u64()) {
            assert_eq!(s.reads, reads, "{name}: reads");
        }
        if let Some(writes) = expect.get("writes") {
            assert_eq!(numeric(&Value::Array(s.writes.clone())), numeric(writes), "{name}: writes");
        }
    }
}

const SHAPES: &str = r#"{
    "xript": "0.10",
    "name": "accessor-shapes",
    "bindings": {
        "ns": {
            "description": "Accessors.",
            "members": {
                "value": { "description": "Read and written live.", "accessor": "get-set" }
            }
        }
    }
}"#;

#[test]
fn each_access_is_audited_as_a_binding_call() {
    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let mut bindings = HostBindings::new();
    bindings
        .namespace("ns")
        .accessor("value", HostAccessor::new(|| Ok(json!(1))).with_setter(|_| Ok(())))
        .finish();
    let runtime = create_runtime_from_value(
        serde_json::from_str(SHAPES).unwrap(),
        RuntimeOptions {
            host_bindings: bindings,
            audit: Some(Arc::new(move |event: AuditEvent| sink.lock().unwrap().push(event.binding))),
            ..Default::default()
        },
    )
    .unwrap();
    runtime.execute("ns.value; ns.value = 2;").unwrap();
    assert_eq!(*events.lock().unwrap(), vec!["ns.value".to_string(), "ns.value".to_string()]);
}

#[test]
fn a_get_set_declaration_with_no_host_setter_is_missing() {
    let mut bindings = HostBindings::new();
    bindings.namespace("ns").accessor("value", HostAccessor::new(|| Ok(json!(1)))).finish();
    let runtime = create_runtime_from_value(
        serde_json::from_str(SHAPES).unwrap(),
        RuntimeOptions {
            host_bindings: bindings,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(runtime.missing_bindings(), ["ns.value"]);
    let error = runtime.execute("ns.value").unwrap_err();
    assert!(error.to_string().contains("ns.value"), "{error}");
}
