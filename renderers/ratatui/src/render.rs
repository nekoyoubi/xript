use std::collections::HashMap;

use ratatui::layout::{Layout, Rect};
use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, Borders as RBorders, BorderType as RBorderType, Gauge, List, Paragraph, Sparkline,
};
use ratatui::Frame;
use serde_json::Value;

use crate::parser::{
    value_to_display_string, BlockProps, BorderType, Borders, GaugeProps, LineNode, SpanNode,
    WidgetNode,
};

pub fn render_fragment(
    frame: &mut Frame,
    area: Rect,
    node: &WidgetNode,
    bindings: &HashMap<String, Value>,
) {
    match node {
        WidgetNode::Block { props, children } => {
            render_block(frame, area, props, children, bindings);
        }
        WidgetNode::Paragraph { props, lines } => {
            if !evaluate_data_if(&props.data_if, bindings) {
                return;
            }
            render_paragraph(frame, area, props, lines, bindings);
        }
        WidgetNode::Gauge { props } => {
            if !evaluate_data_if(&props.data_if, bindings) {
                return;
            }
            render_gauge(frame, area, props, bindings);
        }
        WidgetNode::Layout { props, children } => {
            if !evaluate_data_if(&props.data_if, bindings) {
                return;
            }
            render_layout(frame, area, props, children, bindings);
        }
        WidgetNode::List { props, items } => {
            if !evaluate_data_if(&props.data_if, bindings) {
                return;
            }
            render_list(frame, area, props, items);
        }
        WidgetNode::Table { props, rows } => {
            if !evaluate_data_if(&props.data_if, bindings) {
                return;
            }
            render_table(frame, area, props, rows);
        }
        WidgetNode::Sparkline { props } => {
            if !evaluate_data_if(&props.data_if, bindings) {
                return;
            }
            render_sparkline(frame, area, props, bindings);
        }
        WidgetNode::Text(s) => {
            let p = Paragraph::new(s.as_str());
            frame.render_widget(p, area);
        }
    }
}

fn render_block(
    frame: &mut Frame,
    area: Rect,
    props: &BlockProps,
    children: &[WidgetNode],
    bindings: &HashMap<String, Value>,
) {
    let mut block = Block::new();

    if let Some(ref title) = props.title {
        block = block.title(title.as_str());
    }

    block = block.borders(to_ratatui_borders(props.borders));
    block = block.border_type(to_ratatui_border_type(props.border_type));
    block = block.border_style(props.border_style);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    for child in children {
        render_fragment(frame, inner, child, bindings);
    }
}

fn render_paragraph(
    frame: &mut Frame,
    area: Rect,
    props: &crate::parser::ParagraphProps,
    lines: &[LineNode],
    bindings: &HashMap<String, Value>,
) {
    let ratatui_lines: Vec<Line> = lines
        .iter()
        .map(|line_node| {
            let spans: Vec<Span> = line_node
                .spans
                .iter()
                .map(|span_node| match span_node {
                    SpanNode::Text(s) => Span::raw(s.clone()),
                    SpanNode::Styled { props, text } => {
                        let display_text = if let Some(ref bind_name) = props.data_bind {
                            bindings
                                .get(bind_name)
                                .map(value_to_display_string)
                                .unwrap_or_else(|| text.clone())
                        } else {
                            text.clone()
                        };
                        Span::styled(display_text, props.style)
                    }
                })
                .collect();
            Line::from(spans)
        })
        .collect();

    let paragraph = Paragraph::new(ratatui_lines)
        .alignment(props.alignment)
        .style(props.style);
    frame.render_widget(paragraph, area);
}

fn render_gauge(
    frame: &mut Frame,
    area: Rect,
    props: &GaugeProps,
    bindings: &HashMap<String, Value>,
) {
    let ratio = if let Some(ref rb) = props.ratio_bind {
        let num = bindings
            .get(&rb.numerator)
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let den = bindings
            .get(&rb.denominator)
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0);
        if den == 0.0 {
            0.0
        } else {
            (num / den).clamp(0.0, 1.0)
        }
    } else if let Some(ref bind_name) = props.data_bind {
        bindings
            .get(bind_name)
            .and_then(|v| v.as_f64())
            .map(|v| (v / 100.0).clamp(0.0, 1.0))
            .unwrap_or(0.0)
    } else {
        0.0
    };

    let mut gauge = Gauge::default()
        .ratio(ratio)
        .gauge_style(props.gauge_style);

    if let Some(ref label_text) = props.label {
        gauge = gauge.label(label_text.as_str());
    }

    frame.render_widget(gauge, area);
}

fn render_layout(
    frame: &mut Frame,
    area: Rect,
    props: &crate::parser::LayoutProps,
    children: &[WidgetNode],
    bindings: &HashMap<String, Value>,
) {
    let chunks = Layout::default()
        .direction(props.direction)
        .constraints(&props.constraints)
        .split(area);

    for (i, child) in children.iter().enumerate() {
        if i < chunks.len() {
            render_fragment(frame, chunks[i], child, bindings);
        }
    }
}

fn render_list(
    frame: &mut Frame,
    area: Rect,
    props: &crate::parser::ListProps,
    items: &[String],
) {
    let list_items: Vec<&str> = items.iter().map(String::as_str).collect();
    let list = List::new(list_items).style(props.style);
    frame.render_widget(list, area);
}

fn render_table(
    frame: &mut Frame,
    area: Rect,
    props: &crate::parser::TableProps,
    rows: &[Vec<String>],
) {
    use ratatui::widgets::{Row, Table};

    let table_rows: Vec<Row> = rows
        .iter()
        .map(|cells| Row::new(cells.iter().map(String::as_str).collect::<Vec<_>>()))
        .collect();

    let mut table = Table::new(table_rows, &props.widths).style(props.style);

    if let Some(ref header) = props.header {
        let header_row = Row::new(header.iter().map(String::as_str).collect::<Vec<_>>()).bold();
        table = table.header(header_row);
    }

    frame.render_widget(table, area);
}

fn render_sparkline(
    frame: &mut Frame,
    area: Rect,
    props: &crate::parser::SparklineProps,
    bindings: &HashMap<String, Value>,
) {
    let data: Vec<u64> = if let Some(ref bind_name) = props.data_bind {
        bindings
            .get(bind_name)
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_u64()).collect())
            .unwrap_or_else(|| props.data.clone())
    } else {
        props.data.clone()
    };

    let sparkline = Sparkline::default().data(&data).style(props.style);
    frame.render_widget(sparkline, area);
}

fn to_ratatui_borders(b: Borders) -> RBorders {
    match b {
        Borders::None => RBorders::NONE,
        Borders::All => RBorders::ALL,
        Borders::Top => RBorders::TOP,
        Borders::Bottom => RBorders::BOTTOM,
        Borders::Left => RBorders::LEFT,
        Borders::Right => RBorders::RIGHT,
    }
}

fn to_ratatui_border_type(bt: BorderType) -> RBorderType {
    match bt {
        BorderType::Plain => RBorderType::Plain,
        BorderType::Rounded => RBorderType::Rounded,
        BorderType::Double => RBorderType::Double,
        BorderType::Thick => RBorderType::Thick,
    }
}

fn evaluate_data_if(expr: &Option<String>, bindings: &HashMap<String, Value>) -> bool {
    let expression = match expr {
        Some(e) => e,
        None => return true,
    };

    let trimmed = expression.trim();

    if let Some(val) = bindings.get(trimmed) {
        return is_truthy(val);
    }

    if let Some(result) = try_comparison(trimmed, "<", bindings, |a, b| a < b) {
        return result;
    }
    if let Some(result) = try_comparison(trimmed, "<=", bindings, |a, b| a <= b) {
        return result;
    }
    if let Some(result) = try_comparison(trimmed, ">=", bindings, |a, b| a >= b) {
        return result;
    }
    if let Some(result) = try_comparison(trimmed, ">", bindings, |a, b| a > b) {
        return result;
    }
    if let Some(result) = try_comparison(trimmed, "!=", bindings, |a, b| (a - b).abs() >= f64::EPSILON) {
        return result;
    }
    if let Some(result) = try_comparison(trimmed, "==", bindings, |a, b| (a - b).abs() < f64::EPSILON) {
        return result;
    }

    false
}

fn try_comparison(
    expr: &str,
    op: &str,
    bindings: &HashMap<String, Value>,
    cmp: fn(f64, f64) -> bool,
) -> Option<bool> {
    let parts: Vec<&str> = expr.splitn(2, op).collect();
    if parts.len() != 2 {
        return None;
    }

    let var_name = parts[0].trim();
    let rhs_str = parts[1].trim();

    if var_name.is_empty() || rhs_str.is_empty() {
        return None;
    }

    if var_name.chars().next()?.is_ascii_digit() {
        return None;
    }

    let rhs: f64 = rhs_str.parse().ok()?;
    let lhs = bindings.get(var_name)?.as_f64()?;

    Some(cmp(lhs, rhs))
}

fn is_truthy(val: &Value) -> bool {
    match val {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |v| v != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_fragment;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use serde_json::json;

    fn render_to_test_terminal(
        node: &WidgetNode,
        bindings: &HashMap<String, Value>,
        width: u16,
        height: u16,
    ) {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                render_fragment(frame, area, node, bindings);
            })
            .unwrap();
    }

    #[test]
    fn renders_text_node_without_panic() {
        let node = WidgetNode::Text("Hello".to_string());
        render_to_test_terminal(&node, &HashMap::new(), 40, 5);
    }

    #[test]
    fn renders_block_without_panic() {
        let json = json!(["Block", {"title": "Test", "borders": "ALL", "border_type": "Rounded"}]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        render_to_test_terminal(&node, &HashMap::new(), 40, 10);
    }

    #[test]
    fn renders_paragraph_without_panic() {
        let json = json!(["Paragraph", {"alignment": "Center"},
            ["Line", {},
                ["Span", {"style": {"fg": "Green"}}, "Hello "],
                ["Span", {"style": {"fg": "White", "mod": ["BOLD"]}}, "World"]
            ]
        ]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        render_to_test_terminal(&node, &HashMap::new(), 40, 5);
    }

    #[test]
    fn renders_gauge_with_bindings() {
        let json = json!(["Gauge", {
            "ratio_bind": {"numerator": "health", "denominator": "maxHealth"},
            "gauge_style": {"fg": "Green"}
        }]);
        let mut bindings = HashMap::new();
        bindings.insert("health".to_string(), json!(75));
        bindings.insert("maxHealth".to_string(), json!(100));

        let node = parse_fragment(&json, &bindings).unwrap();
        render_to_test_terminal(&node, &bindings, 40, 3);
    }

    #[test]
    fn renders_layout_with_children() {
        let json = json!(["Layout", {
            "direction": "Vertical",
            "constraints": ["Length:1", "Length:1"]
        },
            ["Paragraph", {}, ["Line", {}, ["Span", {}, "Row 1"]]],
            ["Paragraph", {}, ["Line", {}, ["Span", {}, "Row 2"]]]
        ]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        render_to_test_terminal(&node, &HashMap::new(), 40, 5);
    }

    #[test]
    fn renders_list_without_panic() {
        let json = json!(["List", {}, "Item A", "Item B", "Item C"]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        render_to_test_terminal(&node, &HashMap::new(), 40, 5);
    }

    #[test]
    fn renders_table_without_panic() {
        let json = json!(["Table", {
            "header": ["Name", "Score"],
            "widths": ["Percentage:50", "Percentage:50"]
        },
            ["Alice", "100"],
            ["Bob", "95"]
        ]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        render_to_test_terminal(&node, &HashMap::new(), 40, 8);
    }

    #[test]
    fn renders_sparkline_without_panic() {
        let json = json!(["Sparkline", {"data": [1, 3, 5, 2, 8], "style": {"fg": "Yellow"}}]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        render_to_test_terminal(&node, &HashMap::new(), 40, 3);
    }

    #[test]
    fn data_if_hides_widget_when_false() {
        let json = json!(["Paragraph", {"data-if": "health < 50"},
            ["Line", {}, ["Span", {}, "Warning!"]]
        ]);
        let mut bindings = HashMap::new();
        bindings.insert("health".to_string(), json!(80));

        let node = parse_fragment(&json, &bindings).unwrap();

        let backend = TestBackend::new(40, 3);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                render_fragment(frame, area, &node, &bindings);
            })
            .unwrap();

        let buf = terminal.backend().buffer().clone();
        let content: String = (0..buf.area.width)
            .map(|x| buf.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(!content.contains("Warning!"));
    }

    #[test]
    fn data_if_shows_widget_when_true() {
        let json = json!(["Paragraph", {"data-if": "health < 50"},
            ["Line", {}, ["Span", {}, "Warning!"]]
        ]);
        let mut bindings = HashMap::new();
        bindings.insert("health".to_string(), json!(30));

        let node = parse_fragment(&json, &bindings).unwrap();

        let backend = TestBackend::new(40, 3);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                render_fragment(frame, area, &node, &bindings);
            })
            .unwrap();

        let buf = terminal.backend().buffer().clone();
        let content: String = (0..buf.area.width)
            .map(|x| buf.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("Warning!"));
    }

    #[test]
    fn evaluate_data_if_handles_all_comparison_operators() {
        let mut bindings = HashMap::new();
        bindings.insert("val".to_string(), json!(50));

        assert!(evaluate_data_if(&Some("val < 100".into()), &bindings));
        assert!(!evaluate_data_if(&Some("val < 10".into()), &bindings));
        assert!(evaluate_data_if(&Some("val > 10".into()), &bindings));
        assert!(!evaluate_data_if(&Some("val > 100".into()), &bindings));
        assert!(evaluate_data_if(&Some("val <= 50".into()), &bindings));
        assert!(!evaluate_data_if(&Some("val <= 49".into()), &bindings));
        assert!(evaluate_data_if(&Some("val >= 50".into()), &bindings));
        assert!(!evaluate_data_if(&Some("val >= 51".into()), &bindings));
        assert!(evaluate_data_if(&Some("val == 50".into()), &bindings));
        assert!(!evaluate_data_if(&Some("val == 51".into()), &bindings));
        assert!(evaluate_data_if(&Some("val != 51".into()), &bindings));
        assert!(!evaluate_data_if(&Some("val != 50".into()), &bindings));
    }

    #[test]
    fn evaluate_data_if_returns_true_when_none() {
        assert!(evaluate_data_if(&None, &HashMap::new()));
    }

    #[test]
    fn evaluate_data_if_truthy_binding() {
        let mut bindings = HashMap::new();
        bindings.insert("visible".to_string(), json!(true));
        assert!(evaluate_data_if(&Some("visible".into()), &bindings));

        bindings.insert("visible".to_string(), json!(false));
        assert!(!evaluate_data_if(&Some("visible".into()), &bindings));
    }

    #[test]
    fn renders_full_health_panel() {
        let json = json!(["Block", {
            "title": "Health",
            "borders": "ALL",
            "border_type": "Rounded",
            "border_style": {"fg": "Cyan"}
        },
            ["Layout", {"direction": "Vertical", "constraints": ["Length:1", "Length:1", "Length:1"]},
                ["Paragraph", {"alignment": "Left"},
                    ["Line", {},
                        ["Span", {"style": {"fg": "Gray"}}, "Player: "],
                        ["Span", {"data-bind": "name", "style": {"fg": "White", "mod": ["BOLD"]}}, "Unknown"]
                    ]
                ],
                ["Gauge", {
                    "data-bind": "health",
                    "ratio_bind": {"numerator": "health", "denominator": "maxHealth"},
                    "gauge_style": {"fg": "Green"}
                }],
                ["Paragraph", {
                    "data-if": "health < 50",
                    "alignment": "Center",
                    "style": {"fg": "Red", "mod": ["BOLD", "SLOW_BLINK"]}
                },
                    ["Line", {}, ["Span", {}, "LOW HEALTH WARNING"]]
                ]
            ]
        ]);

        let mut bindings = HashMap::new();
        bindings.insert("name".to_string(), json!("Hero"));
        bindings.insert("health".to_string(), json!(35));
        bindings.insert("maxHealth".to_string(), json!(100));

        let node = parse_fragment(&json, &bindings).unwrap();
        render_to_test_terminal(&node, &bindings, 50, 10);
    }

    #[test]
    fn gauge_clamps_ratio_to_valid_range() {
        let json = json!(["Gauge", {
            "ratio_bind": {"numerator": "health", "denominator": "maxHealth"},
            "gauge_style": {"fg": "Green"}
        }]);
        let mut bindings = HashMap::new();
        bindings.insert("health".to_string(), json!(150));
        bindings.insert("maxHealth".to_string(), json!(100));

        let node = parse_fragment(&json, &bindings).unwrap();
        render_to_test_terminal(&node, &bindings, 40, 3);
    }

    #[test]
    fn gauge_handles_zero_denominator() {
        let json = json!(["Gauge", {
            "ratio_bind": {"numerator": "health", "denominator": "maxHealth"},
            "gauge_style": {"fg": "Green"}
        }]);
        let mut bindings = HashMap::new();
        bindings.insert("health".to_string(), json!(50));
        bindings.insert("maxHealth".to_string(), json!(0));

        let node = parse_fragment(&json, &bindings).unwrap();
        render_to_test_terminal(&node, &bindings, 40, 3);
    }

    #[test]
    fn sparkline_resolves_data_bind() {
        let json = json!(["Sparkline", {"data-bind": "history", "style": {"fg": "Cyan"}}]);
        let mut bindings = HashMap::new();
        bindings.insert("history".to_string(), json!([10, 20, 30, 40]));

        let node = parse_fragment(&json, &bindings).unwrap();
        render_to_test_terminal(&node, &bindings, 40, 3);
    }
}
