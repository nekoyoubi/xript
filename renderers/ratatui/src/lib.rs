//! A `xript-tree/1` renderer for Ratatui.
//!
//! It is not a host: it does not load mods, hold capabilities, evaluate
//! expressions, or own storage. It walks a tree it is handed and draws it, and it
//! applies a list of mutations it is handed and redraws.
//!
//! The tree arrives sanitized, bound, interpolation-resolved, and
//! visibility-evaluated. There is no bindings map anywhere in this crate's API,
//! deliberately: a renderer that takes one has been handed an incomplete tree, and
//! the second evaluator it grows to cope is the divergence the contract removes.

pub mod layout;
pub mod logo;
pub mod parser;
pub mod render;
pub mod style;

pub use layout::parse_constraint;
pub use logo::logo_text;
pub use parser::{build_widgets, WidgetNode};
pub use render::render_widget_node;
pub use style::parse_style;

pub use xript_tree::{
    apply_ops, FragmentNode, FragmentOp, NodeRef, RenderedFragment, CONTRACT_VERSION,
};

use ratatui::layout::Rect;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

/// Draws a fragment.
///
/// A `contract` string this renderer does not recognize is refused rather than
/// guessed at: a tree drawn against the wrong contract draws the wrong thing
/// silently, which is worse than drawing nothing.
pub fn render_fragment(frame: &mut Frame, area: Rect, fragment: &RenderedFragment) {
    if fragment.contract != CONTRACT_VERSION {
        frame.render_widget(
            Paragraph::new(format!(
                "unsupported fragment contract \"{}\" (this renderer speaks {CONTRACT_VERSION})",
                fragment.contract
            )),
            area,
        );
        return;
    }

    for node in build_widgets(fragment) {
        render_widget_node(frame, area, &node);
    }
}
