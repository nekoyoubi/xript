//! Conformance against the shared fragment-vocabulary corpus in `spec/`.
//!
//! The corpus is the cross-runtime contract for the vocabulary model: every
//! runtime sanitizes the same sources against the same format declarations and
//! must produce the same tree, the same HTML projection, and the same
//! diagnostics.

use serde::Deserialize;

use xript_runtime::fragment::sanitize::sanitize_fragment;
use xript_runtime::{
    resolve_format_profile, FragmentContentType, FragmentNode, VocabularyOptions,
};

const CORPUS: &str = include_str!("../../../spec/fragment-vocabulary-tests.json");

#[derive(Deserialize)]
struct Case {
    description: String,
    format: String,
    #[serde(default)]
    formats: Option<serde_json::Value>,
    #[serde(default)]
    vocabularies: Option<serde_json::Value>,
    #[serde(default)]
    source: String,
    #[serde(default)]
    expected: Option<Expected>,
    #[serde(default, rename = "expectedError")]
    expected_error: Option<ExpectedError>,
}

#[derive(Deserialize)]
struct ExpectedError {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    content_type: String,
    html: String,
    tree: serde_json::Value,
    #[serde(default)]
    jsml: Option<serde_json::Value>,
    diagnostics: serde_json::Value,
    stripped_elements: serde_json::Value,
    stripped_attributes: serde_json::Value,
}

fn tree_to_json(tree: &[FragmentNode]) -> serde_json::Value {
    serde_json::Value::Array(
        tree.iter()
            .map(|node| match node {
                FragmentNode::Text { value, .. } => serde_json::json!({ "text": value }),
                FragmentNode::Element(element) => {
                    let mut props = serde_json::Map::new();
                    for (key, value) in element.props.iter() {
                        props.insert(
                            key.clone(),
                            xript_runtime::fragment::tree::attribute_value_to_json(value),
                        );
                    }
                    let mut object = serde_json::Map::new();
                    object.insert("name".into(), serde_json::json!(element.name));
                    object.insert("props".into(), serde_json::Value::Object(props));
                    object.insert("children".into(), tree_to_json(&element.children));
                    if element.self_closing {
                        object.insert("selfClosing".into(), serde_json::json!(true));
                    }
                    serde_json::Value::Object(object)
                }
            })
            .collect(),
    )
}

fn diagnostics_to_json(
    diagnostics: &[xript_runtime::FragmentDiagnostic],
) -> serde_json::Value {
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
                object.insert("path".into(), serde_json::json!(diagnostic.path));
                object.insert("node".into(), serde_json::json!(diagnostic.node));
                if let Some(ref prop) = diagnostic.prop {
                    object.insert("prop".into(), serde_json::json!(prop));
                }
                object.insert("message".into(), serde_json::json!(diagnostic.message));
                serde_json::Value::Object(object)
            })
            .collect(),
    )
}

#[test]
fn matches_the_shared_vocabulary_corpus() {
    let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();

    for case in &cases {
        let resolution =
            resolve_format_profile(&case.format, case.formats.as_ref(), case.vocabularies.as_ref());

        if let Some(expected_error) = &case.expected_error {
            match resolution {
                Err(err) if err.message == expected_error.message => {}
                Err(err) => failures.push(format!(
                    "case '{}' [error message]\n  expected: {}\n  got:      {}",
                    case.description, expected_error.message, err.message
                )),
                Ok(_) => failures.push(format!(
                    "case '{}': expected the format to be refused, but it resolved",
                    case.description
                )),
            }
            continue;
        }

        let profile = resolution
            .unwrap_or_else(|err| panic!("case '{}': {}", case.description, err.message))
            .unwrap_or_else(|| panic!("case '{}': format did not resolve", case.description));

        let expected = case
            .expected
            .as_ref()
            .unwrap_or_else(|| panic!("case '{}': success case has no 'expected'", case.description));

        let result = sanitize_fragment(&case.source, &profile, VocabularyOptions::default())
            .unwrap_or_else(|err| panic!("case '{}': {}", case.description, err.message));

        let content_type = match result.content_type {
            FragmentContentType::Html => "html",
            FragmentContentType::Tree => "tree",
        };

        let mut mismatch = |field: &str, expected: String, got: String| {
            failures.push(format!(
                "case '{}' [{}]\n  expected: {}\n  got:      {}",
                case.description, field, expected, got
            ));
        };

        if content_type != expected.content_type {
            mismatch(
                "contentType",
                expected.content_type.clone(),
                content_type.to_string(),
            );
        }
        if result.html != expected.html {
            mismatch("html", format!("{:?}", expected.html), format!("{:?}", result.html));
        }

        let tree = tree_to_json(&result.tree);
        if tree != expected.tree {
            mismatch("tree", expected.tree.to_string(), tree.to_string());
        }

        if let Some(expected_jsml) = &expected.jsml {
            let jsml = serde_json::Value::Array(xript_runtime::tree_to_jsml(&result.tree));
            if &jsml != expected_jsml {
                mismatch("jsml", expected_jsml.to_string(), jsml.to_string());
            }
        }

        let diagnostics = diagnostics_to_json(&result.diagnostics);
        if diagnostics != expected.diagnostics {
            mismatch(
                "diagnostics",
                expected.diagnostics.to_string(),
                diagnostics.to_string(),
            );
        }

        let stripped_elements = serde_json::json!(result.stripped_elements);
        if stripped_elements != expected.stripped_elements {
            mismatch(
                "strippedElements",
                expected.stripped_elements.to_string(),
                stripped_elements.to_string(),
            );
        }

        let stripped_attributes = serde_json::Value::Array(
            result
                .stripped_attributes
                .iter()
                .map(|entry| {
                    serde_json::json!({ "element": entry.element, "attribute": entry.attribute })
                })
                .collect(),
        );
        if stripped_attributes != expected.stripped_attributes {
            mismatch(
                "strippedAttributes",
                expected.stripped_attributes.to_string(),
                stripped_attributes.to_string(),
            );
        }
    }

    assert!(
        failures.is_empty(),
        "{} mismatches across {} vocabulary corpus cases:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
