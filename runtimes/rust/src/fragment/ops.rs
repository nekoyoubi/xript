//! The command buffer: the host-side pass over the ops a fragment hook emits.
//!
//! The in-sandbox proxy emits raw target strings and raw values and does nothing
//! else. Parsing, vocabulary checks, and value sanitization all happen here, in
//! host code, where they can be tested. Op values reach a host through the same
//! sink model the fragment's own source goes through.

use super::profiles::{speaks_html, FormatProfile, ResolvedVocabulary, Sink};
use super::rules::{is_allowed_attribute, sanitize_style_value, sanitize_uri, SchemeSet};
use super::tree::{jsml_to_tree, tree_to_jsml, OrderedJson};
use super::vocabulary::{
    sanitize_tree, DiagnosticCode, DiagnosticSeverity, FragmentDiagnostic, VocabularyOptions,
};

pub use xript_tree::ops::{parse_node_ref, FragmentOp, NodeRef};

/// The ops a `xript-tree/1` consumer is allowed to see.
///
/// `setAttr` is a deprecated alias of `setProp` and `addClass`/`removeClass` are
/// HTML sugar; a tree renderer never receives any of the three. The alias expands
/// here rather than in [`finalize_ops`] so an HTML host keeps the exact op names
/// it has always been handed.
pub fn to_contract_ops(ops: &[FragmentOp]) -> Vec<FragmentOp> {
    ops.iter()
        .filter(|op| !HTML_SUGAR_OPS.contains(&op.op.as_str()))
        .map(|op| {
            if op.op != "setAttr" {
                return op.clone();
            }
            FragmentOp { op: "setProp".to_string(), attr: None, ..op.clone() }
        })
        .collect()
}

const HTML_SUGAR_OPS: [&str; 2] = ["addClass", "removeClass"];

/// Sanitizes a raw command buffer against a format profile, dropping every op it
/// cannot route safely and reporting why.
pub fn finalize_ops(
    raw_ops: &[serde_json::Value],
    profile: &FormatProfile,
    report: &mut dyn FnMut(FragmentDiagnostic),
) -> Vec<FragmentOp> {
    let mut finalized = Vec::new();
    let is_tree = !speaks_html(profile);

    for (index, raw) in raw_ops.iter().enumerate() {
        let path = format!("/{index}");
        let op_name = raw.get("op").and_then(|value| value.as_str()).unwrap_or_default().to_string();
        let selector =
            raw.get("selector").and_then(|value| value.as_str()).unwrap_or_default().to_string();
        let target = parse_node_ref(&selector);
        let raw_value = raw.get("value");

        if is_tree && HTML_SUGAR_OPS.contains(&op_name.as_str()) {
            report(FragmentDiagnostic {
                code: DiagnosticCode::UnsupportedOp,
                severity: DiagnosticSeverity::Warning,
                path,
                node: selector,
                prop: None,
                message: format!(
                    "op \"{op_name}\" is HTML-vocabulary sugar and has no meaning in format \"{}\"",
                    profile.id
                ),
            });
            continue;
        }

        if is_tree && matches!(target, NodeRef::Selector(_)) {
            report(FragmentDiagnostic {
                code: DiagnosticCode::UnsupportedTarget,
                severity: DiagnosticSeverity::Warning,
                path,
                node: selector,
                prop: None,
                message: format!(
                    "format \"{}\" has no CSS selectors — target a node by id (\"#name\")",
                    profile.id
                ),
            });
            continue;
        }

        let mut op = FragmentOp {
            op: op_name.clone(),
            selector: selector.clone(),
            target,
            prop: None,
            attr: None,
            value: None,
        };

        match op_name.as_str() {
            "toggle" => {
                op.value = Some(serde_json::Value::Bool(raw_value == Some(&serde_json::Value::Bool(true))));
            }
            "setText" | "addClass" | "removeClass" => {
                op.value = Some(serde_json::Value::String(js_string_of(raw_value)));
            }
            "setProp" | "setAttr" => {
                let prop = raw
                    .get("prop")
                    .or_else(|| raw.get("attr"))
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty());
                let Some(prop) = prop else {
                    report(FragmentDiagnostic {
                        code: DiagnosticCode::OpUnknownProp,
                        severity: DiagnosticSeverity::Warning,
                        path,
                        node: selector,
                        prop: None,
                        message: format!("op \"{op_name}\" needs a prop name"),
                    });
                    continue;
                };
                match route_op_value(profile, prop, raw_value) {
                    Err((code, message)) => {
                        report(FragmentDiagnostic {
                            code,
                            severity: DiagnosticSeverity::Warning,
                            path,
                            node: selector,
                            prop: Some(prop.to_string()),
                            message,
                        });
                        continue;
                    }
                    Ok(value) => {
                        op.prop = Some(prop.to_string());
                        if op_name == "setAttr" {
                            op.attr = Some(prop.to_string());
                        }
                        op.value = Some(value);
                    }
                }
            }
            "replaceChildren" => {
                op.value = Some(sanitize_op_children(raw_value, profile));
            }
            _ => {}
        }

        finalized.push(op);
    }

    finalized
}

fn js_string_of(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => super::tree::js_string(
            &super::tree::to_prop_value(&OrderedJson::from_json(other)).unwrap_or_default(),
        ),
    }
}

/// An op names a prop but not the node it lands on, so the sink is resolved by
/// union across the entire resolved scope: every node of every vocabulary is
/// consulted, and resolution order carries no information here because there is
/// no name to order against. A prop name that two nodes declare with different
/// non-inert sinks is ambiguous, and an ambiguous sink is not a sink: the op is
/// refused rather than guessed.
fn route_op_value(
    profile: &FormatProfile,
    prop: &str,
    value: Option<&serde_json::Value>,
) -> Result<serde_json::Value, (DiagnosticCode, String)> {
    let html_only = profile.scope.len() == 1
        && matches!(profile.scope[0], ResolvedVocabulary::BuiltinHtml);
    if html_only {
        let lower = prop.to_lowercase();
        if !is_allowed_attribute("", &lower) {
            return Err((
                DiagnosticCode::UnsafeProp,
                format!("prop \"{prop}\" is not settable on an HTML node"),
            ));
        }
        return apply_op_sink(html_sink_for(&lower), value, &profile.schemes).ok_or((
            DiagnosticCode::UnsafeProp,
            format!("prop \"{prop}\" was rejected by its sink"),
        ));
    }

    let mut sinks: Vec<Sink> = Vec::new();
    let mut declared = false;
    for (_, definition) in profile.scope.iter().flat_map(|entry| entry.declared_nodes()) {
        let Some(declaration) = definition.prop(prop) else { continue };
        declared = true;
        if !sinks.contains(&declaration.sink) {
            sinks.push(declaration.sink);
        }
    }

    // The built-in fallback is a sink lookup, not a name lookup, so html's
    // last-place requirement in the resolution order does not gate it.
    if !declared {
        let lower = prop.to_lowercase();
        if speaks_html(profile) && is_allowed_attribute("", &lower) {
            return apply_op_sink(html_sink_for(&lower), value, &profile.schemes).ok_or((
                DiagnosticCode::UnsafeProp,
                format!("prop \"{prop}\" was rejected by its sink"),
            ));
        }
        return Err((
            DiagnosticCode::OpUnknownProp,
            format!(
                "prop \"{prop}\" is not declared by any node of format \"{}\"",
                profile.id
            ),
        ));
    }

    let dangerous: Vec<Sink> = sinks.into_iter().filter(|sink| *sink != Sink::Text).collect();
    if dangerous.len() > 1 {
        // Sorted so the message depends on the set of sinks rather than on the
        // order three runtimes happen to iterate their scopes in.
        let mut names: Vec<&str> = dangerous.iter().map(|sink| sink.as_str()).collect();
        names.sort_unstable();
        let rendered = names.join(", ");
        return Err((
            DiagnosticCode::PropSinkConflict,
            format!(
                "prop \"{prop}\" is declared with conflicting sinks ({rendered}) in format \"{}\"",
                profile.id
            ),
        ));
    }

    let sink = dangerous.first().copied().unwrap_or(Sink::Text);
    apply_op_sink(sink, value, &profile.schemes).ok_or((
        DiagnosticCode::UnsafeProp,
        format!("prop \"{prop}\" was rejected by sink \"{sink}\""),
    ))
}

/// The op-layer sink application. Unlike the fragment layer it never
/// stringifies: an inert value keeps whatever JSON type the mod set.
fn apply_op_sink(
    sink: Sink,
    value: Option<&serde_json::Value>,
    schemes: &SchemeSet,
) -> Option<serde_json::Value> {
    let value = value.cloned().unwrap_or(serde_json::Value::Null);
    if sink == Sink::Text {
        return Some(value);
    }
    let serde_json::Value::String(ref raw) = value else {
        return None;
    };
    let cleaned = match sink {
        Sink::Uri => sanitize_uri(raw, "href", schemes)?,
        Sink::ImageUri => sanitize_uri(raw, "src", schemes)?,
        Sink::Css => {
            let cleaned = sanitize_style_value(raw);
            if cleaned.is_empty() && !raw.trim().is_empty() {
                return None;
            }
            cleaned
        }
        Sink::Html => super::sanitize_html(raw),
        Sink::Text => unreachable!("handled above"),
    };
    Some(serde_json::Value::String(cleaned))
}

fn html_sink_for(lower_prop: &str) -> Sink {
    match lower_prop {
        "href" => Sink::Uri,
        "src" => Sink::ImageUri,
        "style" => Sink::Css,
        _ => Sink::Text,
    }
}

/// `replaceChildren` is the one op whose value is markup, and it goes through the
/// same vocabulary the fragment's own source does. A declared format that speaks
/// HTML carries nodes the built-in HTML vocabulary knows nothing about, so
/// sanitizing its markup against built-in HTML alone would strip exactly the
/// custom elements the format exists to declare. A J5ML node list takes the same
/// route through the tree sanitizer.
fn sanitize_op_children(
    value: Option<&serde_json::Value>,
    profile: &FormatProfile,
) -> serde_json::Value {
    match value {
        Some(serde_json::Value::String(source)) => {
            if !speaks_html(profile) {
                return serde_json::Value::String(source.clone());
            }
            let parsed = super::html::html_to_tree(source, Some(profile));
            let sanitized = sanitize_tree(&parsed, profile, VocabularyOptions::default());
            serde_json::Value::String(super::tree::tree_to_html(&sanitized.tree))
        }
        Some(serde_json::Value::Array(items)) => {
            let nodes: Vec<OrderedJson> = items.iter().map(OrderedJson::from_json).collect();
            let sanitized =
                sanitize_tree(&jsml_to_tree(&nodes), profile, VocabularyOptions::default());
            serde_json::Value::Array(tree_to_jsml(&sanitized.tree))
        }
        Some(other) => other.clone(),
        None => serde_json::Value::Null,
    }
}
