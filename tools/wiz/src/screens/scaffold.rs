use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::App;

const PROJECT_TYPES: &[&str] = &["app", "mod"];
const LANGUAGES: &[&str] = &["ts", "js"];

const TYPE_LABELS: &[&str] = &["App", "Mod"];
const LANG_LABELS: &[&str] = &["TypeScript", "JavaScript"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScaffoldField {
    Name,
    Type,
    Lang,
}

impl ScaffoldField {
    #[cfg(test)]
    pub fn next(self) -> Option<ScaffoldField> {
        match self {
            ScaffoldField::Name => Some(ScaffoldField::Type),
            ScaffoldField::Type => Some(ScaffoldField::Lang),
            ScaffoldField::Lang => None,
        }
    }

    #[cfg(test)]
    pub fn prev(self) -> Option<ScaffoldField> {
        match self {
            ScaffoldField::Name => None,
            ScaffoldField::Type => Some(ScaffoldField::Name),
            ScaffoldField::Lang => Some(ScaffoldField::Type),
        }
    }
}

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let has_result = app.result_fragment.is_some();
    let active_field = app.scaffold_field;

    let mut constraints = vec![
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(3),
        Constraint::Length(1),
        Constraint::Length(3),
        Constraint::Length(1),
        Constraint::Length(3),
    ];

    if !has_result {
        constraints.push(Constraint::Length(1));
    }

    constraints.push(Constraint::Min(1));

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(&constraints)
        .split(area);

    let title = Paragraph::new(Line::from(Span::styled(
        "Configure your new xript project:",
        Style::default().fg(Color::Gray),
    )));
    frame.render_widget(title, chunks[0]);

    let name_active = active_field == ScaffoldField::Name && !has_result;
    let name_label_style = if name_active {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    let name_label = Paragraph::new(Line::from(Span::styled("Project name", name_label_style)));
    frame.render_widget(name_label, chunks[1]);

    let cursor = if name_active { "\u{2588}" } else { "" };
    let name_value = if name_active {
        format!("{}{}", app.input, cursor)
    } else {
        let n = &app.scaffold_name;
        if n.is_empty() {
            "my-xript-project".to_string()
        } else {
            n.clone()
        }
    };

    let name_border_color = if name_active {
        Color::Cyan
    } else {
        Color::DarkGray
    };
    let name_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(name_border_color));
    let name_para = Paragraph::new(Line::from(vec![
        Span::styled("> ", Style::default().fg(Color::Cyan)),
        Span::styled(
            name_value,
            Style::default().fg(if name_active {
                Color::Cyan
            } else {
                Color::White
            }),
        ),
    ]))
    .block(name_block);
    frame.render_widget(name_para, chunks[2]);

    let type_active = active_field == ScaffoldField::Type && !has_result;
    let type_label_style = if type_active {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    let type_label = Paragraph::new(Line::from(Span::styled("Project type", type_label_style)));
    frame.render_widget(type_label, chunks[3]);

    render_toggle_cards(
        frame,
        chunks[4],
        TYPE_LABELS,
        app.scaffold_type_idx,
        type_active,
    );

    let lang_active = active_field == ScaffoldField::Lang && !has_result;
    let lang_label_style = if lang_active {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    let lang_label = Paragraph::new(Line::from(Span::styled("Language", lang_label_style)));
    frame.render_widget(lang_label, chunks[5]);

    render_toggle_cards(
        frame,
        chunks[6],
        LANG_LABELS,
        app.scaffold_lang_idx,
        lang_active,
    );

    let mut next_chunk = 7;

    if !has_result {
        let hint = match active_field {
            ScaffoldField::Name => {
                "\u{2191}\u{2193} navigate fields \u{00b7} Enter/Tab for next \u{00b7} Esc to go back"
            }
            ScaffoldField::Type => {
                "\u{2190}\u{2192} change selection \u{00b7} \u{2191}\u{2193} navigate fields \u{00b7} Esc to go back"
            }
            ScaffoldField::Lang => {
                "\u{2190}\u{2192} change selection \u{00b7} Enter to generate \u{00b7} Esc to go back"
            }
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

        let result_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Green))
            .title(Span::styled(
                " Preview ",
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD),
            ));

        let result_para = Paragraph::new(text)
            .style(Style::default().fg(Color::Green))
            .block(result_block)
            .wrap(Wrap { trim: false });

        if next_chunk < chunks.len() {
            frame.render_widget(result_para, chunks[next_chunk]);
        }
    }
}

fn render_toggle_cards(
    frame: &mut Frame,
    area: Rect,
    labels: &[&str],
    selected_idx: usize,
    row_active: bool,
) {
    let card_count = labels.len();
    let gap: u16 = 2;
    let total_gap = (card_count.saturating_sub(1) as u16) * gap;
    let card_width = area
        .width
        .saturating_sub(total_gap)
        .checked_div(card_count as u16)
        .unwrap_or(10)
        .min(24);

    let mut constraints: Vec<Constraint> = Vec::new();
    for i in 0..card_count {
        constraints.push(Constraint::Length(card_width));
        if i < card_count - 1 {
            constraints.push(Constraint::Length(gap));
        }
    }
    constraints.push(Constraint::Min(0));

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(&constraints)
        .split(area);

    for (i, label) in labels.iter().enumerate() {
        let chunk_idx = i * 2;
        if chunk_idx >= chunks.len() {
            break;
        }

        let is_selected = i == selected_idx;

        let (border_color, text_color, text_mod) = if is_selected && row_active {
            (Color::Cyan, Color::Cyan, Modifier::BOLD)
        } else if is_selected {
            (Color::Gray, Color::White, Modifier::BOLD)
        } else {
            (Color::DarkGray, Color::DarkGray, Modifier::empty())
        };

        let indicator = if is_selected { "\u{25cf} " } else { "\u{25cb} " };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color));

        let inner = block.inner(chunks[chunk_idx]);
        frame.render_widget(block, chunks[chunk_idx]);

        let line = Line::from(vec![
            Span::styled(indicator, Style::default().fg(text_color)),
            Span::styled(
                label.to_string(),
                Style::default().fg(text_color).add_modifier(text_mod),
            ),
        ]);
        let para = Paragraph::new(line);
        frame.render_widget(para, inner);
    }
}

pub fn cycle_type(idx: usize, forward: bool) -> usize {
    let len = PROJECT_TYPES.len();
    if forward {
        (idx + 1) % len
    } else {
        (idx + len - 1) % len
    }
}

pub fn cycle_lang(idx: usize, forward: bool) -> usize {
    let len = LANGUAGES.len();
    if forward {
        (idx + 1) % len
    } else {
        (idx + len - 1) % len
    }
}

pub fn generate_preview(name: &str, type_idx: usize, lang_idx: usize) -> serde_json::Value {
    let project_type = PROJECT_TYPES[type_idx];
    let lang = LANGUAGES[lang_idx];
    let ext = lang;
    let project_name = if name.is_empty() {
        "my-xript-project"
    } else {
        name
    };

    let mut files = vec![format!("{}/", project_name)];

    if project_type == "app" {
        files.push("  manifest.json".to_string());
        files.push("  src/".to_string());
        files.push(format!("    main.{}", ext));
        files.push("  package.json".to_string());
        if lang == "ts" {
            files.push("    tsconfig.json".to_string());
        }
    } else {
        files.push("  mod-manifest.json".to_string());
        files.push("  src/".to_string());
        files.push(format!("    mod.{}", ext));
        files.push("  fragments/".to_string());
        files.push("    panel.html".to_string());
        files.push("  package.json".to_string());
        if lang == "ts" {
            files.push("    tsconfig.json".to_string());
        }
    }

    let type_label = TYPE_LABELS[type_idx];
    let lang_label = LANG_LABELS[lang_idx];

    let preview = format!(
        "\u{2714} Would generate {} project \"{}\" ({}):\n{}",
        type_label,
        project_name,
        lang_label,
        files.join("\n")
    );

    serde_json::json!(preview)
}
