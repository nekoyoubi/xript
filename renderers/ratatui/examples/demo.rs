use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use serde_json::json;

use xript_ratatui::{render_json_fragment, logo_text};

fn load_file(base: &Path, relative: &str) -> String {
    std::fs::read_to_string(base.join(relative)).unwrap_or_default()
}

fn main() -> io::Result<()> {
    let mod_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/demo-mod");

    let app_manifest_json = load_file(&mod_dir, "manifest.json");
    let mod_manifest_json = load_file(&mod_dir, "mod-manifest.json");
    let mod_manifest: serde_json::Value = serde_json::from_str(&mod_manifest_json).expect("invalid mod manifest");

    let mut fragment_sources = HashMap::new();
    if let Some(entry) = mod_manifest.get("entry").and_then(|e| e.as_str()) {
        fragment_sources.insert(entry.to_string(), load_file(&mod_dir, entry));
    }
    if let Some(fragments) = mod_manifest.get("fragments").and_then(|f| f.as_array()) {
        for frag in fragments {
            if let Some(source) = frag.get("source").and_then(|s| s.as_str()) {
                if frag.get("inline").and_then(|i| i.as_bool()).unwrap_or(false) {
                    continue;
                }
                fragment_sources.insert(source.to_string(), load_file(&mod_dir, source));
            }
        }
    }

    let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let logs_clone = logs.clone();

    let rt = xript_runtime::create_runtime(
        &app_manifest_json,
        xript_runtime::RuntimeOptions {
            host_bindings: {
                let mut b = xript_runtime::HostBindings::new();
                b.add_function("log", move |args: &[serde_json::Value]| {
                    let msg = args.first().and_then(|a| a.as_str()).unwrap_or("");
                    logs_clone.lock().unwrap().push(msg.to_string());
                    Ok(json!(null))
                });
                b
            },
            capabilities: vec!["ui-mount".to_string()],
            console: xript_runtime::ConsoleHandler::default(),
        },
    ).expect("failed to create runtime");

    let mod_instance = rt.load_mod(
        &mod_manifest_json,
        fragment_sources.clone(),
        &["ui-mount".to_string()].into_iter().collect(),
    ).expect("failed to load mod");

    let fragment = mod_instance.fragments.first().expect("mod has no fragments");
    let fragment_json: serde_json::Value = serde_json::from_str(
        &fragment_sources.get("fragments/panel.json").expect("missing fragment source"),
    ).expect("invalid fragment JSON");

    for log_msg in logs.lock().unwrap().iter() {
        eprintln!("[mod] {}", log_msg);
    }

    enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    let mut health: f64 = 100.0;
    let max_health: f64 = 100.0;
    let tick_rate = Duration::from_millis(100);
    let mut last_tick = Instant::now();

    loop {
        let mut bindings = HashMap::new();
        bindings.insert("name".to_string(), json!("Hero"));
        bindings.insert("health".to_string(), json!(health));
        bindings.insert("maxHealth".to_string(), json!(max_health));

        terminal.draw(|frame| {
            use ratatui::style::{Style, Color};
            use ratatui::widgets::Paragraph;

            let area = frame.area();

            let logo_area = ratatui::layout::Rect {
                x: area.width.saturating_sub(60) / 2,
                y: 0,
                width: 60.min(area.width),
                height: 14.min(area.height),
            };
            let logo = Paragraph::new(logo_text());
            frame.render_widget(logo, logo_area);

            let hint_area = ratatui::layout::Rect {
                x: 1,
                y: area.height.saturating_sub(1),
                width: area.width.saturating_sub(2),
                height: 1,
            };
            let hint = Paragraph::new(format!(
                "q / Esc / Ctrl+C to exit  |  mod: {} v{}  |  fragment: {}",
                mod_instance.name, mod_instance.version, fragment.id,
            )).style(Style::default().fg(Color::DarkGray));
            frame.render_widget(hint, hint_area);

            let centered = ratatui::layout::Rect {
                x: area.width.saturating_sub(50) / 2,
                y: 15.min(area.height.saturating_sub(5)),
                width: 50.min(area.width),
                height: 5.min(area.height.saturating_sub(16)),
            };

            render_json_fragment(frame, centered, &fragment_json, &bindings);
        })?;

        let timeout = tick_rate
            .checked_sub(last_tick.elapsed())
            .unwrap_or(Duration::ZERO);

        if event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => break,
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => break,
                        _ => {}
                    }
                }
            }
        }

        if last_tick.elapsed() >= tick_rate {
            health -= 1.0;
            if health < 0.0 {
                health = 100.0;
            }
            last_tick = Instant::now();
        }
    }

    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}
