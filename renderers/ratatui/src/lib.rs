pub mod layout;
pub mod logo;
pub mod parser;
pub mod render;
pub mod style;

pub use layout::parse_constraint;
pub use logo::logo_text;
pub use parser::{parse_fragment, WidgetNode};
pub use render::render_fragment;
pub use style::parse_style;

use std::collections::HashMap;

use ratatui::layout::Rect;
use ratatui::Frame;

pub fn render_json_fragment(
    frame: &mut Frame,
    area: Rect,
    json: &serde_json::Value,
    bindings: &HashMap<String, serde_json::Value>,
) {
    if let Some(node) = parse_fragment(json, bindings) {
        render_fragment(frame, area, &node, bindings);
    }
}
