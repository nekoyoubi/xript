//! Runtime-level fragment behavior: format resolution, instance construction,
//! tree binding, and how a host manifest's `formats` block reaches all of it.

use std::collections::{HashMap, HashSet};

use xript_runtime::fragment::{
    create_fragment_instance, process_tree, resolve_fragment_profile, FragmentOptions,
};
use xript_runtime::{
    resolve_format_profile, FragmentContentType, FragmentDeclaration, FragmentNode, Manifest,
    XriptError,
};

const RATATUI_FORMATS: &str = r#"{
  "application/x-ratatui+json": {
    "syntax": "jsml",
    "nodes": {
      "Block": { "props": { "title": { "type": "string" } }, "children": "any" },
      "Gauge": {
        "props": {
          "label": { "type": "string" },
          "ratio": { "type": "number" },
          "style": { "type": "string", "sink": "css" }
        },
        "children": "none",
        "bindTo": "ratio"
      }
    }
  }
}"#;

fn formats() -> serde_json::Value {
    serde_json::from_str(RATATUI_FORMATS).unwrap()
}

fn declaration(id: &str, format: &str, source: &str) -> FragmentDeclaration {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "slot": "main",
        "format": format,
        "source": source,
        "inline": true
    }))
    .unwrap()
}

fn options() -> FragmentOptions {
    FragmentOptions {
        formats: Some(formats()),
        vocabularies: None,
        strict_html_vocabulary: false,
    }
}

#[test]
fn an_unrecognized_format_is_a_hard_error() {
    let err = resolve_fragment_profile("application/x-nope+json", "frag", Some(&formats()), None)
        .expect_err("an undeclared format must not resolve");
    match err {
        XriptError::FragmentFormat { fragment_id, format, message } => {
            assert_eq!(fragment_id, "frag");
            assert_eq!(format, "application/x-nope+json");
            assert!(message.contains("declare it in the host manifest's 'formats' block"));
        }
        other => panic!("expected a format error, got {other:?}"),
    }
}

#[test]
fn an_unrecognized_format_never_falls_through_the_html_sanitizer() {
    let decl = declaration("f", "application/x-nope+json", "<b>x</b>");
    assert!(create_fragment_instance(&decl, "<b>x</b>", &options()).is_err());
}

#[test]
fn a_malformed_format_declaration_is_reported() {
    let bad = serde_json::json!({ "application/x-bad+json": { "syntax": "yaml" } });
    let err = resolve_format_profile("application/x-bad+json", Some(&bad), None)
        .expect_err("an unknown syntax must be rejected");
    assert!(err.message.contains("declares an unknown syntax"));
}

#[test]
fn a_builtin_format_id_wins_over_a_host_redeclaration() {
    let shadow = serde_json::json!({
        "text/html": { "syntax": "jsml", "nodes": { "Nope": {} } }
    });
    let profile = resolve_format_profile("text/html", Some(&shadow), None).unwrap().unwrap();
    assert!(profile.builtin);
    assert_eq!(profile.scope, vec![xript_runtime::ResolvedVocabulary::BuiltinHtml]);
}

#[test]
fn a_builtin_html_fragment_still_carries_its_html_projection() {
    let decl = declaration("f", "text/html", "");
    let instance =
        create_fragment_instance(&decl, "<div class=\"a\"><span>hi</span></div>", &options())
            .unwrap();
    assert_eq!(instance.content_type, FragmentContentType::Html);
    assert_eq!(instance.sanitized_source, "<div class=\"a\"><span>hi</span></div>");
    assert_eq!(instance.sanitized_tree.len(), 1);
}

#[test]
fn a_declared_vocabulary_fragment_carries_a_tree_and_no_html() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let source = r#"["Block",{"title":"Stats"},["Gauge",{"ratio":0.625,"label":"hp"}]]"#;
    let instance = create_fragment_instance(&decl, source, &options()).unwrap();

    assert_eq!(instance.content_type, FragmentContentType::Tree);
    assert_eq!(instance.sanitized_source, "");

    let FragmentNode::Element(block) = &instance.sanitized_tree[0] else {
        panic!("expected an element");
    };
    assert_eq!(block.name, "Block");
    assert_eq!(
        block.props.get("title"),
        Some(&serde_json::Value::String("Stats".into()))
    );

    let FragmentNode::Element(gauge) = &block.children[0] else {
        panic!("expected a child element");
    };
    assert_eq!(gauge.name, "Gauge");
    assert_eq!(gauge.props.get("ratio"), Some(&serde_json::json!(0.625)));
}

#[test]
fn an_error_severity_diagnostic_refuses_the_fragment() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let err = create_fragment_instance(&decl, r#"["Bogus"]"#, &options())
        .expect_err("an undeclared node must refuse the fragment");
    match err {
        XriptError::FragmentSanitize { fragment_id, diagnostics } => {
            assert_eq!(fragment_id, "f");
            assert_eq!(diagnostics.len(), 1);
            assert!(diagnostics[0].message.contains("is not declared by format"));
        }
        other => panic!("expected a sanitize error, got {other:?}"),
    }
}

#[test]
fn strict_html_vocabulary_promotes_an_unknown_tag_to_an_error() {
    let decl = declaration("f", "text/html", "");
    let lenient = create_fragment_instance(&decl, "<marquee>hi</marquee>", &options()).unwrap();
    assert_eq!(lenient.diagnostics.len(), 1);

    let strict = FragmentOptions {
        formats: Some(formats()),
        vocabularies: None,
        strict_html_vocabulary: true,
    };
    assert!(create_fragment_instance(&decl, "<marquee>hi</marquee>", &strict).is_err());
}

#[test]
fn a_bound_value_lands_in_children_by_default() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let source = r#"["Block",{"data-bind":"title"}]"#;
    let instance = create_fragment_instance(&decl, source, &options()).unwrap();

    let mut bindings = HashMap::new();
    bindings.insert("title".to_string(), serde_json::json!("Live"));

    let bound = process_tree(&instance.sanitized_tree, &bindings, &instance.profile);
    let FragmentNode::Element(block) = &bound.tree[0] else { panic!("expected an element") };
    assert_eq!(block.children, vec![FragmentNode::text("Live")]);
}

#[test]
fn a_bound_value_honors_the_nodes_bind_to_prop() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let source = r#"["Gauge",{"data-bind":"pct"}]"#;
    let instance = create_fragment_instance(&decl, source, &options()).unwrap();

    let mut bindings = HashMap::new();
    bindings.insert("pct".to_string(), serde_json::json!(0.4));

    let bound = process_tree(&instance.sanitized_tree, &bindings, &instance.profile);
    let FragmentNode::Element(gauge) = &bound.tree[0] else { panic!("expected an element") };
    // The profile types `ratio` as a number, so the number survives. A renderer
    // draws a gauge from the tree alone; handing it the string "0.4" would put it
    // back in the parsing business the tree contract exists to end.
    assert_eq!(gauge.props.get("ratio"), Some(&serde_json::json!(0.4)));
}

#[test]
fn a_bound_value_still_stringifies_into_a_textual_prop() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let source = r#"["Gauge",{"data-bind":"pct","label":"x"}]"#;
    let instance = create_fragment_instance(&decl, source, &options()).unwrap();

    let mut bindings = HashMap::new();
    bindings.insert("pct".to_string(), serde_json::json!(0.4));

    let bound = process_tree(&instance.sanitized_tree, &bindings, &instance.profile);
    let FragmentNode::Element(gauge) = &bound.tree[0] else { panic!("expected an element") };
    assert_eq!(gauge.props.get("label"), Some(&serde_json::json!("x")));
}

/// A binding must not be a way around the sanitizer: whatever a value lands in,
/// it goes through that prop's sink first.
#[test]
fn a_bound_value_is_routed_through_the_props_sink() {
    let ratatui: serde_json::Value = serde_json::from_str(
        r#"{"application/x-styled+json":{"syntax":"jsml","nodes":{
             "Gauge":{"props":{"style":{"type":"string","sink":"css"}},"bindTo":"style"}}}}"#,
    )
    .unwrap();
    let opts = FragmentOptions {
        formats: Some(ratatui),
        vocabularies: None,
        strict_html_vocabulary: false,
    };
    let decl = declaration("f", "application/x-styled+json", "");
    let instance =
        create_fragment_instance(&decl, r#"["Gauge",{"data-bind":"css"}]"#, &opts).unwrap();

    let mut bindings = HashMap::new();
    bindings.insert(
        "css".to_string(),
        serde_json::json!("color:red;background:url(javascript:alert(1))"),
    );

    let bound = process_tree(&instance.sanitized_tree, &bindings, &instance.profile);
    let FragmentNode::Element(gauge) = &bound.tree[0] else { panic!("expected an element") };
    let serde_json::Value::String(style) = gauge.props.get("style").unwrap() else {
        panic!("expected a string")
    };
    assert!(!style.contains("url("));
    assert!(style.contains("color:red"));
}

#[test]
fn data_if_records_visibility_without_pruning_the_node() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let source = r#"["Block",{"data-if":"alive"}]"#;
    let instance = create_fragment_instance(&decl, source, &options()).unwrap();

    let mut bindings = HashMap::new();
    bindings.insert("alive".to_string(), serde_json::json!(true));

    let bound = process_tree(&instance.sanitized_tree, &bindings, &instance.profile);
    assert_eq!(bound.visibility.get("alive"), Some(&true));
    assert_eq!(bound.tree.len(), 1);
}

#[test]
fn get_content_carries_the_tree_for_every_format() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let instance =
        create_fragment_instance(&decl, r#"["Block",{"title":"t"}]"#, &options()).unwrap();
    let result = instance.get_content(&serde_json::json!({}));

    assert_eq!(result.format, "application/x-ratatui+json");
    assert_eq!(result.content_type, FragmentContentType::Tree);
    assert_eq!(result.html, "");
    assert_eq!(result.tree.len(), 1);
}

#[test]
fn a_host_manifest_carries_its_formats_block() {
    let manifest: Manifest = serde_json::from_str(&format!(
        r#"{{ "xript": "0.8", "name": "host", "formats": {RATATUI_FORMATS} }}"#
    ))
    .unwrap();
    let declared = manifest.formats.expect("formats survive deserialization");
    assert!(declared.get("application/x-ratatui+json").is_some());
}

#[test]
fn loading_a_mod_into_an_undeclared_format_is_refused() {
    let manifest: Manifest = serde_json::from_str(
        r#"{ "xript": "0.8", "name": "host",
             "slots": [{ "id": "main", "accepts": ["application/x-ratatui+json"] }] }"#,
    )
    .unwrap();

    let mod_json = r#"{ "xript": "0.8", "name": "m", "version": "1.0.0",
        "fragments": [{ "id": "f", "slot": "main",
                        "format": "application/x-ratatui+json",
                        "source": "[\"Block\"]", "inline": true }] }"#;

    let err = xript_runtime::fragment::load_mod(
        mod_json,
        &manifest,
        &HashSet::new(),
        &HashMap::new(),
    )
    .expect_err("a host that declares no vocabulary cannot accept the fragment");
    assert!(err.to_string().contains("declare it in the host manifest's 'formats' block"));
}

#[test]
fn the_sanitized_tree_projects_into_the_published_j5ml_type() {
    let decl = declaration("f", "application/x-ratatui+json", "");
    let instance =
        create_fragment_instance(&decl, r#"["Block",{"title":"t"},"body"]"#, &options()).unwrap();

    let projected = xript_runtime::tree_to_j5ml(&instance.sanitized_tree);
    let j5ml::Node::Element(j5ml::Element { name, attrs, children }) = &projected[0] else {
        panic!("expected a tag");
    };
    assert_eq!(name, "Block");
    assert_eq!(attrs.get("title"), Some(&serde_json::Value::String("t".into())));
    assert_eq!(children, &vec![j5ml::Node::Text("body".into())]);
}
