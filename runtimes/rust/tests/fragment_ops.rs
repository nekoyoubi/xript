//! Conformance against the shared command-buffer corpus in `spec/`.
//!
//! Ops leave the sandbox as raw target strings and raw values. The corpus pins
//! what every runtime must do with them before a host sees them: refuse ops a
//! vocabulary has no meaning for, and route every value through the sink model.

use serde::Deserialize;

use xript_runtime::{finalize_ops, resolve_format_profile, FragmentDiagnostic, NodeRef};

const CORPUS: &str = include_str!("../../../spec/fragment-op-tests.json");

#[derive(Deserialize)]
struct Case {
    description: String,
    format: String,
    #[serde(default)]
    formats: Option<serde_json::Value>,
    #[serde(default)]
    vocabularies: Option<serde_json::Value>,
    ops: Vec<serde_json::Value>,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    ops: serde_json::Value,
    diagnostics: serde_json::Value,
}

fn ops_to_json(ops: &[xript_runtime::FragmentOp]) -> serde_json::Value {
    serde_json::Value::Array(
        ops.iter()
            .map(|op| {
                let mut object = serde_json::Map::new();
                object.insert("op".into(), serde_json::json!(op.op));
                object.insert("selector".into(), serde_json::json!(op.selector));
                object.insert(
                    "target".into(),
                    match &op.target {
                        NodeRef::Id(id) => serde_json::json!({ "by": "id", "id": id }),
                        NodeRef::Path(path) => serde_json::json!({ "by": "path", "path": path }),
                        NodeRef::Selector(selector) => {
                            serde_json::json!({ "by": "selector", "selector": selector })
                        }
                    },
                );
                if let Some(ref prop) = op.prop {
                    object.insert("prop".into(), serde_json::json!(prop));
                }
                if let Some(ref attr) = op.attr {
                    object.insert("attr".into(), serde_json::json!(attr));
                }
                if let Some(ref value) = op.value {
                    object.insert("value".into(), value.clone());
                }
                serde_json::Value::Object(object)
            })
            .collect(),
    )
}

fn diagnostics_to_json(diagnostics: &[FragmentDiagnostic]) -> serde_json::Value {
    serde_json::Value::Array(
        diagnostics
            .iter()
            .map(|diagnostic| {
                let mut object = serde_json::Map::new();
                object.insert("code".into(), serde_json::json!(diagnostic.code.as_str()));
                object.insert(
                    "severity".into(),
                    serde_json::json!(diagnostic.severity.as_str()),
                );
                object.insert("node".into(), serde_json::json!(diagnostic.node));
                if let Some(ref prop) = diagnostic.prop {
                    object.insert("prop".into(), serde_json::json!(prop));
                }
                object.insert("message".into(), serde_json::json!(diagnostic.message));
                object.insert("path".into(), serde_json::json!(diagnostic.path));
                serde_json::Value::Object(object)
            })
            .collect(),
    )
}

#[test]
fn matches_the_shared_op_corpus() {
    let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();

    for case in &cases {
        let profile = resolve_format_profile(&case.format, case.formats.as_ref(), case.vocabularies.as_ref())
            .unwrap_or_else(|err| panic!("case '{}': {}", case.description, err.message))
            .unwrap_or_else(|| panic!("case '{}': format did not resolve", case.description));

        let mut diagnostics = Vec::new();
        let ops = {
            let mut report = |diagnostic: FragmentDiagnostic| diagnostics.push(diagnostic);
            finalize_ops(&case.ops, &profile, &mut report)
        };

        let got_ops = ops_to_json(&ops);
        if got_ops != case.expected.ops {
            failures.push(format!(
                "case '{}' [ops]\n  expected: {}\n  got:      {}",
                case.description, case.expected.ops, got_ops
            ));
        }

        let got_diagnostics = diagnostics_to_json(&diagnostics);
        if got_diagnostics != case.expected.diagnostics {
            failures.push(format!(
                "case '{}' [diagnostics]\n  expected: {}\n  got:      {}",
                case.description, case.expected.diagnostics, got_diagnostics
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} mismatches across {} op corpus cases:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
