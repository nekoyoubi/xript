//! Which props a bound value can reach, and how structured props project to HTML.

use xript_runtime::fragment::{create_fragment_instance, FragmentOptions};
use xript_runtime::{canonical_json, prop_attribute_value, FragmentDeclaration, FragmentNode};

const TREE_FORMAT: &str = "application/x-probe+json";
const HTML_FORMAT: &str = "application/x-probe-html+json";

fn options() -> FragmentOptions {
    FragmentOptions {
        formats: Some(serde_json::json!({
            TREE_FORMAT: {
                "syntax": "j5ml",
                "nodes": {
                    "Gauge": { "props": { "max": { "type": "number" } }, "children": "none" },
                    "Meter": { "props": { "level": { "type": "string" } }, "children": "none", "bindTo": "level" },
                    "Anchor": { "props": { "href": { "type": "string", "sink": "uri" } }, "children": "none", "bindTo": "href" }
                }
            },
            HTML_FORMAT: { "syntax": "j5ml", "vocabularies": ["probe.charts", "html"] }
        })),
        vocabularies: Some(serde_json::json!({
            "probe.charts": {
                "nodes": {
                    "x-chart": { "props": { "series": { "type": "array" }, "config": { "type": "object" } } }
                }
            }
        })),
        strict_html_vocabulary: false,
    }
}

fn content(format: &str, source: &str, data: serde_json::Value) -> xript_runtime::fragment::FragmentResult {
    let declaration: FragmentDeclaration = serde_json::from_value(serde_json::json!({
        "id": "probe",
        "slot": "s",
        "format": format,
        "source": source,
        "inline": true,
        "bindings": [{ "name": "v", "path": "v" }]
    }))
    .unwrap();
    let instance = create_fragment_instance(&declaration, source, &options()).unwrap();
    instance.get_content(&data)
}

#[test]
fn a_bind_into_an_undeclared_prop_is_reported() {
    let result = content(
        TREE_FORMAT,
        r#"["Gauge",{"data-bind":"v","max":10}]"#,
        serde_json::json!({ "v": 7 }),
    );
    let FragmentNode::Element(gauge) = &result.tree[0] else { panic!("expected an element") };
    assert!(gauge.props.get("value").is_none());
    assert_eq!(result.diagnostics.len(), 1);
    let diagnostic = &result.diagnostics[0];
    assert_eq!(diagnostic.code.as_str(), "unknown-prop");
    assert_eq!(diagnostic.path, "/0");
    assert_eq!(diagnostic.node, "Gauge");
    assert_eq!(diagnostic.prop.as_deref(), Some("value"));
    assert_eq!(
        diagnostic.message,
        "data-bind target \"value\" is not declared on node \"Gauge\"; the bound value was dropped"
    );
}

#[test]
fn a_bind_into_a_declared_target_is_silent() {
    let result = content(
        TREE_FORMAT,
        r#"["Meter",{"data-bind":"v"}]"#,
        serde_json::json!({ "v": "high" }),
    );
    let FragmentNode::Element(meter) = &result.tree[0] else { panic!("expected an element") };
    assert_eq!(meter.props.get("level"), Some(&serde_json::json!("high")));
    assert!(result.diagnostics.is_empty());
}

#[test]
fn a_bind_its_sink_rejects_is_reported() {
    let result = content(
        TREE_FORMAT,
        r#"["Anchor",{"data-bind":"v"}]"#,
        serde_json::json!({ "v": "javascript:alert(1)" }),
    );
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].code.as_str(), "unsafe-prop");
    assert_eq!(result.diagnostics[0].prop.as_deref(), Some("href"));
}

#[test]
fn sanitizer_diagnostics_precede_bind_diagnostics() {
    let result = content(
        TREE_FORMAT,
        r#"["Gauge",{"data-bind":"v","bogus":1}]"#,
        serde_json::json!({ "v": 1 }),
    );
    let props: Vec<_> = result.diagnostics.iter().map(|d| d.prop.clone().unwrap_or_default()).collect();
    assert_eq!(props, vec!["bogus".to_string(), "value".to_string()]);
}

#[test]
fn get_content_projects_html_for_custom_element_formats() {
    let result = content(
        HTML_FORMAT,
        r#"["x-chart",{"series":[1,2],"config":{"b":1,"a":2},"data-tags":["x","y"]}]"#,
        serde_json::json!({}),
    );
    assert_eq!(
        result.html,
        "<x-chart series=\"[1,2]\" config=\"{&quot;a&quot;:2,&quot;b&quot;:1}\" data-tags=\"x,y\"></x-chart>"
    );
}

#[test]
fn get_content_html_stays_empty_without_a_projection() {
    let result = content(TREE_FORMAT, r#"["Gauge",{"max":3}]"#, serde_json::json!({}));
    assert_eq!(result.html, "");
}

#[test]
fn structured_values_encode_canonically() {
    assert_eq!(
        canonical_json(&serde_json::json!({ "\u{1F600}": 1, "\u{E000}": 2, "s": "q\"\\\u{8}\u{c}\n\r\t\u{1}\u{2028}/<" })),
        "{\"s\":\"q\\\"\\\\\\b\\f\\n\\r\\t\\u0001\u{2028}/<\",\"\u{E000}\":2,\"\u{1F600}\":1}"
    );
    assert_eq!(canonical_json(&serde_json::json!([1e21, 0.1, -5, 1.5e-7])), "[1e+21,0.1,-5,1.5e-7]");
    assert_eq!(prop_attribute_value(&serde_json::json!({ "a": 1 }), None), "{\"a\":1}");
    assert_eq!(prop_attribute_value(&serde_json::json!([[1, { "a": 1 }]]), None), "[[1,{\"a\":1}]]");
    assert_eq!(prop_attribute_value(&serde_json::json!([1, null, "x"]), None), "1,,x");
    let declared = vec!["array".to_string()];
    assert_eq!(prop_attribute_value(&serde_json::json!([1, null, "x"]), Some(&declared)), "[1,null,\"x\"]");
}
