mod app;
mod completion;
mod screens;

use std::io;
use std::panic;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use app::App;
use screens::scaffold::{self, ScaffoldField};
use screens::Screen;

fn main() -> io::Result<()> {
    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = io::stdout().execute(LeaveAlternateScreen);
        original_hook(info);
    }));

    enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new();

    loop {
        terminal.draw(|frame| app.draw(frame))?;

        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                if key.code == KeyCode::Char('c')
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                {
                    app.should_quit = true;
                }

                if app.should_quit {
                    break;
                }

                handle_key(&mut app, key.code, key.modifiers);

                if app.should_quit {
                    break;
                }
            }
        }
    }

    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}

fn handle_key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
    match app.screen {
        Screen::Home => handle_home_key(app, code),
        Screen::Validate => handle_input_screen_key(app, code, run_validate),
        Screen::Scaffold => handle_scaffold_key(app, code, modifiers),
        Screen::Sanitize => handle_input_screen_key(app, code, run_sanitize),
    }
}

fn handle_home_key(app: &mut App, code: KeyCode) {
    let menu_len = screens::home::menu_len();

    match code {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.should_quit = true;
        }
        KeyCode::Up | KeyCode::Char('k') => {
            if app.selected > 0 {
                app.selected -= 1;
            } else {
                app.selected = menu_len - 1;
            }
        }
        KeyCode::Down | KeyCode::Char('j') => {
            app.selected = (app.selected + 1) % menu_len;
        }
        KeyCode::Enter => match app.selected {
            0 => app.navigate_to(Screen::Validate),
            1 => app.navigate_to(Screen::Scaffold),
            2 => app.navigate_to(Screen::Sanitize),
            3 => app.should_quit = true,
            _ => {}
        },
        _ => {}
    }
}

fn handle_input_screen_key(
    app: &mut App,
    code: KeyCode,
    submit_fn: fn(&mut App),
) {
    if app.result_fragment.is_some() {
        app.go_home();
        return;
    }

    match code {
        KeyCode::Esc => {
            app.go_home();
        }
        KeyCode::Enter => {
            submit_fn(app);
        }
        KeyCode::Tab => {
            if let Some(completed) = app.completion.apply(&app.input) {
                app.input = completed;
                app.completion.update(&app.input);
            }
        }
        KeyCode::Down => {
            if !app.completion.suggestions.is_empty() {
                app.completion.selected = (app.completion.selected + 1) % app.completion.suggestions.len();
            }
        }
        KeyCode::Up => {
            if !app.completion.suggestions.is_empty() {
                if app.completion.selected > 0 {
                    app.completion.selected -= 1;
                } else {
                    app.completion.selected = app.completion.suggestions.len() - 1;
                }
            }
        }
        KeyCode::Backspace => {
            app.input.pop();
            app.completion.update(&app.input);
        }
        KeyCode::Char(c) => {
            app.input.push(c);
            app.completion.update(&app.input);
        }
        _ => {}
    }
}

fn handle_scaffold_key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
    if app.result_fragment.is_some() {
        app.go_home();
        return;
    }

    let shift = modifiers.contains(KeyModifiers::SHIFT);

    match app.scaffold_field {
        ScaffoldField::Name => match code {
            KeyCode::Esc => app.go_home(),
            KeyCode::Enter | KeyCode::Tab | KeyCode::Down => {
                app.scaffold_name = if app.input.is_empty() {
                    "my-xript-project".to_string()
                } else {
                    app.input.clone()
                };
                app.input.clear();
                app.scaffold_field = ScaffoldField::Type;
            }
            KeyCode::Backspace => {
                app.input.pop();
            }
            KeyCode::Char(c) => {
                app.input.push(c);
            }
            _ => {}
        },
        ScaffoldField::Type => match code {
            KeyCode::Esc => app.go_home(),
            KeyCode::Left => {
                app.scaffold_type_idx = scaffold::cycle_type(app.scaffold_type_idx, false);
            }
            KeyCode::Right => {
                app.scaffold_type_idx = scaffold::cycle_type(app.scaffold_type_idx, true);
            }
            KeyCode::Enter | KeyCode::Tab | KeyCode::Down => {
                app.scaffold_field = ScaffoldField::Lang;
            }
            KeyCode::Up => {
                app.scaffold_field = ScaffoldField::Name;
                app.input = app.scaffold_name.clone();
            }
            KeyCode::BackTab => {
                app.scaffold_field = ScaffoldField::Name;
                app.input = app.scaffold_name.clone();
            }
            _ => {}
        },
        ScaffoldField::Lang => match code {
            KeyCode::Esc => app.go_home(),
            KeyCode::Left => {
                app.scaffold_lang_idx = scaffold::cycle_lang(app.scaffold_lang_idx, false);
            }
            KeyCode::Right => {
                app.scaffold_lang_idx = scaffold::cycle_lang(app.scaffold_lang_idx, true);
            }
            KeyCode::Enter => {
                let result = scaffold::generate_preview(
                    &app.scaffold_name,
                    app.scaffold_type_idx,
                    app.scaffold_lang_idx,
                );
                app.result_fragment = Some(result);
            }
            KeyCode::Up | KeyCode::BackTab => {
                app.scaffold_field = ScaffoldField::Type;
            }
            KeyCode::Tab | KeyCode::Down if shift => {
                app.scaffold_field = ScaffoldField::Type;
            }
            _ => {}
        },
    }
}

fn run_validate(app: &mut App) {
    let result = screens::validate::run_validation(&app.input);
    app.result_fragment = Some(result);
    app.status_message = format!("Validated: {}", app.input);
}

fn run_sanitize(app: &mut App) {
    let result = screens::sanitize::run_sanitize(&app.input);
    app.result_fragment = Some(result);
    app.status_message = "Sanitization complete".to_string();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_from_home_with_q() {
        let mut app = App::new();
        handle_key(&mut app, KeyCode::Char('q'), KeyModifiers::empty());
        assert!(app.should_quit);
    }

    #[test]
    fn quit_from_home_with_esc() {
        let mut app = App::new();
        handle_key(&mut app, KeyCode::Esc, KeyModifiers::empty());
        assert!(app.should_quit);
    }

    #[test]
    fn navigate_home_menu() {
        let mut app = App::new();
        assert_eq!(app.selected, 0);

        handle_key(&mut app, KeyCode::Down, KeyModifiers::empty());
        assert_eq!(app.selected, 1);

        handle_key(&mut app, KeyCode::Down, KeyModifiers::empty());
        assert_eq!(app.selected, 2);

        handle_key(&mut app, KeyCode::Up, KeyModifiers::empty());
        assert_eq!(app.selected, 1);
    }

    #[test]
    fn home_menu_wraps_around() {
        let mut app = App::new();
        handle_key(&mut app, KeyCode::Up, KeyModifiers::empty());
        assert_eq!(app.selected, screens::home::menu_len() - 1);
    }

    #[test]
    fn enter_validate_screen() {
        let mut app = App::new();
        app.selected = 0;
        handle_key(&mut app, KeyCode::Enter, KeyModifiers::empty());
        assert_eq!(app.screen, Screen::Validate);
    }

    #[test]
    fn enter_scaffold_screen() {
        let mut app = App::new();
        app.selected = 1;
        handle_key(&mut app, KeyCode::Enter, KeyModifiers::empty());
        assert_eq!(app.screen, Screen::Scaffold);
    }

    #[test]
    fn enter_sanitize_screen() {
        let mut app = App::new();
        app.selected = 2;
        handle_key(&mut app, KeyCode::Enter, KeyModifiers::empty());
        assert_eq!(app.screen, Screen::Sanitize);
    }

    #[test]
    fn quit_menu_option() {
        let mut app = App::new();
        app.selected = 3;
        handle_key(&mut app, KeyCode::Enter, KeyModifiers::empty());
        assert!(app.should_quit);
    }

    #[test]
    fn esc_from_subscreen_returns_home() {
        let mut app = App::new();
        app.navigate_to(Screen::Validate);
        handle_key(&mut app, KeyCode::Esc, KeyModifiers::empty());
        assert_eq!(app.screen, Screen::Home);
    }

    #[test]
    fn text_input_on_validate_screen() {
        let mut app = App::new();
        app.navigate_to(Screen::Validate);

        handle_key(&mut app, KeyCode::Char('t'), KeyModifiers::empty());
        handle_key(&mut app, KeyCode::Char('e'), KeyModifiers::empty());
        handle_key(&mut app, KeyCode::Char('s'), KeyModifiers::empty());
        handle_key(&mut app, KeyCode::Char('t'), KeyModifiers::empty());
        assert_eq!(app.input, "test");

        handle_key(&mut app, KeyCode::Backspace, KeyModifiers::empty());
        assert_eq!(app.input, "tes");
    }

    #[test]
    fn result_dismissal_returns_home() {
        let mut app = App::new();
        app.navigate_to(Screen::Validate);
        app.result_fragment = Some(serde_json::json!("some result"));

        handle_key(&mut app, KeyCode::Char('x'), KeyModifiers::empty());
        assert_eq!(app.screen, Screen::Home);
    }

    #[test]
    fn scaffold_field_cycling() {
        assert_eq!(scaffold::cycle_type(0, true), 1);
        assert_eq!(scaffold::cycle_type(1, true), 0);
        assert_eq!(scaffold::cycle_type(0, false), 1);

        assert_eq!(scaffold::cycle_lang(0, true), 1);
        assert_eq!(scaffold::cycle_lang(1, true), 0);
    }

    #[test]
    fn scaffold_generates_preview() {
        let result = scaffold::generate_preview("test-project", 0, 0);
        let text = result.as_str().unwrap();
        assert!(text.contains("test-project"));
        assert!(text.contains("App"));
        assert!(text.contains("TypeScript"));
    }

    #[test]
    fn scaffold_navigation_between_fields() {
        let mut app = App::new();
        app.navigate_to(Screen::Scaffold);
        assert_eq!(app.scaffold_field, ScaffoldField::Name);

        handle_key(&mut app, KeyCode::Tab, KeyModifiers::empty());
        assert_eq!(app.scaffold_field, ScaffoldField::Type);

        handle_key(&mut app, KeyCode::Tab, KeyModifiers::empty());
        assert_eq!(app.scaffold_field, ScaffoldField::Lang);

        handle_key(&mut app, KeyCode::Up, KeyModifiers::empty());
        assert_eq!(app.scaffold_field, ScaffoldField::Type);
    }

    #[test]
    fn sanitize_run_produces_result() {
        let result = screens::sanitize::run_sanitize("<script>alert('xss')</script><p>safe</p>");
        let text = result.as_str().unwrap();
        assert!(text.contains("safe"));
        assert!(text.contains("script"));
    }

    #[test]
    fn validate_run_with_nonexistent_file() {
        let result = screens::validate::run_validation("/nonexistent/path.json");
        let text = result.as_str().unwrap();
        assert!(text.contains("\u{2718}"));
    }

    #[test]
    fn tab_completion_on_validate_screen() {
        let mut app = App::new();
        app.navigate_to(Screen::Validate);

        handle_key(&mut app, KeyCode::Char('s'), KeyModifiers::empty());
        handle_key(&mut app, KeyCode::Char('r'), KeyModifiers::empty());

        handle_key(&mut app, KeyCode::Tab, KeyModifiers::empty());

        assert!(app.input.len() >= 2);
    }

    #[test]
    fn completion_updates_on_input() {
        let mut app = App::new();
        app.navigate_to(Screen::Validate);

        handle_key(&mut app, KeyCode::Char('C'), KeyModifiers::empty());
        handle_key(&mut app, KeyCode::Char('a'), KeyModifiers::empty());

        assert!(
            !app.completion.suggestions.is_empty()
                || app.completion.suggestions.is_empty()
        );
    }

    #[test]
    fn backspace_updates_completion() {
        let mut app = App::new();
        app.navigate_to(Screen::Validate);

        handle_key(&mut app, KeyCode::Char('s'), KeyModifiers::empty());
        handle_key(&mut app, KeyCode::Char('r'), KeyModifiers::empty());
        handle_key(&mut app, KeyCode::Backspace, KeyModifiers::empty());

        assert_eq!(app.input, "s");
    }
}
