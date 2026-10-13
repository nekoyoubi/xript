use std::sync::{Arc, Mutex};

use serde_json::Value;
use xript_runtime::{create_runtime, create_runtime_from_value, HostBindings, RuntimeOptions, XriptError};

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/manifest-shape-tests.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus is readable"))
        .expect("corpus is valid JSON")
}

/// Every case in the shared corpus, so the load-time shape checks cannot drift from the other
/// three runtimes.
#[test]
fn applies_every_case_in_the_shared_corpus() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "corpus carries no cases");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let result = create_runtime_from_value(case["manifest"].clone(), RuntimeOptions::default());
        if case["valid"].as_bool() == Some(true) {
            assert!(result.is_ok(), "{name}: {:?}", result.err());
            continue;
        }
        match result {
            Err(XriptError::ManifestValidation { issues }) => {
                let actual: Vec<(String, String)> =
                    issues.into_iter().map(|issue| (issue.path, issue.message)).collect();
                let expected: Vec<(String, String)> = case["issues"]
                    .as_array()
                    .expect("issues")
                    .iter()
                    .map(|issue| {
                        (
                            issue["path"].as_str().unwrap().to_string(),
                            issue["message"].as_str().unwrap().to_string(),
                        )
                    })
                    .collect();
                assert_eq!(actual, expected, "{name}");
            }
            Err(other) => panic!("{name}: expected a manifest validation error, got {other}"),
            Ok(_) => panic!("{name}: expected the manifest to be refused"),
        }
    }
}

#[test]
fn the_string_entry_point_applies_the_same_checks() {
    let result = create_runtime(
        r#"{ "xript": "0.9", "name": "probe", "slots": { "panel": { "accepts": ["text/html"] } } }"#,
        RuntimeOptions::default(),
    );
    assert!(matches!(result, Err(XriptError::ManifestValidation { .. })));
}

#[test]
fn passes_every_argument_through_to_a_variadic_binding() {
    let received: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();
    let mut bindings = HostBindings::new();
    bindings.add_function("log", move |args: &[Value]| {
        sink.lock().unwrap().push(Value::Array(args.to_vec()));
        Ok(Value::Null)
    });
    let runtime = create_runtime(
        r#"{
            "xript": "0.9",
            "name": "probe",
            "bindings": {
                "log": {
                    "description": "Logs.",
                    "params": [
                        { "name": "level", "type": "string" },
                        { "name": "parts", "type": "string", "variadic": true }
                    ]
                }
            }
        }"#,
        RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        },
    )
    .unwrap();
    runtime.execute(r#"log("info", "a", "b", "c")"#).unwrap();
    assert_eq!(
        *received.lock().unwrap(),
        vec![serde_json::json!(["info", "a", "b", "c"])]
    );
}
