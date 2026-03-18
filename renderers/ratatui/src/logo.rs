use ansi_to_tui::IntoText;
use ratatui::text::Text;

pub fn logo_text() -> Text<'static> {
    let raw = include_str!("logo.ansi");
    raw.into_text().unwrap_or_default()
}
