use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::app::App;

/// Builds the standard constraint list and renders the shared cwd / prompt / input /
/// suggestions / hint rows used by file-input screens (validate, audit, diff).
///
/// Returns the chunk array and the index of the first chunk after the common rows,
/// ready for the caller to render its result block.
pub fn render_file_input(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    prompt_text: &str,
    action_word: &str,
) -> (Vec<Rect>, usize) {
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

    let chunks: Vec<Rect> = Layout::default()
        .direction(Direction::Vertical)
        .constraints(&constraints)
        .split(area)
        .to_vec();

    let cwd = crate::completion::current_dir_display();
    let cwd_line = Paragraph::new(Line::from(vec![
        Span::styled("cwd: ", Style::default().fg(Color::DarkGray)),
        Span::styled(&cwd, Style::default().fg(Color::DarkGray)),
    ]));
    frame.render_widget(cwd_line, chunks[0]);

    let prompt = Paragraph::new(Line::from(vec![Span::styled(
        prompt_text,
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
        let mid = "\u{00b7}";
        let hint = if app.completion.suggestions.is_empty() {
            format!("Enter to {} {} Esc to go back", action_word, mid)
        } else {
            format!("Tab to complete {} Enter to {} {} Esc to go back", mid, action_word, mid)
        };
        let hint_para = Paragraph::new(Line::from(Span::styled(
            hint,
            Style::default().fg(Color::DarkGray),
        )));
        frame.render_widget(hint_para, chunks[next_chunk]);
        next_chunk += 1;
    }

    (chunks, next_chunk)
}
