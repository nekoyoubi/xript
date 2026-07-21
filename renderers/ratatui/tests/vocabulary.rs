//! The Ratatui vocabulary, node by node: what each declared name builds.
//!
//! Every case drives a JSML source through `xript-runtime` and asserts on the
//! widget tree the renderer built from the bound result. Nothing here constructs a
//! tree by hand, and nothing here supplies a bindings map -- the renderer's API
//! has no place to put one.

use ratatui::layout::{Alignment, Direction};
use xript_ratatui::parser::{
    build_widgets, BorderType, Borders, LineNode, SpanNode, WidgetNode,
};

mod support;
use support::{draw, rendered, rendered_bare};

fn only(source: &str) -> WidgetNode {
    let fragment = rendered_bare(source);
    build_widgets(&fragment).into_iter().next().expect("the source built a widget")
}

fn only_with(source: &str, data: serde_json::Value) -> Option<WidgetNode> {
    let fragment = rendered(source, &data);
    build_widgets(&fragment).into_iter().next()
}

#[test]
fn builds_a_block_with_a_title() {
    match only(r#"["Block",{"title":"Health","borders":"ALL"}]"#) {
        WidgetNode::Block { props, children } => {
            assert_eq!(props.title.as_deref(), Some("Health"));
            assert_eq!(props.borders, Borders::All);
            assert!(children.is_empty());
        }
        other => panic!("expected Block, got {other:?}"),
    }
}

#[test]
fn builds_a_block_with_a_rounded_border() {
    match only(r#"["Block",{"border_type":"Rounded"}]"#) {
        WidgetNode::Block { props, .. } => assert_eq!(props.border_type, BorderType::Rounded),
        other => panic!("expected Block, got {other:?}"),
    }
}

#[test]
fn builds_a_paragraph_with_lines() {
    let source = r#"["Paragraph",{"alignment":"Center"},["Line",{},["Span",{"style":{"fg":"Green"}},"hello"]]]"#;
    match only(source) {
        WidgetNode::Paragraph { props, lines } => {
            assert_eq!(props.alignment, Alignment::Center);
            assert_eq!(lines.len(), 1);
            assert_eq!(lines[0].spans.len(), 1);
            assert_eq!(span_text(&lines[0]), "hello");
        }
        other => panic!("expected Paragraph, got {other:?}"),
    }
}

#[test]
fn builds_a_layout_with_constraints() {
    let source = r#"["Layout",{"direction":"Vertical","constraints":["Length:1","Length:2","Fill:1"]}]"#;
    match only(source) {
        WidgetNode::Layout { props, .. } => {
            assert_eq!(props.direction, Direction::Vertical);
            assert_eq!(props.constraints.len(), 3);
        }
        other => panic!("expected Layout, got {other:?}"),
    }
}

#[test]
fn builds_list_items_from_text_children() {
    match only(r#"["List",{"style":{"fg":"White"}},"Item 1","Item 2","Item 3"]"#) {
        WidgetNode::List { items, .. } => assert_eq!(items, vec!["Item 1", "Item 2", "Item 3"]),
        other => panic!("expected List, got {other:?}"),
    }
}

/// A row is a `Row` node rather than a bare nested array. A bare array is not a
/// J5ML node -- `["Alice","100"]` reads as an element named `Alice` -- so it could
/// never survive a vocabulary walk, and the shape the old parser accepted was
/// unreachable from any runtime.
#[test]
fn builds_table_rows_from_row_nodes() {
    let source = r#"["Table",{"header":["Name","Value"],"widths":["Percentage:50","Percentage:50"]},
        ["Row",{},"Alice","100"],
        ["Row",{},"Bob","200"]]"#;
    match only(source) {
        WidgetNode::Table { props, rows } => {
            assert_eq!(props.header.as_ref().unwrap(), &["Name", "Value"]);
            assert_eq!(props.widths.len(), 2);
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0], vec!["Alice", "100"]);
        }
        other => panic!("expected Table, got {other:?}"),
    }
}

#[test]
fn builds_a_sparkline_from_authored_data() {
    match only(r#"["Sparkline",{"data":[1,3,5,2,8],"style":{"fg":"Yellow"}}]"#) {
        WidgetNode::Sparkline { props } => assert_eq!(props.data, vec![1, 3, 5, 2, 8]),
        other => panic!("expected Sparkline, got {other:?}"),
    }
}

#[test]
fn builds_a_text_node() {
    let fragment = rendered_bare(r#"["Block",{},"hello"]"#);
    match build_widgets(&fragment).into_iter().next().unwrap() {
        WidgetNode::Block { children, .. } => {
            assert!(matches!(&children[0], WidgetNode::Text(s) if s == "hello"));
        }
        other => panic!("expected Block, got {other:?}"),
    }
}

/// A node the vocabulary never declared never reaches the renderer -- it is
/// refused at load, in the runtime, against the host's own profile. This is the
/// stop line from the other side: the renderer has no allow-list and needs none.
#[test]
fn refuses_a_node_the_vocabulary_never_declared() {
    assert!(support::try_rendered(r#"["Block",{},["UnknownWidget",{}]]"#).is_err());
}

#[test]
fn nests_a_layout_inside_a_block() {
    let source = r#"["Block",{"title":"Panel","borders":"ALL"},
        ["Layout",{"direction":"Vertical","constraints":["Length:1"]},
            ["Paragraph",{},["Line",{},["Span",{},"Content"]]]]]"#;
    match only(source) {
        WidgetNode::Block { children, .. } => {
            assert_eq!(children.len(), 1);
            assert!(matches!(children[0], WidgetNode::Layout { .. }));
        }
        other => panic!("expected Block, got {other:?}"),
    }
}

// --- what the runtime resolved, not the renderer ---

#[test]
fn a_bound_span_arrives_already_resolved() {
    let source = r#"["Paragraph",{},["Line",{},["Span",{"data-bind":"name"},"Unknown"]]]"#;
    let widget = only_with(source, serde_json::json!({ "name": "Hero" })).unwrap();
    match widget {
        WidgetNode::Paragraph { lines, .. } => assert_eq!(span_text(&lines[0]), "Hero"),
        other => panic!("expected Paragraph, got {other:?}"),
    }
}

#[test]
fn an_unbound_span_keeps_its_authored_fallback() {
    let source = r#"["Paragraph",{},["Line",{},["Span",{"data-bind":"name"},"Unknown"]]]"#;
    let widget = only_with(source, serde_json::json!({})).unwrap();
    match widget {
        WidgetNode::Paragraph { lines, .. } => assert_eq!(span_text(&lines[0]), "Unknown"),
        other => panic!("expected Paragraph, got {other:?}"),
    }
}

/// The typed-value guarantee, end to end: `data-bind` on a Gauge lands in the
/// vocabulary's `bindTo` prop as a number, and the renderer reads a number.
#[test]
fn a_gauge_ratio_arrives_as_a_number() {
    let source = r#"["Gauge",{"data-bind":"health / maxHealth","gauge_style":{"fg":"Green"}}]"#;
    let widget =
        only_with(source, serde_json::json!({ "health": 75, "maxHealth": 100 })).unwrap();
    match widget {
        WidgetNode::Gauge { props } => assert!((props.ratio - 0.75).abs() < 1e-9),
        other => panic!("expected Gauge, got {other:?}"),
    }
}

#[test]
fn a_gauge_ratio_is_clamped() {
    let source = r#"["Gauge",{"data-bind":"health / maxHealth"}]"#;
    let widget =
        only_with(source, serde_json::json!({ "health": 150, "maxHealth": 100 })).unwrap();
    match widget {
        WidgetNode::Gauge { props } => assert_eq!(props.ratio, 1.0),
        other => panic!("expected Gauge, got {other:?}"),
    }
}

/// A zero denominator is `Infinity` in the expression grammar, not a renderer
/// special case. It clamps like anything else, and the renderer has no division
/// in it to guard.
#[test]
fn a_gauge_survives_a_zero_denominator() {
    let source = r#"["Gauge",{"data-bind":"health / maxHealth"}]"#;
    let widget = only_with(source, serde_json::json!({ "health": 50, "maxHealth": 0 })).unwrap();
    match widget {
        WidgetNode::Gauge { props } => assert!(props.ratio.is_finite()),
        other => panic!("expected Gauge, got {other:?}"),
    }
}

#[test]
fn a_bound_sparkline_series_arrives_as_an_array() {
    let source = r#"["Sparkline",{"data-bind":"history","style":{"fg":"Cyan"}}]"#;
    let widget = only_with(source, serde_json::json!({ "history": [10, 20, 30, 40] })).unwrap();
    match widget {
        WidgetNode::Sparkline { props } => assert_eq!(props.data, vec![10, 20, 30, 40]),
        other => panic!("expected Sparkline, got {other:?}"),
    }
}

// --- visibility: a path lookup, never an evaluation ---

#[test]
fn a_false_condition_prunes_its_node() {
    let source = r#"["Paragraph",{"data-if":"health < 50"},["Line",{},["Span",{},"Warning!"]]]"#;
    let fragment = rendered(source, &serde_json::json!({ "health": 80 }));
    assert!(!draw(&fragment, 40, 3).contains("Warning!"));
}

#[test]
fn a_true_condition_draws_its_node() {
    let source = r#"["Paragraph",{"data-if":"health < 50"},["Line",{},["Span",{},"Warning!"]]]"#;
    let fragment = rendered(source, &serde_json::json!({ "health": 30 }));
    assert!(draw(&fragment, 40, 3).contains("Warning!"));
}

/// A `data-if` on an ancestor hides the whole subtree, which is why the lookup is
/// a path *prefix* match and not an equality one.
#[test]
fn a_false_condition_prunes_the_whole_subtree() {
    let source = r#"["Block",{"data-if":"alive"},["Paragraph",{},["Line",{},["Span",{},"Inside"]]]]"#;
    let fragment = rendered(source, &serde_json::json!({ "alive": false }));
    assert!(!draw(&fragment, 40, 5).contains("Inside"));

    let fragment = rendered(source, &serde_json::json!({ "alive": true }));
    assert!(draw(&fragment, 40, 5).contains("Inside"));
}

/// The whole reason the renderer stopped evaluating: a compound condition. The
/// renderer never parses this string, so it cannot disagree with a browser about
/// what it means.
#[test]
fn a_compound_condition_agrees_with_every_other_runtime() {
    let source = r#"["Paragraph",{"data-if":"alive && health < 50"},["Line",{},["Span",{},"Hurt"]]]"#;

    let fragment = rendered(source, &serde_json::json!({ "alive": true, "health": 30 }));
    assert!(draw(&fragment, 40, 3).contains("Hurt"));

    let fragment = rendered(source, &serde_json::json!({ "alive": false, "health": 30 }));
    assert!(!draw(&fragment, 40, 3).contains("Hurt"));
}

/// Interpolation is resolved before the tree leaves the runtime. The renderer has
/// no segment structure to walk, and printing a text node's value is correct.
#[test]
fn interpolation_arrives_resolved() {
    let source = r#"["Paragraph",{},["Line",{},["Span",{},"HP: {{ health }}"]]]"#;
    let declaration = serde_json::json!({
        "id": "interp",
        "slot": "main",
        "format": "application/x-ratatui+json",
        "source": source,
        "inline": true,
        "interpolate": true,
        "bindings": [{ "name": "health", "path": "health" }]
    });
    let fragment =
        support::rendered_with_declaration(source, declaration, &serde_json::json!({ "health": 42 }));
    assert!(draw(&fragment, 40, 3).contains("HP: 42"));
}

// --- the contract itself ---

#[test]
fn the_runtime_stamps_the_contract_version() {
    assert_eq!(rendered_bare(r#"["Block",{}]"#).contract, xript_ratatui::CONTRACT_VERSION);
}

#[test]
fn an_unrecognized_contract_is_refused_rather_than_guessed() {
    let mut fragment = rendered_bare(r#"["Block",{"title":"Health"}]"#);
    fragment.contract = "xript-tree/99";
    let drawn = draw(&fragment, 60, 3);
    assert!(drawn.contains("unsupported fragment contract"), "got:\n{drawn}");
    assert!(!drawn.contains("Health"), "a refused contract must draw nothing of the tree");
}

fn span_text(line: &LineNode) -> String {
    line.spans
        .iter()
        .map(|span| match span {
            SpanNode::Text(s) => s.clone(),
            SpanNode::Styled { text, .. } => text.clone(),
        })
        .collect()
}
