//! Conformance against the shared host-to-sandbox marshalling corpus in `spec/`.
//!
//! A host value is data. An own key spelled `__proto__` has to arrive in the
//! sandbox as an own data property, never as a prototype assignment.

use serde::Deserialize;

use xript_runtime::{create_runtime, HostBindings, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/marshal-tests.json");

const MANIFEST: &str = r#"{
    "xript": "0.1",
    "name": "marshal-probe",
    "bindings": { "value": { "description": "Returns the case's host value." } }
}"#;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    description: String,
    #[serde(rename = "hostValue")]
    host_value: String,
    probe: String,
    expected: String,
}

#[test]
fn marshal_corpus() {
    let corpus: Corpus = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();

    for case in corpus.cases {
        let host_value: serde_json::Value = serde_json::from_str(&case.host_value).expect("host value parses");
        let mut bindings = HostBindings::new();
        bindings.add_function("value", move |_: &[serde_json::Value]| Ok(host_value.clone()));
        let runtime = create_runtime(
            MANIFEST,
            RuntimeOptions { host_bindings: bindings, ..Default::default() },
        )
        .expect("runtime builds");
        let script = format!("(function () {{ var v = value(); return ({}); }})()", case.probe);
        match runtime.execute(&script) {
            Ok(result) if result.value == serde_json::json!(case.expected) => {}
            Ok(result) => failures.push(format!("{}: expected {:?}, got {}", case.description, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.description)),
        }
    }

    assert!(failures.is_empty(), "marshal corpus failures:\n{}", failures.join("\n"));
}
