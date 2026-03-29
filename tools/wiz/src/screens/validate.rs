use std::path::Path;

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

    let cwd = crate::completion::current_dir_display();
    let cwd_line = Paragraph::new(Line::from(vec![
        Span::styled("cwd: ", Style::default().fg(Color::DarkGray)),
        Span::styled(&cwd, Style::default().fg(Color::DarkGray)),
    ]));
    frame.render_widget(cwd_line, chunks[0]);

    let prompt = Paragraph::new(Line::from(vec![
        Span::styled(
            "Enter path to a manifest file:",
            Style::default().fg(Color::Gray),
        ),
    ]));
    frame.render_widget(prompt, chunks[1]);

    let cursor_char = if !has_result { "\u{2588}" } else { "" };
    let input_text = format!("{}{}", app.input, cursor_char);

    let path_exists = !app.input.is_empty() && crate::completion::path_exists(&app.input);
    let input_color = if has_result {
        Color::White
    } else if app.input.is_empty() {
        Color::Cyan
    } else if path_exists {
        Color::Green
    } else {
        Color::Yellow
    };

    let input_line = Paragraph::new(Line::from(vec![
        Span::styled("> ", Style::default().fg(Color::Cyan)),
        Span::styled(input_text, Style::default().fg(input_color)),
    ]));
    frame.render_widget(input_line, chunks[2]);

    let mut next_chunk = 3;

    if !has_result && !app.completion.suggestions.is_empty() {
        render_suggestions(frame, chunks[next_chunk], &app.completion);
        next_chunk += 1;
    }

    if !has_result {
        let hint = if app.completion.suggestions.is_empty() {
            "Enter to validate \u{00b7} Esc to go back"
        } else {
            "Tab to complete \u{00b7} Enter to validate \u{00b7} Esc to go back"
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

pub fn render_suggestions_public(
    frame: &mut Frame,
    area: Rect,
    completion: &crate::completion::CompletionState,
) {
    render_suggestions(frame, area, completion);
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

pub fn run_validation(path_str: &str) -> serde_json::Value {
    let path = Path::new(path_str.trim());

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return serde_json::json!(format!("\u{2718} Could not read file: {}", e)),
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => return serde_json::json!(format!("\u{2718} Invalid JSON: {}", e)),
    };

    let is_mod = parsed.get("fragments").is_some() && parsed.get("bindings").is_none();

    if is_mod {
        validate_mod_manifest(&content)
    } else {
        validate_app_manifest(&content)
    }
}

fn validate_app_manifest(content: &str) -> serde_json::Value {
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => return serde_json::json!(format!("\u{2718} Failed to parse: {}", e)),
    };

    let name = parsed
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let version = parsed.get("version").and_then(|v| v.as_str());
    let description = parsed.get("description").and_then(|v| v.as_str());

    match xript_runtime::create_runtime(
        content,
        xript_runtime::RuntimeOptions {
            host_bindings: xript_runtime::HostBindings::new(),
            capabilities: vec![],
            console: xript_runtime::ConsoleHandler::default(),
        },
    ) {
        Ok(_rt) => {
            let mut info = format!("\u{2714} Valid app manifest: {}", name);
            if let Some(ver) = version {
                info.push_str(&format!(" v{}", ver));
            }
            if let Some(desc) = description {
                info.push_str(&format!("\n  {}", desc));
            }
            let binding_count = parsed
                .get("bindings")
                .and_then(|v| v.as_object())
                .map(|o| o.len())
                .unwrap_or(0);
            let slot_count = parsed
                .get("slots")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            if binding_count > 0 {
                info.push_str(&format!("\n  Bindings: {}", binding_count));
            }
            if slot_count > 0 {
                info.push_str(&format!("\n  Slots: {}", slot_count));
            }
            serde_json::json!(info)
        }
        Err(e) => serde_json::json!(format!("\u{2718} {}", e)),
    }
}

fn validate_mod_manifest(content: &str) -> serde_json::Value {
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => return serde_json::json!(format!("\u{2718} Failed to parse: {}", e)),
    };

    let _manifest: xript_runtime::ModManifest = match serde_json::from_str(content) {
        Ok(m) => m,
        Err(e) => {
            return serde_json::json!(format!("\u{2718} Failed to deserialize mod manifest: {}", e))
        }
    };

    let mut issues = Vec::new();

    let xript_field = parsed
        .get("xript")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let name = parsed
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let version = parsed
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if xript_field.is_empty() {
        issues.push("/xript: must be a non-empty string".to_string());
    }
    if name.is_empty() {
        issues.push("/name: must be a non-empty string".to_string());
    }
    if version.is_empty() {
        issues.push("/version: must be a non-empty string".to_string());
    }

    if let Some(frags) = parsed.get("fragments").and_then(|v| v.as_array()) {
        for (i, frag) in frags.iter().enumerate() {
            let fid = frag.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let slot = frag.get("slot").and_then(|v| v.as_str()).unwrap_or("");
            let format = frag.get("format").and_then(|v| v.as_str()).unwrap_or("");
            if fid.is_empty() {
                issues.push(format!("/fragments/{}/id: must be non-empty", i));
            }
            if slot.is_empty() {
                issues.push(format!("/fragments/{}/slot: must be non-empty", i));
            }
            if format.is_empty() {
                issues.push(format!("/fragments/{}/format: must be non-empty", i));
            }
        }
    }

    if issues.is_empty() {
        let description = parsed.get("description").and_then(|v| v.as_str());
        let frag_count = parsed
            .get("fragments")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);

        let mut info = format!("\u{2714} Valid mod manifest: {} v{}", name, version);
        if let Some(desc) = description {
            info.push_str(&format!("\n  {}", desc));
        }
        if frag_count > 0 {
            info.push_str(&format!("\n  Fragments: {}", frag_count));
        }
        serde_json::json!(info)
    } else {
        let msg = format!("\u{2718} Validation errors:\n  {}", issues.join("\n  "));
        serde_json::json!(msg)
    }
}
