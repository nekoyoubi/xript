use ratatui::style::{Color, Modifier, Style};
use serde_json::Value;

pub fn parse_style(value: &Value) -> Style {
    let obj = match value.as_object() {
        Some(o) => o,
        None => return Style::default(),
    };

    let mut style = Style::default();

    if let Some(fg) = obj.get("fg") {
        if let Some(color) = parse_color(fg) {
            style = style.fg(color);
        }
    }

    if let Some(bg) = obj.get("bg") {
        if let Some(color) = parse_color(bg) {
            style = style.bg(color);
        }
    }

    if let Some(mods) = obj.get("mod") {
        if let Some(arr) = mods.as_array() {
            let mut modifier = Modifier::empty();
            for m in arr {
                if let Some(s) = m.as_str() {
                    modifier |= parse_modifier(s);
                }
            }
            style = style.add_modifier(modifier);
        }
    }

    style
}

pub fn parse_color(value: &Value) -> Option<Color> {
    match value {
        Value::String(s) => parse_color_name(s),
        Value::Array(arr) if arr.len() == 3 => {
            let r = arr[0].as_u64()? as u8;
            let g = arr[1].as_u64()? as u8;
            let b = arr[2].as_u64()? as u8;
            Some(Color::Rgb(r, g, b))
        }
        _ => None,
    }
}

fn parse_color_name(name: &str) -> Option<Color> {
    match name {
        "Black" => Some(Color::Black),
        "Red" => Some(Color::Red),
        "Green" => Some(Color::Green),
        "Yellow" => Some(Color::Yellow),
        "Blue" => Some(Color::Blue),
        "Magenta" => Some(Color::Magenta),
        "Cyan" => Some(Color::Cyan),
        "Gray" => Some(Color::Gray),
        "DarkGray" => Some(Color::DarkGray),
        "LightRed" => Some(Color::LightRed),
        "LightGreen" => Some(Color::LightGreen),
        "LightYellow" => Some(Color::LightYellow),
        "LightBlue" => Some(Color::LightBlue),
        "LightMagenta" => Some(Color::LightMagenta),
        "LightCyan" => Some(Color::LightCyan),
        "White" => Some(Color::White),
        _ => None,
    }
}

fn parse_modifier(name: &str) -> Modifier {
    match name {
        "BOLD" => Modifier::BOLD,
        "ITALIC" => Modifier::ITALIC,
        "UNDERLINED" => Modifier::UNDERLINED,
        "DIM" => Modifier::DIM,
        "CROSSED_OUT" => Modifier::CROSSED_OUT,
        "SLOW_BLINK" => Modifier::SLOW_BLINK,
        "REVERSED" => Modifier::REVERSED,
        _ => Modifier::empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_named_foreground_color() {
        let style = parse_style(&json!({"fg": "Red"}));
        assert_eq!(style, Style::default().fg(Color::Red));
    }

    #[test]
    fn parses_named_background_color() {
        let style = parse_style(&json!({"bg": "Blue"}));
        assert_eq!(style, Style::default().bg(Color::Blue));
    }

    #[test]
    fn parses_rgb_color() {
        let color = parse_color(&json!([255, 128, 0]));
        assert_eq!(color, Some(Color::Rgb(255, 128, 0)));
    }

    #[test]
    fn parses_modifiers() {
        let style = parse_style(&json!({"mod": ["BOLD", "ITALIC"]}));
        assert_eq!(
            style,
            Style::default().add_modifier(Modifier::BOLD | Modifier::ITALIC)
        );
    }

    #[test]
    fn parses_full_style() {
        let style = parse_style(&json!({
            "fg": "Green",
            "bg": "Black",
            "mod": ["BOLD"]
        }));
        assert_eq!(
            style,
            Style::default()
                .fg(Color::Green)
                .bg(Color::Black)
                .add_modifier(Modifier::BOLD)
        );
    }

    #[test]
    fn returns_default_for_empty_object() {
        let style = parse_style(&json!({}));
        assert_eq!(style, Style::default());
    }

    #[test]
    fn returns_default_for_non_object() {
        let style = parse_style(&json!("not an object"));
        assert_eq!(style, Style::default());
    }

    #[test]
    fn ignores_unknown_color_names() {
        let color = parse_color(&json!("Chartreuse"));
        assert_eq!(color, None);
    }

    #[test]
    fn ignores_unknown_modifiers() {
        let style = parse_style(&json!({"mod": ["BOLD", "SPARKLE"]}));
        assert_eq!(
            style,
            Style::default().add_modifier(Modifier::BOLD)
        );
    }

    #[test]
    fn parses_all_named_colors() {
        let names = [
            ("Black", Color::Black),
            ("Red", Color::Red),
            ("Green", Color::Green),
            ("Yellow", Color::Yellow),
            ("Blue", Color::Blue),
            ("Magenta", Color::Magenta),
            ("Cyan", Color::Cyan),
            ("Gray", Color::Gray),
            ("DarkGray", Color::DarkGray),
            ("LightRed", Color::LightRed),
            ("LightGreen", Color::LightGreen),
            ("LightYellow", Color::LightYellow),
            ("LightBlue", Color::LightBlue),
            ("LightMagenta", Color::LightMagenta),
            ("LightCyan", Color::LightCyan),
            ("White", Color::White),
        ];
        for (name, expected) in names {
            assert_eq!(parse_color(&json!(name)), Some(expected), "failed for {name}");
        }
    }

    #[test]
    fn parses_all_modifiers() {
        let mods = [
            ("BOLD", Modifier::BOLD),
            ("ITALIC", Modifier::ITALIC),
            ("UNDERLINED", Modifier::UNDERLINED),
            ("DIM", Modifier::DIM),
            ("CROSSED_OUT", Modifier::CROSSED_OUT),
            ("SLOW_BLINK", Modifier::SLOW_BLINK),
            ("REVERSED", Modifier::REVERSED),
        ];
        for (name, expected) in mods {
            assert_eq!(parse_modifier(name), expected, "failed for {name}");
        }
    }
}
