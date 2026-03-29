use std::collections::HashMap;

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::completion::CompletionState;
use crate::screens::scaffold::ScaffoldField;
use crate::screens::Screen;

pub struct App {
    pub screen: Screen,
    pub selected: usize,
    pub input: String,
    pub result_fragment: Option<serde_json::Value>,
    pub result_bindings: HashMap<String, serde_json::Value>,
    pub status_message: String,
    pub should_quit: bool,
    pub scaffold_field: ScaffoldField,
    pub scaffold_name: String,
    pub scaffold_type_idx: usize,
    pub scaffold_lang_idx: usize,
    pub completion: CompletionState,
}

impl App {
    pub fn new() -> Self {
        Self {
            screen: Screen::Home,
            selected: 0,
            input: String::new(),
            result_fragment: None,
            result_bindings: HashMap::new(),
            status_message: String::new(),
            should_quit: false,
            scaffold_field: ScaffoldField::Name,
            scaffold_name: String::new(),
            scaffold_type_idx: 0,
            scaffold_lang_idx: 0,
            completion: CompletionState::new(),
        }
    }

    pub fn navigate_to(&mut self, screen: Screen) {
        self.screen = screen;
        self.input.clear();
        self.result_fragment = None;
        self.result_bindings.clear();
        self.scaffold_field = ScaffoldField::Name;
        self.scaffold_name.clear();
        self.scaffold_type_idx = 0;
        self.scaffold_lang_idx = 0;
        self.completion = CompletionState::new();
        if matches!(screen, Screen::Validate | Screen::Sanitize | Screen::Audit | Screen::Diff) {
            self.completion.update("");
        }
    }

    pub fn go_home(&mut self) {
        self.navigate_to(Screen::Home);
    }

    pub fn draw(&self, frame: &mut Frame) {
        let area = frame.area();

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(10),
                Constraint::Length(1),
                Constraint::Min(5),
                Constraint::Length(1),
            ])
            .split(area);

        self.render_header(frame, chunks[0]);
        self.render_breadcrumb(frame, chunks[1]);
        self.render_main(frame, chunks[2]);
        self.render_status(frame, chunks[3]);
    }

    fn render_header(&self, frame: &mut Frame, area: Rect) {
        use ansi_to_tui::IntoText;

        let logo_raw = include_str!("logo.ansi");
        let logo_text = logo_raw.into_text().unwrap_or_default();
        let logo = Paragraph::new(logo_text);

        let logo_area = Rect {
            x: area.x + area.width.saturating_sub(40) / 2,
            y: area.y,
            width: 40.min(area.width),
            height: 10.min(area.height),
        };
        frame.render_widget(logo, logo_area);
    }

    fn render_breadcrumb(&self, frame: &mut Frame, area: Rect) {
        let screen_title = self.screen.title();
        let breadcrumb = if self.screen == Screen::Home {
            Line::from(vec![
                Span::styled(
                    " xript",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
            ])
        } else {
            Line::from(vec![
                Span::styled(" xript", Style::default().fg(Color::DarkGray)),
                Span::styled(" > ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    screen_title,
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
            ])
        };

        let para = Paragraph::new(breadcrumb);
        frame.render_widget(para, area);
    }

    fn render_main(&self, frame: &mut Frame, area: Rect) {
        match self.screen {
            Screen::Home => crate::screens::home::render(frame, area, self),
            Screen::Validate => crate::screens::validate::render(frame, area, self),
            Screen::Scaffold => crate::screens::scaffold::render(frame, area, self),
            Screen::Sanitize => crate::screens::sanitize::render(frame, area, self),
            Screen::Audit => crate::screens::audit::render(frame, area, self),
            Screen::Diff => crate::screens::diff::render(frame, area, self),
        }
    }

    fn render_status(&self, frame: &mut Frame, area: Rect) {
        let help_text = match self.screen {
            Screen::Home => {
                "\u{2191}\u{2193} navigate \u{00b7} Enter select \u{00b7} q quit"
            }
            _ if self.result_fragment.is_some() => {
                "Press any key to return home"
            }
            _ => {
                "\u{2191}\u{2193} navigate \u{00b7} Enter select \u{00b7} Esc back \u{00b7} q quit"
            }
        };

        let status = Paragraph::new(Line::from(vec![Span::styled(
            format!(" {}", help_text),
            Style::default().fg(Color::DarkGray),
        )]));

        frame.render_widget(status, area);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_starts_on_home_screen() {
        let app = App::new();
        assert_eq!(app.screen, Screen::Home);
        assert_eq!(app.selected, 0);
        assert!(!app.should_quit);
    }

    #[test]
    fn navigate_to_resets_state() {
        let mut app = App::new();
        app.input = "some input".to_string();
        app.result_fragment = Some(serde_json::json!("result"));
        app.selected = 2;

        app.navigate_to(Screen::Validate);
        assert_eq!(app.screen, Screen::Validate);
        assert!(app.input.is_empty());
        assert!(app.result_fragment.is_none());
    }

    #[test]
    fn go_home_returns_to_home_screen() {
        let mut app = App::new();
        app.navigate_to(Screen::Sanitize);
        app.go_home();
        assert_eq!(app.screen, Screen::Home);
    }

    #[test]
    fn scaffold_field_navigation() {
        assert_eq!(ScaffoldField::Name.next(), Some(ScaffoldField::Type));
        assert_eq!(ScaffoldField::Type.next(), Some(ScaffoldField::Lang));
        assert_eq!(ScaffoldField::Lang.next(), None);

        assert_eq!(ScaffoldField::Name.prev(), None);
        assert_eq!(ScaffoldField::Type.prev(), Some(ScaffoldField::Name));
        assert_eq!(ScaffoldField::Lang.prev(), Some(ScaffoldField::Type));
    }

    #[test]
    fn screen_titles() {
        assert_eq!(Screen::Home.title(), "Home");
        assert_eq!(Screen::Validate.title(), "Validate Manifest");
        assert_eq!(Screen::Scaffold.title(), "Scaffold Project");
        assert_eq!(Screen::Sanitize.title(), "Sanitize Fragment");
        assert_eq!(Screen::Audit.title(), "Audit Manifest");
        assert_eq!(Screen::Diff.title(), "Diff Manifest");
    }

    #[test]
    fn navigate_to_resets_completion() {
        let mut app = App::new();
        app.completion.suggestions = vec!["test".to_string()];
        app.navigate_to(Screen::Scaffold);
        assert!(app.completion.suggestions.is_empty());
    }
}
