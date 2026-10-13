//! Conformance against the shared sandbox-to-host marshalling corpus in `spec/`.
//!
//! A script value crossing out to the host is data. A script function carries
//! nothing across and must never reach the host as something callable, so it
//! marshals to null at the top level and as an array element and is omitted as
//! an object property, exactly as JSON serialization renders the same shape.

use serde::Deserialize;

use xript_runtime::{create_runtime, HostBindings, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/marshal-out-tests.json");

const MANIFEST: &str = r#"{ "xript": "0.1", "name": "marshal-out-probe" }"#;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    script: String,
    expected: serde_json::Value,
}

#[test]
fn marshal_out_corpus() {
    let corpus: Corpus = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();

    for case in corpus.cases {
        let runtime = create_runtime(
            MANIFEST,
            RuntimeOptions { host_bindings: HostBindings::new(), ..Default::default() },
        )
        .expect("runtime builds");
        match runtime.execute(&case.script) {
            Ok(result) if result.value == case.expected => {}
            Ok(result) => failures.push(format!("{}: expected {}, got {}", case.name, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }

    assert!(failures.is_empty(), "marshal-out corpus failures:\n{}", failures.join("\n"));
}
