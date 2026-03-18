use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::App;

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let has_result = app.result_fragment.is_some();

    let mut constraints = vec![
        Constraint::Length(1),
        Constraint::Length(1),
    ];

    if !has_result && !app.completion.suggestions.is_empty() {
        let visible_count = app.completion.suggestions.len().min(8) as u16;
        constraints.push(Constraint::Length(visible_count + 2));
    }

    if !has_result {
        constraints.push(Constraint::Length(1));
    }

    constraints.push(Constraint::Min(1));

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(&constraints)
        .split(area);

    let prompt = Paragraph::new(Line::from(vec![
        Span::styled(
            "Enter HTML/fragment to sanitize (or a file path):",
            Style::default().fg(Color::Gray),
        ),
    ]));
    frame.render_widget(prompt, chunks[0]);

    let cursor_char = if !has_result { "\u{2588}" } else { "" };
    let input_text = format!("{}{}", app.input, cursor_char);

    let input_line = Paragraph::new(Line::from(vec![
        Span::styled("> ", Style::default().fg(Color::Cyan)),
        Span::styled(input_text, Style::default().fg(Color::Cyan)),
    ]));
    frame.render_widget(input_line, chunks[1]);

    let mut next_chunk = 2;

    if !has_result && !app.completion.suggestions.is_empty() {
        render_suggestions(frame, chunks[next_chunk], &app.completion);
        next_chunk += 1;
    }

    if !has_result {
        let hint = if app.completion.suggestions.is_empty() {
            "Enter to sanitize \u{00b7} Esc to go back"
        } else {
            "Tab to complete \u{00b7} Enter to sanitize \u{00b7} Esc to go back"
        };
        let hint_para = Paragraph::new(Line::from(Span::styled(
            hint,
            Style::default().fg(Color::DarkGray),
        )));
        frame.render_widget(hint_para, chunks[next_chunk]);
        next_chunk += 1;
    }

    if let Some(ref result) = app.result_fragment {
        let text = match result.as_str() {
            Some(s) => s.to_string(),
            None => result.to_string(),
        };

        let is_success = text.starts_with('\u{2714}');
        let result_color = if is_success { Color::Green } else { Color::Red };

        let result_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(result_color))
            .title(Span::styled(
                if is_success { " Result " } else { " Error " },
                Style::default()
                    .fg(result_color)
                    .add_modifier(Modifier::BOLD),
            ));

        let result_para = Paragraph::new(text)
            .style(Style::default().fg(result_color))
            .block(result_block)
            .wrap(Wrap { trim: false });

        if next_chunk < chunks.len() {
            frame.render_widget(result_para, chunks[next_chunk]);
        }
    }
}

fn render_suggestions(
    frame: &mut Frame,
    area: Rect,
    completion: &crate::completion::CompletionState,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(Span::styled(
            " Suggestions ",
            Style::default().fg(Color::DarkGray),
        ));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let visible_max = inner.height as usize;
    let total = completion.suggestions.len();
    let selected = completion.selected;

    let start = if total <= visible_max {
        0
    } else if selected < visible_max / 2 {
        0
    } else if selected + visible_max / 2 >= total {
        total.saturating_sub(visible_max)
    } else {
        selected.saturating_sub(visible_max / 2)
    };
    let end = (start + visible_max).min(total);

    let lines: Vec<Line> = completion
        .suggestions[start..end]
        .iter()
        .enumerate()
        .map(|(i, suggestion)| {
            let actual_idx = start + i;
            let is_selected = actual_idx == selected;
            let style = if is_selected {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            let prefix = if is_selected { "> " } else { "  " };
            Line::from(Span::styled(format!("{}{}", prefix, suggestion), style))
        })
        .collect();

    let suggestions_para = Paragraph::new(lines);
    frame.render_widget(suggestions_para, inner);
}

pub fn run_sanitize(input: &str) -> serde_json::Value {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return serde_json::json!("\u{2718} No input provided");
    }

    let html_input = if std::path::Path::new(trimmed).is_file() {
        match std::fs::read_to_string(trimmed) {
            Ok(contents) => contents,
            Err(e) => return serde_json::json!(format!("\u{2718} Could not read file: {}", e)),
        }
    } else {
        trimmed.to_string()
    };

    let sanitized = xript_runtime::fragment::sanitize_html(&html_input);

    let stripped = diff_stripped(&html_input, &sanitized);

    let mut result = format!("\u{2714} Sanitized output:\n  {}", sanitized);

    if !stripped.is_empty() {
        result.push_str(&format!(
            "\n\n\u{26a0} Stripped elements/attributes:\n  {}",
            stripped.join("\n  ")
        ));
    } else {
        result.push_str("\n\n  (nothing was stripped)");
    }

    serde_json::json!(result)
}

fn diff_stripped(original: &str, sanitized: &str) -> Vec<String> {
    let mut stripped = Vec::new();

    let orig_lower = original.to_lowercase();
    let san_lower = sanitized.to_lowercase();

    let dangerous_tags = ["script", "iframe", "object", "embed", "form"];
    for tag in &dangerous_tags {
        let open = format!("<{}", tag);
        if orig_lower.contains(&open) && !san_lower.contains(&open) {
            stripped.push(format!("<{}> element removed", tag));
        }
    }

    let event_attrs = [
        "onclick",
        "onload",
        "onerror",
        "onmouseover",
        "onfocus",
        "onblur",
    ];
    for attr in &event_attrs {
        if orig_lower.contains(attr) && !san_lower.contains(attr) {
            stripped.push(format!("{} attribute removed", attr));
        }
    }

    if orig_lower.contains("javascript:") && !san_lower.contains("javascript:") {
        stripped.push("javascript: URI removed".to_string());
    }

    stripped
}
