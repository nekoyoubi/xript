//! Drawing: every widget reaches a frame without panicking, and what lands in the
//! cells is what the runtime bound.

mod support;
use support::{draw, rendered, rendered_bare};

#[test]
fn draws_a_text_node() {
    assert!(draw(&rendered_bare(r#"["Block",{},"Hello"]"#), 40, 5).contains("Hello"));
}

#[test]
fn draws_a_block() {
    let source = r#"["Block",{"title":"Test","borders":"ALL","border_type":"Rounded"}]"#;
    assert!(draw(&rendered_bare(source), 40, 10).contains("Test"));
}

#[test]
fn draws_a_styled_paragraph() {
    let source = r#"["Paragraph",{"alignment":"Center"},["Line",{},
        ["Span",{"style":{"fg":"Green"}},"Hello "],
        ["Span",{"style":{"fg":"White","mod":["BOLD"]}},"World"]]]"#;
    let drawn = draw(&rendered_bare(source), 40, 5);
    assert!(drawn.contains("Hello World"), "got:\n{drawn}");
}

#[test]
fn draws_a_gauge_from_a_bound_ratio() {
    let source = r#"["Gauge",{"data-bind":"health / maxHealth","gauge_style":{"fg":"Green"}}]"#;
    let fragment = rendered(source, &serde_json::json!({ "health": 75, "maxHealth": 100 }));
    assert!(draw(&fragment, 40, 3).contains("75%"));
}

#[test]
fn draws_a_layout_with_children() {
    let source = r#"["Layout",{"direction":"Vertical","constraints":["Length:1","Length:1"]},
        ["Paragraph",{},["Line",{},["Span",{},"Row 1"]]],
        ["Paragraph",{},["Line",{},["Span",{},"Row 2"]]]]"#;
    let drawn = draw(&rendered_bare(source), 40, 5);
    assert!(drawn.contains("Row 1") && drawn.contains("Row 2"), "got:\n{drawn}");
}

#[test]
fn draws_a_list() {
    let source = r#"["List",{},"Item A","Item B","Item C"]"#;
    let drawn = draw(&rendered_bare(source), 40, 5);
    assert!(drawn.contains("Item A") && drawn.contains("Item C"), "got:\n{drawn}");
}

#[test]
fn draws_a_table() {
    let source = r#"["Table",{"header":["Name","Score"],"widths":["Percentage:50","Percentage:50"]},
        ["Row",{},"Alice","100"],
        ["Row",{},"Bob","95"]]"#;
    let drawn = draw(&rendered_bare(source), 40, 8);
    assert!(drawn.contains("Alice") && drawn.contains("Name"), "got:\n{drawn}");
}

#[test]
fn draws_a_sparkline() {
    let source = r#"["Sparkline",{"data":[1,3,5,2,8],"style":{"fg":"Yellow"}}]"#;
    draw(&rendered_bare(source), 40, 3);
}

#[test]
fn draws_the_full_health_panel() {
    let source = r#"["Block",{"title":"Health","borders":"ALL","border_type":"Rounded","border_style":{"fg":"Cyan"}},
        ["Layout",{"direction":"Vertical","constraints":["Length:1","Length:1","Length:1"]},
            ["Paragraph",{"alignment":"Left"},["Line",{},
                ["Span",{"style":{"fg":"Gray"}},"Player: "],
                ["Span",{"data-bind":"name","style":{"fg":"White","mod":["BOLD"]}},"Unknown"]]],
            ["Gauge",{"data-bind":"health / maxHealth","gauge_style":{"fg":"Green"}}],
            ["Paragraph",{"data-if":"health < 50","alignment":"Center","style":{"fg":"Red","mod":["BOLD","SLOW_BLINK"]}},
                ["Line",{},["Span",{},"LOW HEALTH WARNING"]]]]]"#;

    let data = serde_json::json!({ "name": "Hero", "health": 35, "maxHealth": 100 });
    let drawn = draw(&rendered(source, &data), 50, 10);
    assert!(drawn.contains("Hero"), "expected the bound name, got:\n{drawn}");
    assert!(drawn.contains("LOW HEALTH"), "expected the visible warning, got:\n{drawn}");

    let healthy = serde_json::json!({ "name": "Hero", "health": 90, "maxHealth": 100 });
    let drawn = draw(&rendered(source, &healthy), 50, 10);
    assert!(!drawn.contains("LOW HEALTH"), "expected the warning pruned, got:\n{drawn}");
}
