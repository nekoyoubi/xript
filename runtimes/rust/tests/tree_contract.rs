//! `xript-tree/1`: what crosses the seam to a renderer.

use xript_runtime::fragment::{create_fragment_instance, FragmentOptions};
use xript_runtime::{FragmentDeclaration, FragmentNode};

const FORMATS: &str = r#"{
  "application/x-widget+json": {
    "syntax": "jsml",
    "nodes": {
      "Panel": { "props": { "title": { "type": "string" }, "id": { "type": "string" } } },
      "Gauge": {
        "children": "none",
        "bindTo": "ratio",
        "props": { "ratio": { "type": "number" }, "label": { "type": "string" } }
      },
      "Series": {
        "children": "none",
        "bindTo": "data",
        "props": { "data": { "type": "array" } }
      }
    }
  }
}"#;

fn options() -> FragmentOptions {
    FragmentOptions {
        formats: Some(serde_json::from_str(FORMATS).unwrap()),
        vocabularies: None,
        strict_html_vocabulary: false,
    }
}

fn rendered(source: &str, data: serde_json::Value) -> xript_runtime::RenderedFragment {
    let bindings: Vec<serde_json::Value> = data
        .as_object()
        .map(|map| {
            map.keys().map(|key| serde_json::json!({ "name": key, "path": key })).collect()
        })
        .unwrap_or_default();
    let declaration: FragmentDeclaration = serde_json::from_value(serde_json::json!({
        "id": "f",
        "slot": "main",
        "format": "application/x-widget+json",
        "source": source,
        "inline": true,
        "bindings": bindings,
    }))
    .unwrap();

    create_fragment_instance(&declaration, source, &options())
        .expect("the source sanitizes")
        .get_content(&data)
        .to_rendered()
}

#[test]
fn every_rendered_fragment_carries_the_contract_version() {
    let fragment = rendered(r#"["Panel",{}]"#, serde_json::json!({}));
    assert_eq!(fragment.contract, xript_runtime::CONTRACT_VERSION);
    assert_eq!(fragment.contract, "xript-tree/1");
}

/// Gap #2 from the contract, closed. A numeric `bindTo` prop keeps its JSON type,
/// which is what makes a gauge drawable from the tree alone.
#[test]
fn a_bound_numeric_prop_keeps_its_json_type() {
    let fragment = rendered(
        r#"["Gauge",{"data-bind":"health / maxHealth"}]"#,
        serde_json::json!({ "health": 62, "maxHealth": 100 }),
    );
    let FragmentNode::Element(gauge) = &fragment.tree[0] else { panic!("expected an element") };
    assert_eq!(gauge.props.get("ratio"), Some(&serde_json::json!(0.62)));
}

#[test]
fn a_bound_array_prop_keeps_its_json_type() {
    let fragment = rendered(
        r#"["Series",{"data-bind":"history"}]"#,
        serde_json::json!({ "history": [1, 2, 3] }),
    );
    let FragmentNode::Element(series) = &fragment.tree[0] else { panic!("expected an element") };
    assert_eq!(series.props.get("data"), Some(&serde_json::json!([1, 2, 3])));
}

/// The typed reading is scoped to what the profile asks for. A prop declared as a
/// string still gets a string, so nothing textual moved.
#[test]
fn a_bound_textual_prop_still_stringifies() {
    let fragment = rendered(
        r#"["Gauge",{"data-bind":"pct","ratio":0.1}]"#,
        serde_json::json!({ "pct": 0.5 }),
    );
    let FragmentNode::Element(gauge) = &fragment.tree[0] else { panic!("expected an element") };
    assert_eq!(gauge.props.get("ratio"), Some(&serde_json::json!(0.5)));

    let fragment = rendered(
        r#"["Panel",{"data-bind":"title"}]"#,
        serde_json::json!({ "title": 7 }),
    );
    let FragmentNode::Element(panel) = &fragment.tree[0] else { panic!("expected an element") };
    // `Panel` declares no `bindTo`, so the value lands in children as text.
    assert_eq!(panel.children, vec![FragmentNode::text("7")]);
}

#[test]
fn conditions_are_path_keyed_and_already_evaluated() {
    let fragment = rendered(
        r#"["Panel",{},["Panel",{"data-if":"health < 50"}],["Panel",{"data-if":"health < 50"}]]"#,
        serde_json::json!({ "health": 80 }),
    );
    // Two nodes carrying the same condition text stay two entries. The deprecated
    // text-keyed `visibility` map collapses them into one, which is why a renderer
    // reads `conditions`.
    assert_eq!(fragment.conditions.len(), 2);
    assert_eq!(fragment.conditions[0].path, vec![0, 0]);
    assert_eq!(fragment.conditions[1].path, vec![0, 1]);
    assert!(fragment.conditions.iter().all(|condition| !condition.visible));
    assert!(fragment.is_hidden(&[0, 1]));
    assert!(!fragment.is_hidden(&[0]));
}

/// The tree is not pruned. What "hidden" means is the renderer's decision, and the
/// protocol keeps the node addressable so a browser can pick `display:none`.
#[test]
fn an_invisible_node_stays_in_the_tree() {
    let fragment = rendered(
        r#"["Panel",{},["Panel",{"data-if":"health < 50"}]]"#,
        serde_json::json!({ "health": 80 }),
    );
    let FragmentNode::Element(panel) = &fragment.tree[0] else { panic!("expected an element") };
    assert_eq!(panel.children.len(), 1);
}

/// Gap #1 from the contract, closed. `@0.1` reaches a node that carries no `id`.
#[test]
fn a_path_targeted_op_survives_a_tree_vocabulary() {
    let profile = xript_runtime::resolve_format_profile(
        "application/x-widget+json",
        Some(&serde_json::from_str::<serde_json::Value>(FORMATS).unwrap()),
        None,
    )
    .unwrap()
    .unwrap();

    let raw = vec![serde_json::json!({
        "op": "setProp", "selector": "@0.1", "prop": "title", "value": "Live"
    })];
    let mut diagnostics = Vec::new();
    let ops = xript_runtime::finalize_ops(&raw, &profile, &mut |d| diagnostics.push(d));

    assert!(diagnostics.is_empty(), "got: {diagnostics:?}");
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].target, xript_runtime::NodeRef::Path(vec![0, 1]));
}

/// A CSS selector against a tree vocabulary is still refused, so the new grammar
/// widened the door rather than propping it open.
#[test]
fn a_selector_targeted_op_is_still_refused_by_a_tree_vocabulary() {
    let profile = xript_runtime::resolve_format_profile(
        "application/x-widget+json",
        Some(&serde_json::from_str::<serde_json::Value>(FORMATS).unwrap()),
        None,
    )
    .unwrap()
    .unwrap();

    let raw = vec![serde_json::json!({
        "op": "setProp", "selector": ".panel", "prop": "title", "value": "Live"
    })];
    let mut diagnostics = Vec::new();
    let ops = xript_runtime::finalize_ops(&raw, &profile, &mut |d| diagnostics.push(d));

    assert!(ops.is_empty());
    assert_eq!(diagnostics.len(), 1);
}

/// `setAttr` and the class ops are HTML sugar. A `xript-tree/1` consumer never
/// receives them, and an HTML host keeps the op names it has always been handed.
#[test]
fn the_contract_projection_expands_set_attr_and_drops_class_sugar() {
    let profile =
        xript_runtime::resolve_format_profile("text/html", None, None).unwrap().unwrap();

    let raw = vec![
        serde_json::json!({ "op": "setAttr", "selector": "#a", "attr": "title", "value": "x" }),
        serde_json::json!({ "op": "addClass", "selector": "#a", "value": "active" }),
        serde_json::json!({ "op": "setText", "selector": "#a", "value": "hi" }),
    ];
    let mut diagnostics = Vec::new();
    let finalized = xript_runtime::finalize_ops(&raw, &profile, &mut |d| diagnostics.push(d));
    assert_eq!(finalized.len(), 3);
    assert_eq!(finalized[0].op, "setAttr");

    let contract = xript_runtime::to_contract_ops(&finalized);
    assert_eq!(contract.len(), 2);
    assert_eq!(contract[0].op, "setProp");
    assert_eq!(contract[0].prop.as_deref(), Some("title"));
    assert_eq!(contract[0].attr, None);
    assert_eq!(contract[1].op, "setText");
}

/// A batch applies in order and the tree it lands on is the one the renderer drew.
#[test]
fn a_contract_batch_applies_to_the_bound_tree() {
    let mut fragment = rendered(
        r#"["Panel",{"id":"root"},["Panel",{}]]"#,
        serde_json::json!({}),
    );

    let profile = xript_runtime::resolve_format_profile(
        "application/x-widget+json",
        Some(&serde_json::from_str::<serde_json::Value>(FORMATS).unwrap()),
        None,
    )
    .unwrap()
    .unwrap();

    let raw = vec![
        serde_json::json!({ "op": "setProp", "selector": "#root", "prop": "title", "value": "A" }),
        serde_json::json!({ "op": "setProp", "selector": "@0.0", "prop": "title", "value": "B" }),
    ];
    let mut diagnostics = Vec::new();
    let ops = xript_runtime::to_contract_ops(&xript_runtime::finalize_ops(
        &raw,
        &profile,
        &mut |d| diagnostics.push(d),
    ));

    xript_runtime::apply_ops(&mut fragment.tree, &ops);

    let FragmentNode::Element(root) = &fragment.tree[0] else { panic!("expected an element") };
    assert_eq!(root.props.get("title"), Some(&serde_json::json!("A")));
    let FragmentNode::Element(child) = &root.children[0] else { panic!("expected an element") };
    assert_eq!(child.props.get("title"), Some(&serde_json::json!("B")));
}

#[test]
fn a_html_fragment_carries_a_tree_too() {
    let declaration: FragmentDeclaration = serde_json::from_value(serde_json::json!({
        "id": "f", "slot": "main", "format": "text/html",
        "source": "<p data-bind=\"name\">x</p>", "inline": true,
        "bindings": [{ "name": "name", "path": "name" }]
    }))
    .unwrap();
    let options = FragmentOptions::default();
    let fragment = create_fragment_instance(&declaration, "<p data-bind=\"name\">x</p>", &options)
        .unwrap()
        .get_content(&serde_json::json!({ "name": "Hero" }))
        .to_rendered();

    assert_eq!(fragment.content_type, xript_runtime::ContentType::Html);
    assert!(!fragment.tree.is_empty(), "a renderer reads `tree` even for an HTML vocabulary");
}

#[test]
fn a_binding_map_never_crosses_the_seam() {
    // There is nowhere on `RenderedFragment` to put one; this test exists so the
    // absence is asserted rather than assumed.
    let fragment = rendered(r#"["Panel",{}]"#, serde_json::json!({ "secret": "hunter2" }));
    let debug = format!("{fragment:?}");
    assert!(!debug.contains("hunter2"));
}
