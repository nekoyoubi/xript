use std::path::Path;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;
use ratatui::layout::Rect;

use crate::app::App;

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let (chunks, next_chunk) = crate::screens::common::render_file_input(
        frame,
        area,
        app,
        "Enter path to a manifest file:",
        "audit",
    );

    if let Some(ref result) = app.result_fragment {
        let text = match result.as_str() {
            Some(s) => s.to_string(),
            None => result.to_string(),
        };

        let result_color = if text.starts_with('\u{2718}') {
            Color::Red
        } else if text.contains("Ungated") || text.contains("gaps") || text.contains("Unused") {
            Color::Yellow
        } else {
            Color::Green
        };

        let result_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(result_color))
            .title(Span::styled(
                " Audit Report ",
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

pub fn run_audit(path_str: &str) -> serde_json::Value {
    let path = Path::new(path_str.trim());

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return serde_json::json!(format!("\u{2718} Could not read file: {}", e)),
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => return serde_json::json!(format!("\u{2718} Invalid JSON: {}", e)),
    };

    let bindings = parsed.get("bindings").and_then(|v| v.as_object());
    let capabilities = parsed.get("capabilities").and_then(|v| v.as_object());
    let hooks = parsed.get("hooks").and_then(|v| v.as_object());

    let mut ungated: Vec<String> = Vec::new();
    let mut referenced_caps: Vec<String> = Vec::new();

    if let Some(b) = bindings {
        collect_binding_audit(b, "", &mut ungated, &mut referenced_caps);
    }
    if let Some(h) = hooks {
        for (name, hook) in h {
            if let Some(cap) = hook.get("capability").and_then(|v| v.as_str()) {
                referenced_caps.push(cap.to_string());
            } else {
                ungated.push(format!("hook:{}", name));
            }
        }
    }

    let defined_caps: Vec<String> = capabilities
        .map(|c| c.keys().cloned().collect())
        .unwrap_or_default();

    let unused: Vec<&String> = defined_caps
        .iter()
        .filter(|c| !referenced_caps.contains(c))
        .collect();

    let gaps: Vec<&String> = referenced_caps
        .iter()
        .filter(|c| !defined_caps.contains(c))
        .collect();

    let mut risk_counts = [0u32; 3];
    if let Some(caps) = capabilities {
        for (_name, cap) in caps {
            match cap.get("risk").and_then(|v| v.as_str()).unwrap_or("low") {
                "low" => risk_counts[0] += 1,
                "medium" => risk_counts[1] += 1,
                "high" => risk_counts[2] += 1,
                _ => risk_counts[0] += 1,
            }
        }
    }

    let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
    let mut report = format!("\u{2714} Audit: {}\n", name);

    report.push_str(&format!("\nCapabilities: {} defined\n", defined_caps.len()));
    if !defined_caps.is_empty() {
        report.push_str(&format!(
            "  Risk: {} low, {} medium, {} high\n",
            risk_counts[0], risk_counts[1], risk_counts[2]
        ));
    }

    if !ungated.is_empty() {
        report.push_str(&format!("\nUngated ({}):\n", ungated.len()));
        for item in &ungated {
            report.push_str(&format!("  \u{2022} {}\n", item));
        }
    } else {
        report.push_str("\nAll bindings and hooks are gated \u{2714}\n");
    }

    if !unused.is_empty() {
        report.push_str(&format!("\nUnused capabilities ({}):\n", unused.len()));
        for cap in &unused {
            report.push_str(&format!("  \u{2022} {}\n", cap));
        }
    }

    if !gaps.is_empty() {
        report.push_str(&format!("\nCapability gaps ({}):\n", gaps.len()));
        for cap in &gaps {
            report.push_str(&format!("  \u{2022} {} (referenced but not defined)\n", cap));
        }
    }

    serde_json::json!(report)
}

fn collect_binding_audit(
    obj: &serde_json::Map<String, serde_json::Value>,
    prefix: &str,
    ungated: &mut Vec<String>,
    referenced_caps: &mut Vec<String>,
) {
    for (name, binding) in obj {
        let full_path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}.{}", prefix, name)
        };

        if let Some(members) = binding.get("members").and_then(|v| v.as_object()) {
            collect_binding_audit(members, &full_path, ungated, referenced_caps);
        } else {
            if let Some(cap) = binding.get("capability").and_then(|v| v.as_str()) {
                referenced_caps.push(cap.to_string());
            } else {
                ungated.push(full_path);
            }
        }
    }
}
