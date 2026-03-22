use std::path::Path;
use std::process::Command;

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

    let prompt = Paragraph::new(Line::from(vec![Span::styled(
        "Enter path to a manifest file:",
        Style::default().fg(Color::Gray),
    )]));
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
        crate::screens::validate::render_suggestions_public(frame, chunks[next_chunk], &app.completion);
        next_chunk += 1;
    }

    if !has_result {
        let hint = if app.completion.suggestions.is_empty() {
            "Enter to diff \u{00b7} Esc to go back"
        } else {
            "Tab to complete \u{00b7} Enter to diff \u{00b7} Esc to go back"
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

        let has_changes = text.contains("Added") || text.contains("Removed") || text.contains("Changed");
        let result_color = if text.starts_with('\u{2718}') {
            Color::Red
        } else if has_changes {
            Color::Yellow
        } else {
            Color::Green
        };

        let result_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(result_color))
            .title(Span::styled(
                " Manifest Diff ",
                Style::default()
                    .fg(result_color)
                    .add_modifier(Modifier::BOLD),
            ));

        let result_para = Paragraph::new(text)
            .style(Style::default().fg(Color::White))
            .block(result_block)
            .wrap(Wrap { trim: false });

        if next_chunk < chunks.len() {
            frame.render_widget(result_para, chunks[next_chunk]);
        }
    }
}

pub fn run_diff(path_str: &str) -> serde_json::Value {
    let path = Path::new(path_str.trim());

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return serde_json::json!(format!("\u{2718} Could not read file: {}", e)),
    };

    let current: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => return serde_json::json!(format!("\u{2718} Invalid JSON: {}", e)),
    };

    let tag = match Command::new("git")
        .args(["describe", "--tags", "--abbrev=0"])
        .output()
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => return serde_json::json!(format!("\u{2718} No git tags found — cannot diff")),
    };

    let path_str_clean = path_str.trim();
    let old_content = match Command::new("git")
        .args(["show", &format!("{}:{}", tag, path_str_clean)])
        .output()
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).to_string()
        }
        _ => {
            return serde_json::json!(format!(
                "\u{2718} Could not read {} from tag {}",
                path_str_clean, tag
            ))
        }
    };

    let old: serde_json::Value = match serde_json::from_str(&old_content) {
        Ok(v) => v,
        Err(e) => {
            return serde_json::json!(format!(
                "\u{2718} Could not parse old manifest from {}: {}",
                tag, e
            ))
        }
    };

    let name = current
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let mut report = format!("Diff: {} (current vs {})\n", name, tag);

    let old_bindings = collect_all_paths(old.get("bindings").and_then(|v| v.as_object()), "");
    let new_bindings = collect_all_paths(current.get("bindings").and_then(|v| v.as_object()), "");

    let added: Vec<&String> = new_bindings.iter().filter(|p| !old_bindings.contains(p)).collect();
    let removed: Vec<&String> = old_bindings.iter().filter(|p| !new_bindings.contains(p)).collect();

    let old_caps: Vec<String> = old
        .get("capabilities")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let new_caps: Vec<String> = current
        .get("capabilities")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    let added_caps: Vec<&String> = new_caps.iter().filter(|c| !old_caps.contains(c)).collect();
    let removed_caps: Vec<&String> = old_caps.iter().filter(|c| !new_caps.contains(c)).collect();

    let old_slots: Vec<String> = old
        .get("slots")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let new_slots: Vec<String> = current
        .get("slots")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let added_slots: Vec<&String> = new_slots.iter().filter(|s| !old_slots.contains(s)).collect();
    let removed_slots: Vec<&String> = old_slots.iter().filter(|s| !new_slots.contains(s)).collect();

    let has_changes = !added.is_empty()
        || !removed.is_empty()
        || !added_caps.is_empty()
        || !removed_caps.is_empty()
        || !added_slots.is_empty()
        || !removed_slots.is_empty();

    if !has_changes {
        report.push_str("\nNo changes since last tag.\n");
        return serde_json::json!(report);
    }

    if !added.is_empty() {
        report.push_str(&format!("\nAdded bindings ({}):\n", added.len()));
        for p in &added {
            report.push_str(&format!("  + {}\n", p));
        }
    }
    if !removed.is_empty() {
        report.push_str(&format!("\nRemoved bindings ({}):\n", removed.len()));
        for p in &removed {
            report.push_str(&format!("  - {}\n", p));
        }
    }
    if !added_caps.is_empty() {
        report.push_str(&format!("\nAdded capabilities ({}):\n", added_caps.len()));
        for c in &added_caps {
            report.push_str(&format!("  + {}\n", c));
        }
    }
    if !removed_caps.is_empty() {
        report.push_str(&format!("\nRemoved capabilities ({}):\n", removed_caps.len()));
        for c in &removed_caps {
            report.push_str(&format!("  - {}\n", c));
        }
    }
    if !added_slots.is_empty() {
        report.push_str(&format!("\nAdded slots ({}):\n", added_slots.len()));
        for s in &added_slots {
            report.push_str(&format!("  + {}\n", s));
        }
    }
    if !removed_slots.is_empty() {
        report.push_str(&format!("\nRemoved slots ({}):\n", removed_slots.len()));
        for s in &removed_slots {
            report.push_str(&format!("  - {}\n", s));
        }
    }

    serde_json::json!(report)
}

fn collect_all_paths(obj: Option<&serde_json::Map<String, serde_json::Value>>, prefix: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(map) = obj {
        for (key, value) in map {
            let full = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{}.{}", prefix, key)
            };
            if let Some(members) = value.get("members").and_then(|v| v.as_object()) {
                paths.extend(collect_all_paths(Some(members), &full));
            } else {
                paths.push(full);
            }
        }
    }
    paths
}
