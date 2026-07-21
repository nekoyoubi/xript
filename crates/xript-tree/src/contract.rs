//! `xript-tree/1` — the one value a renderer receives.

use crate::diagnostic::FragmentDiagnostic;
use crate::node::FragmentTree;

/// The contract identifier every [`RenderedFragment`] carries. A renderer that
/// does not recognize the string must refuse to render rather than guess.
pub const CONTRACT_VERSION: &str = "xript-tree/1";

/// Which surface a *host* mounts. A renderer reads `tree` unconditionally,
/// including when this is [`ContentType::Html`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentType {
    Html,
    Tree,
}

impl ContentType {
    pub fn as_str(self) -> &'static str {
        match self {
            ContentType::Html => "html",
            ContentType::Tree => "tree",
        }
    }
}

/// A `data-if` result, addressed by where its node sits in the bound tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FragmentCondition {
    /// Child-index path into the bound tree, e.g. `[0, 2, 1]`.
    pub path: Vec<usize>,
    /// Carried for diagnostics, tooling, and debugger display. A renderer must
    /// **not** evaluate it; `visible` is already the answer.
    pub expression: String,
    pub visible: bool,
}

/// What a renderer receives: sanitized, bound, interpolation-resolved, and
/// visibility-evaluated-but-not-pruned.
///
/// There is deliberately no bindings map on this type. A renderer that needs one
/// has been handed an incomplete tree, and that is a contract bug rather than a
/// reason to reach for an evaluator.
#[derive(Debug, Clone)]
pub struct RenderedFragment {
    /// Always [`CONTRACT_VERSION`] for a fragment this crate produced.
    pub contract: &'static str,
    pub fragment_id: String,
    /// The media type — the renderer's own vocabulary id.
    pub format: String,
    pub content_type: ContentType,
    /// Bound, sanitized, resolved. Always present, for every format.
    pub tree: FragmentTree,
    /// Every `data-if`, path-keyed, already evaluated.
    pub conditions: Vec<FragmentCondition>,
    /// Advisory in every case.
    pub diagnostics: Vec<FragmentDiagnostic>,
}

impl RenderedFragment {
    /// Whether a node is hidden, which is the renderer's entire visibility
    /// implementation: a path-prefix lookup against `conditions`.
    ///
    /// A `data-if` on an ancestor hides the whole subtree, so the check is a
    /// prefix match rather than an equality one.
    pub fn is_hidden(&self, path: &[usize]) -> bool {
        self.conditions
            .iter()
            .any(|condition| !condition.visible && is_prefix(&condition.path, path))
    }

    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == crate::DiagnosticSeverity::Error)
    }
}

fn is_prefix(candidate: &[usize], path: &[usize]) -> bool {
    candidate.len() <= path.len() && candidate == &path[..candidate.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fragment(conditions: Vec<FragmentCondition>) -> RenderedFragment {
        RenderedFragment {
            contract: CONTRACT_VERSION,
            fragment_id: "f".into(),
            format: "application/x-ratatui+json".into(),
            content_type: ContentType::Tree,
            tree: Vec::new(),
            conditions,
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn a_false_condition_hides_its_own_node() {
        let f = fragment(vec![FragmentCondition {
            path: vec![0, 2],
            expression: "health < 50".into(),
            visible: false,
        }]);
        assert!(f.is_hidden(&[0, 2]));
        assert!(!f.is_hidden(&[0, 1]));
    }

    #[test]
    fn a_false_condition_hides_the_whole_subtree() {
        let f = fragment(vec![FragmentCondition {
            path: vec![0],
            expression: "alive".into(),
            visible: false,
        }]);
        assert!(f.is_hidden(&[0, 3, 1]));
    }

    #[test]
    fn a_true_condition_hides_nothing() {
        let f = fragment(vec![FragmentCondition {
            path: vec![0],
            expression: "alive".into(),
            visible: true,
        }]);
        assert!(!f.is_hidden(&[0, 3, 1]));
    }
}
