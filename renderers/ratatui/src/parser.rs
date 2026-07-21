//! The Ratatui vocabulary: what each declared node name *means*.
//!
//! xript owns node shape; this file owns node meaning. Everything here is the
//! mapping from a name and a prop value that a `xript-tree/1` tree already
//! validated onto the Ratatui type it stands for -- `"ALL"` to
//! [`ratatui::widgets::Borders::ALL`], `"Length:1"` to a [`Constraint`]. None of
//! it belongs in xript, and xript contains the string `"Gauge"` nowhere.
//!
//! What this file does *not* do is resolve anything. There is no bindings map, no
//! expression, and no visibility decision here: the tree arrives bound,
//! interpolation-resolved, and visibility-evaluated, and a hidden subtree is
//! dropped by a path lookup against `conditions` before any of this runs.

use ratatui::layout::{Alignment, Constraint, Direction};
use ratatui::style::Style;
use serde_json::Value;
use xript_tree::{FragmentElement, FragmentNode, RenderedFragment};

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
}

#[derive(Debug, Clone)]
pub struct SpanProps {
    pub style: Style,
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
    /// The gauge's fill, already resolved. A `data-bind` on a Gauge lands here
    /// through the vocabulary's `bindTo`, and it lands as a number.
    pub ratio: f64,
    pub gauge_style: Style,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LayoutProps {
    pub direction: Direction,
    pub constraints: Vec<Constraint>,
}

#[derive(Debug, Clone)]
pub struct ListProps {
    pub style: Style,
}

#[derive(Debug, Clone)]
pub struct TableProps {
    pub header: Option<Vec<String>>,
    pub widths: Vec<Constraint>,
    pub style: Style,
}

#[derive(Debug, Clone)]
pub struct SparklineProps {
    pub style: Style,
    pub data: Vec<u64>,
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

/// Builds the widget tree a frame draws, dropping hidden subtrees on the way.
///
/// Pruning is the renderer's call -- the protocol deliberately leaves the tree
/// intact so a browser can pick `display:none` and a screen reader can pick
/// `aria-hidden` -- but the *decision* is read, never recomputed.
pub fn build_widgets(fragment: &RenderedFragment) -> Vec<WidgetNode> {
    fragment
        .tree
        .iter()
        .enumerate()
        .filter_map(|(index, node)| build_node(fragment, node, &[index]))
        .collect()
}

fn build_node(
    fragment: &RenderedFragment,
    node: &FragmentNode,
    path: &[usize],
) -> Option<WidgetNode> {
    if fragment.is_hidden(path) {
        return None;
    }
    match node {
        FragmentNode::Text { value, .. } => Some(WidgetNode::Text(value.clone())),
        FragmentNode::Element(element) => build_widget(fragment, element, path),
    }
}

fn build_widget(
    fragment: &RenderedFragment,
    element: &FragmentElement,
    path: &[usize],
) -> Option<WidgetNode> {
    match element.name.as_str() {
        "Block" => Some(WidgetNode::Block {
            props: BlockProps {
                title: element.props.get_str("title").map(String::from),
                borders: element
                    .props
                    .get_str("borders")
                    .map(parse_borders)
                    .unwrap_or(Borders::None),
                border_type: element
                    .props
                    .get_str("border_type")
                    .map(parse_border_type)
                    .unwrap_or(BorderType::Plain),
                border_style: element.props.get("border_style").map(parse_style).unwrap_or_default(),
            },
            children: build_children(fragment, element, path),
        }),
        "Paragraph" => Some(WidgetNode::Paragraph {
            props: ParagraphProps {
                alignment: element
                    .props
                    .get_str("alignment")
                    .map(parse_alignment)
                    .unwrap_or(Alignment::Left),
                style: element.props.get("style").map(parse_style).unwrap_or_default(),
            },
            lines: element
                .children
                .iter()
                .enumerate()
                .filter_map(|(index, child)| {
                    let mut child_path = path.to_vec();
                    child_path.push(index);
                    build_line(fragment, child, &child_path)
                })
                .collect(),
        }),
        "Gauge" => Some(WidgetNode::Gauge {
            props: GaugeProps {
                ratio: element.props.get_f64("ratio").unwrap_or(0.0).clamp(0.0, 1.0),
                gauge_style: element.props.get("gauge_style").map(parse_style).unwrap_or_default(),
                label: element.props.get_str("label").map(String::from),
            },
        }),
        "Layout" => Some(WidgetNode::Layout {
            props: LayoutProps {
                direction: element
                    .props
                    .get_str("direction")
                    .map(parse_direction)
                    .unwrap_or(Direction::Vertical),
                constraints: string_list(element.props.get("constraints"))
                    .iter()
                    .filter_map(|value| parse_constraint(value))
                    .collect(),
            },
            children: build_children(fragment, element, path),
        }),
        "List" => Some(WidgetNode::List {
            props: ListProps {
                style: element.props.get("style").map(parse_style).unwrap_or_default(),
            },
            items: element.children.iter().filter_map(text_of).collect(),
        }),
        "Table" => Some(WidgetNode::Table {
            props: TableProps {
                header: element.props.get("header").map(|value| string_list(Some(value))),
                widths: string_list(element.props.get("widths"))
                    .iter()
                    .filter_map(|value| parse_constraint(value))
                    .collect(),
                style: element.props.get("style").map(parse_style).unwrap_or_default(),
            },
            rows: element
                .children
                .iter()
                .filter_map(|child| child.as_element())
                .filter(|row| row.name == "Row")
                .map(|row| row.children.iter().filter_map(text_of).collect())
                .collect(),
        }),
        "Sparkline" => Some(WidgetNode::Sparkline {
            props: SparklineProps {
                style: element.props.get("style").map(parse_style).unwrap_or_default(),
                data: number_list(element.props.get("data")),
            },
        }),
        _ => None,
    }
}

fn build_children(
    fragment: &RenderedFragment,
    element: &FragmentElement,
    path: &[usize],
) -> Vec<WidgetNode> {
    element
        .children
        .iter()
        .enumerate()
        .filter_map(|(index, child)| {
            let mut child_path = path.to_vec();
            child_path.push(index);
            build_node(fragment, child, &child_path)
        })
        .collect()
}

fn build_line(
    fragment: &RenderedFragment,
    node: &FragmentNode,
    path: &[usize],
) -> Option<LineNode> {
    if fragment.is_hidden(path) {
        return None;
    }
    match node {
        FragmentNode::Text { value, .. } => Some(LineNode {
            spans: vec![SpanNode::Text(value.clone())],
        }),
        FragmentNode::Element(element) if element.name == "Line" => Some(LineNode {
            spans: element
                .children
                .iter()
                .enumerate()
                .filter_map(|(index, child)| {
                    let mut child_path = path.to_vec();
                    child_path.push(index);
                    build_span(fragment, child, &child_path)
                })
                .collect(),
        }),
        FragmentNode::Element(_) => None,
    }
}

fn build_span(
    fragment: &RenderedFragment,
    node: &FragmentNode,
    path: &[usize],
) -> Option<SpanNode> {
    if fragment.is_hidden(path) {
        return None;
    }
    match node {
        FragmentNode::Text { value, .. } => Some(SpanNode::Text(value.clone())),
        FragmentNode::Element(element) if element.name == "Span" => Some(SpanNode::Styled {
            props: SpanProps {
                style: element.props.get("style").map(parse_style).unwrap_or_default(),
            },
            // A Span's text is whatever its children say it is. `data-bind` already
            // wrote through them, upstream, once.
            text: element.children.iter().filter_map(text_of).collect(),
        }),
        FragmentNode::Element(_) => None,
    }
}

fn text_of(node: &FragmentNode) -> Option<String> {
    node.text_value().map(String::from)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn number_list(value: Option<&Value>) -> Vec<u64> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_default()
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
