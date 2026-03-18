use std::collections::HashMap;

use ratatui::layout::{Alignment, Constraint, Direction};
use ratatui::style::Style;
use serde_json::Value;

use crate::layout::{parse_constraint, parse_direction};
use crate::style::parse_style;

#[derive(Debug, Clone)]
pub struct BlockProps {
    pub title: Option<String>,
    pub borders: Borders,
    pub border_type: BorderType,
    pub border_style: Style,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Borders {
    None,
    All,
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BorderType {
    Plain,
    Rounded,
    Double,
    Thick,
}

#[derive(Debug, Clone)]
pub struct ParagraphProps {
    pub alignment: Alignment,
    pub style: Style,
    pub data_if: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpanProps {
    pub style: Style,
    pub data_bind: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LineNode {
    pub spans: Vec<SpanNode>,
}

#[derive(Debug, Clone)]
pub enum SpanNode {
    Styled { props: SpanProps, text: String },
    Text(String),
}

#[derive(Debug, Clone)]
pub struct GaugeProps {
    pub data_bind: Option<String>,
    pub ratio_bind: Option<RatioBind>,
    pub gauge_style: Style,
    pub label: Option<String>,
    pub data_if: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RatioBind {
    pub numerator: String,
    pub denominator: String,
}

#[derive(Debug, Clone)]
pub struct LayoutProps {
    pub direction: Direction,
    pub constraints: Vec<Constraint>,
    pub data_if: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ListProps {
    pub style: Style,
    pub data_if: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TableProps {
    pub header: Option<Vec<String>>,
    pub widths: Vec<Constraint>,
    pub style: Style,
    pub data_if: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SparklineProps {
    pub style: Style,
    pub data: Vec<u64>,
    pub data_bind: Option<String>,
    pub data_if: Option<String>,
}

#[derive(Debug, Clone)]
pub enum WidgetNode {
    Block {
        props: BlockProps,
        children: Vec<WidgetNode>,
    },
    Paragraph {
        props: ParagraphProps,
        lines: Vec<LineNode>,
    },
    Gauge {
        props: GaugeProps,
    },
    Layout {
        props: LayoutProps,
        children: Vec<WidgetNode>,
    },
    List {
        props: ListProps,
        items: Vec<String>,
    },
    Table {
        props: TableProps,
        rows: Vec<Vec<String>>,
    },
    Sparkline {
        props: SparklineProps,
    },
    Text(String),
}

pub fn parse_fragment(value: &Value, bindings: &HashMap<String, Value>) -> Option<WidgetNode> {
    match value {
        Value::String(s) => Some(WidgetNode::Text(s.clone())),
        Value::Array(arr) if !arr.is_empty() => {
            let tag = arr[0].as_str()?;
            let (attrs, child_start) = extract_attrs(arr);
            parse_widget(tag, &attrs, arr, child_start, bindings)
        }
        _ => None,
    }
}

fn extract_attrs(arr: &[Value]) -> (Value, usize) {
    if arr.len() > 1 {
        if let Some(obj) = arr[1].as_object() {
            return (Value::Object(obj.clone()), 2);
        }
    }
    (Value::Object(serde_json::Map::new()), 1)
}

fn parse_widget(
    tag: &str,
    attrs: &Value,
    arr: &[Value],
    child_start: usize,
    bindings: &HashMap<String, Value>,
) -> Option<WidgetNode> {
    match tag {
        "Block" => parse_block(attrs, arr, child_start, bindings),
        "Paragraph" => parse_paragraph(attrs, arr, child_start, bindings),
        "Gauge" => parse_gauge(attrs),
        "Layout" => parse_layout(attrs, arr, child_start, bindings),
        "List" => parse_list(attrs, arr, child_start),
        "Table" => parse_table(attrs, arr, child_start),
        "Sparkline" => parse_sparkline(attrs),
        _ => None,
    }
}

fn parse_block(
    attrs: &Value,
    arr: &[Value],
    child_start: usize,
    bindings: &HashMap<String, Value>,
) -> Option<WidgetNode> {
    let obj = attrs.as_object();

    let title = obj.and_then(|o| o.get("title")).and_then(|v| v.as_str()).map(String::from);
    let borders = obj
        .and_then(|o| o.get("borders"))
        .and_then(|v| v.as_str())
        .map(parse_borders)
        .unwrap_or(Borders::None);
    let border_type = obj
        .and_then(|o| o.get("border_type"))
        .and_then(|v| v.as_str())
        .map(parse_border_type)
        .unwrap_or(BorderType::Plain);
    let border_style = obj
        .and_then(|o| o.get("border_style"))
        .map(|v| parse_style(v))
        .unwrap_or_default();

    let children = parse_children(arr, child_start, bindings);

    Some(WidgetNode::Block {
        props: BlockProps {
            title,
            borders,
            border_type,
            border_style,
        },
        children,
    })
}

fn parse_paragraph(
    attrs: &Value,
    arr: &[Value],
    child_start: usize,
    bindings: &HashMap<String, Value>,
) -> Option<WidgetNode> {
    let obj = attrs.as_object();

    let alignment = obj
        .and_then(|o| o.get("alignment"))
        .and_then(|v| v.as_str())
        .map(parse_alignment)
        .unwrap_or(Alignment::Left);
    let style = obj
        .and_then(|o| o.get("style"))
        .map(|v| parse_style(v))
        .unwrap_or_default();
    let data_if = obj
        .and_then(|o| o.get("data-if"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut lines = Vec::new();
    for i in child_start..arr.len() {
        if let Some(line) = parse_line_node(&arr[i], bindings) {
            lines.push(line);
        }
    }

    Some(WidgetNode::Paragraph {
        props: ParagraphProps {
            alignment,
            style,
            data_if,
        },
        lines,
    })
}

fn parse_line_node(value: &Value, bindings: &HashMap<String, Value>) -> Option<LineNode> {
    match value {
        Value::String(s) => Some(LineNode {
            spans: vec![SpanNode::Text(s.clone())],
        }),
        Value::Array(arr) if !arr.is_empty() => {
            let tag = arr[0].as_str()?;
            if tag != "Line" {
                return None;
            }
            let (_, child_start) = extract_attrs(arr);
            let mut spans = Vec::new();
            for i in child_start..arr.len() {
                if let Some(span) = parse_span_node(&arr[i], bindings) {
                    spans.push(span);
                }
            }
            Some(LineNode { spans })
        }
        _ => None,
    }
}

fn parse_span_node(value: &Value, bindings: &HashMap<String, Value>) -> Option<SpanNode> {
    match value {
        Value::String(s) => Some(SpanNode::Text(s.clone())),
        Value::Array(arr) if !arr.is_empty() => {
            let tag = arr[0].as_str()?;
            if tag != "Span" {
                return None;
            }
            let (attrs, child_start) = extract_attrs(arr);
            let obj = attrs.as_object();

            let style = obj
                .and_then(|o| o.get("style"))
                .map(|v| parse_style(v))
                .unwrap_or_default();
            let data_bind = obj
                .and_then(|o| o.get("data-bind"))
                .and_then(|v| v.as_str())
                .map(String::from);

            let mut text = String::new();
            for i in child_start..arr.len() {
                if let Some(s) = arr[i].as_str() {
                    text.push_str(s);
                }
            }

            if let Some(ref bind_name) = data_bind {
                if let Some(val) = bindings.get(bind_name) {
                    text = value_to_display_string(val);
                }
            }

            Some(SpanNode::Styled {
                props: SpanProps { style, data_bind },
                text,
            })
        }
        _ => None,
    }
}

fn parse_gauge(attrs: &Value) -> Option<WidgetNode> {
    let obj = attrs.as_object();

    let data_bind = obj
        .and_then(|o| o.get("data-bind"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let ratio_bind = obj.and_then(|o| o.get("ratio_bind")).and_then(|v| {
        let rb = v.as_object()?;
        Some(RatioBind {
            numerator: rb.get("numerator")?.as_str()?.to_string(),
            denominator: rb.get("denominator")?.as_str()?.to_string(),
        })
    });
    let gauge_style = obj
        .and_then(|o| o.get("gauge_style"))
        .map(|v| parse_style(v))
        .unwrap_or_default();
    let label = obj
        .and_then(|o| o.get("label"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let data_if = obj
        .and_then(|o| o.get("data-if"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(WidgetNode::Gauge {
        props: GaugeProps {
            data_bind,
            ratio_bind,
            gauge_style,
            label,
            data_if,
        },
    })
}

fn parse_layout(
    attrs: &Value,
    arr: &[Value],
    child_start: usize,
    bindings: &HashMap<String, Value>,
) -> Option<WidgetNode> {
    let obj = attrs.as_object();

    let direction = obj
        .and_then(|o| o.get("direction"))
        .and_then(|v| v.as_str())
        .map(parse_direction)
        .unwrap_or(Direction::Vertical);

    let constraints = obj
        .and_then(|o| o.get("constraints"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().and_then(parse_constraint))
                .collect()
        })
        .unwrap_or_default();

    let data_if = obj
        .and_then(|o| o.get("data-if"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let children = parse_children(arr, child_start, bindings);

    Some(WidgetNode::Layout {
        props: LayoutProps {
            direction,
            constraints,
            data_if,
        },
        children,
    })
}

fn parse_list(attrs: &Value, arr: &[Value], child_start: usize) -> Option<WidgetNode> {
    let obj = attrs.as_object();

    let style = obj
        .and_then(|o| o.get("style"))
        .map(|v| parse_style(v))
        .unwrap_or_default();
    let data_if = obj
        .and_then(|o| o.get("data-if"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let items: Vec<String> = (child_start..arr.len())
        .filter_map(|i| arr[i].as_str().map(String::from))
        .collect();

    Some(WidgetNode::List {
        props: ListProps { style, data_if },
        items,
    })
}

fn parse_table(attrs: &Value, arr: &[Value], child_start: usize) -> Option<WidgetNode> {
    let obj = attrs.as_object();

    let header = obj.and_then(|o| o.get("header")).and_then(|v| {
        v.as_array().map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
    });
    let widths = obj
        .and_then(|o| o.get("widths"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().and_then(parse_constraint))
                .collect()
        })
        .unwrap_or_default();
    let style = obj
        .and_then(|o| o.get("style"))
        .map(|v| parse_style(v))
        .unwrap_or_default();
    let data_if = obj
        .and_then(|o| o.get("data-if"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let rows: Vec<Vec<String>> = (child_start..arr.len())
        .filter_map(|i| {
            arr[i].as_array().map(|row| {
                row.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
        })
        .collect();

    Some(WidgetNode::Table {
        props: TableProps {
            header,
            widths,
            style,
            data_if,
        },
        rows,
    })
}

fn parse_sparkline(attrs: &Value) -> Option<WidgetNode> {
    let obj = attrs.as_object();

    let style = obj
        .and_then(|o| o.get("style"))
        .map(|v| parse_style(v))
        .unwrap_or_default();
    let data = obj
        .and_then(|o| o.get("data"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    let data_bind = obj
        .and_then(|o| o.get("data-bind"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let data_if = obj
        .and_then(|o| o.get("data-if"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(WidgetNode::Sparkline {
        props: SparklineProps {
            style,
            data,
            data_bind,
            data_if,
        },
    })
}

fn parse_children(
    arr: &[Value],
    child_start: usize,
    bindings: &HashMap<String, Value>,
) -> Vec<WidgetNode> {
    (child_start..arr.len())
        .filter_map(|i| parse_fragment(&arr[i], bindings))
        .collect()
}

fn parse_borders(s: &str) -> Borders {
    match s {
        "ALL" => Borders::All,
        "TOP" => Borders::Top,
        "BOTTOM" => Borders::Bottom,
        "LEFT" => Borders::Left,
        "RIGHT" => Borders::Right,
        "NONE" => Borders::None,
        _ => Borders::None,
    }
}

fn parse_border_type(s: &str) -> BorderType {
    match s {
        "Plain" => BorderType::Plain,
        "Rounded" => BorderType::Rounded,
        "Double" => BorderType::Double,
        "Thick" => BorderType::Thick,
        _ => BorderType::Plain,
    }
}

fn parse_alignment(s: &str) -> Alignment {
    match s {
        "Left" => Alignment::Left,
        "Center" => Alignment::Center,
        "Right" => Alignment::Right,
        _ => Alignment::Left,
    }
}

pub fn value_to_display_string(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_text_node() {
        let node = parse_fragment(&json!("hello"), &HashMap::new());
        assert!(matches!(node, Some(WidgetNode::Text(ref s)) if s == "hello"));
    }

    #[test]
    fn parses_block_with_title() {
        let json = json!(["Block", {"title": "Health", "borders": "ALL"}]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Block { props, children } => {
                assert_eq!(props.title.as_deref(), Some("Health"));
                assert_eq!(props.borders, Borders::All);
                assert!(children.is_empty());
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parses_block_with_rounded_border() {
        let json = json!(["Block", {"border_type": "Rounded"}]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Block { props, .. } => {
                assert_eq!(props.border_type, BorderType::Rounded);
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parses_paragraph_with_lines() {
        let json = json!(["Paragraph", {"alignment": "Center"},
            ["Line", {},
                ["Span", {"style": {"fg": "Green"}}, "hello"]
            ]
        ]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Paragraph { props, lines } => {
                assert_eq!(props.alignment, Alignment::Center);
                assert_eq!(lines.len(), 1);
                assert_eq!(lines[0].spans.len(), 1);
            }
            _ => panic!("expected Paragraph"),
        }
    }

    #[test]
    fn parses_gauge_with_ratio_bind() {
        let json = json!(["Gauge", {
            "data-bind": "health",
            "ratio_bind": {"numerator": "health", "denominator": "maxHealth"},
            "gauge_style": {"fg": "Green"}
        }]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Gauge { props } => {
                assert_eq!(props.data_bind.as_deref(), Some("health"));
                let rb = props.ratio_bind.unwrap();
                assert_eq!(rb.numerator, "health");
                assert_eq!(rb.denominator, "maxHealth");
            }
            _ => panic!("expected Gauge"),
        }
    }

    #[test]
    fn parses_layout_with_constraints() {
        let json = json!(["Layout", {
            "direction": "Vertical",
            "constraints": ["Length:1", "Length:2", "Fill:1"]
        }]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Layout { props, .. } => {
                assert_eq!(props.direction, Direction::Vertical);
                assert_eq!(props.constraints.len(), 3);
            }
            _ => panic!("expected Layout"),
        }
    }

    #[test]
    fn parses_list_items() {
        let json = json!(["List", {"style": {"fg": "White"}}, "Item 1", "Item 2", "Item 3"]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::List { props: _, items } => {
                assert_eq!(items, vec!["Item 1", "Item 2", "Item 3"]);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn parses_table_with_header_and_rows() {
        let json = json!(["Table", {
            "header": ["Name", "Value"],
            "widths": ["Percentage:50", "Percentage:50"]
        },
            ["Alice", "100"],
            ["Bob", "200"]
        ]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Table { props, rows } => {
                assert_eq!(props.header.as_ref().unwrap(), &["Name", "Value"]);
                assert_eq!(props.widths.len(), 2);
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0], vec!["Alice", "100"]);
            }
            _ => panic!("expected Table"),
        }
    }

    #[test]
    fn parses_sparkline_with_data() {
        let json = json!(["Sparkline", {
            "data": [1, 3, 5, 2, 8],
            "style": {"fg": "Yellow"}
        }]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Sparkline { props } => {
                assert_eq!(props.data, vec![1, 3, 5, 2, 8]);
            }
            _ => panic!("expected Sparkline"),
        }
    }

    #[test]
    fn resolves_data_bind_on_span() {
        let mut bindings = HashMap::new();
        bindings.insert("name".to_string(), json!("Hero"));

        let json = json!(["Paragraph", {},
            ["Line", {},
                ["Span", {"data-bind": "name"}, "Unknown"]
            ]
        ]);
        let node = parse_fragment(&json, &bindings).unwrap();
        match node {
            WidgetNode::Paragraph { lines, .. } => {
                match &lines[0].spans[0] {
                    SpanNode::Styled { text, .. } => assert_eq!(text, "Hero"),
                    _ => panic!("expected Styled span"),
                }
            }
            _ => panic!("expected Paragraph"),
        }
    }

    #[test]
    fn preserves_data_if_expression() {
        let json = json!(["Paragraph", {"data-if": "health < 50"},
            ["Line", {}, ["Span", {}, "Warning!"]]
        ]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Paragraph { props, .. } => {
                assert_eq!(props.data_if.as_deref(), Some("health < 50"));
            }
            _ => panic!("expected Paragraph"),
        }
    }

    #[test]
    fn parses_nested_block_with_layout() {
        let json = json!(["Block", {"title": "Panel", "borders": "ALL"},
            ["Layout", {"direction": "Vertical", "constraints": ["Length:1"]},
                ["Paragraph", {}, ["Line", {}, ["Span", {}, "Content"]]]
            ]
        ]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::Block { children, .. } => {
                assert_eq!(children.len(), 1);
                assert!(matches!(children[0], WidgetNode::Layout { .. }));
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn returns_none_for_unknown_widget() {
        let json = json!(["UnknownWidget", {}]);
        assert!(parse_fragment(&json, &HashMap::new()).is_none());
    }

    #[test]
    fn returns_none_for_empty_array() {
        let json = json!([]);
        assert!(parse_fragment(&json, &HashMap::new()).is_none());
    }

    #[test]
    fn returns_none_for_number() {
        let json = json!(42);
        assert!(parse_fragment(&json, &HashMap::new()).is_none());
    }

    #[test]
    fn parses_widget_without_attrs_object() {
        let json = json!(["List", "Item 1", "Item 2"]);
        let node = parse_fragment(&json, &HashMap::new()).unwrap();
        match node {
            WidgetNode::List { items, .. } => {
                assert_eq!(items, vec!["Item 1", "Item 2"]);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn value_to_display_string_handles_types() {
        assert_eq!(value_to_display_string(&json!("hello")), "hello");
        assert_eq!(value_to_display_string(&json!(42)), "42");
        assert_eq!(value_to_display_string(&json!(null)), "");
        assert_eq!(value_to_display_string(&json!(true)), "true");
    }
}
