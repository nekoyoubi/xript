//! Drawing. A tree-walk and a switch statement, which is the point.

use ratatui::layout::{Layout, Rect};
use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType as RBorderType, Borders as RBorders, Gauge, List, Paragraph, Sparkline,
};
use ratatui::Frame;

use crate::parser::{
    BlockProps, BorderType, Borders, GaugeProps, LineNode, SpanNode, WidgetNode,
};

pub fn render_widget_node(frame: &mut Frame, area: Rect, node: &WidgetNode) {
    match node {
        WidgetNode::Block { props, children } => render_block(frame, area, props, children),
        WidgetNode::Paragraph { props, lines } => render_paragraph(frame, area, props, lines),
        WidgetNode::Gauge { props } => render_gauge(frame, area, props),
        WidgetNode::Layout { props, children } => render_layout(frame, area, props, children),
        WidgetNode::List { props, items } => render_list(frame, area, props, items),
        WidgetNode::Table { props, rows } => render_table(frame, area, props, rows),
        WidgetNode::Sparkline { props } => render_sparkline(frame, area, props),
        WidgetNode::Text(s) => {
            frame.render_widget(Paragraph::new(s.as_str()), area);
        }
    }
}

fn render_block(frame: &mut Frame, area: Rect, props: &BlockProps, children: &[WidgetNode]) {
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
        render_widget_node(frame, inner, child);
    }
}

fn render_paragraph(
    frame: &mut Frame,
    area: Rect,
    props: &crate::parser::ParagraphProps,
    lines: &[LineNode],
) {
    let ratatui_lines: Vec<Line> = lines
        .iter()
        .map(|line_node| {
            let spans: Vec<Span> = line_node
                .spans
                .iter()
                .map(|span_node| match span_node {
                    SpanNode::Text(s) => Span::raw(s.clone()),
                    SpanNode::Styled { props, text } => Span::styled(text.clone(), props.style),
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

fn render_gauge(frame: &mut Frame, area: Rect, props: &GaugeProps) {
    let mut gauge = Gauge::default().ratio(props.ratio).gauge_style(props.gauge_style);

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
) {
    let chunks = Layout::default()
        .direction(props.direction)
        .constraints(&props.constraints)
        .split(area);

    for (i, child) in children.iter().enumerate() {
        if i < chunks.len() {
            render_widget_node(frame, chunks[i], child);
        }
    }
}

fn render_list(frame: &mut Frame, area: Rect, props: &crate::parser::ListProps, items: &[String]) {
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

fn render_sparkline(frame: &mut Frame, area: Rect, props: &crate::parser::SparklineProps) {
    let sparkline = Sparkline::default().data(&props.data).style(props.style);
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
