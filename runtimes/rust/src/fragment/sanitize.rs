//! Fragment-level sanitization: source string in, sanitized tree out.

use super::html::{html_to_tree, StrippedAttribute};
use super::profiles::{speaks_html, FormatProfile, FragmentSyntax};
use super::tree::{jsml_to_tree, tree_to_html, tree_to_html_for, FragmentTree, OrderedJson};
use super::vocabulary::{sanitize_tree, FragmentDiagnostic, VocabularyOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FragmentContentType {
    /// The host mounts `html`; the tree is available alongside it.
    Html,
    /// The host mounts the tree; there is no HTML projection.
    Tree,
}

impl FragmentContentType {
    pub fn as_str(self) -> &'static str {
        match self {
            FragmentContentType::Html => "html",
            FragmentContentType::Tree => "tree",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SanitizedFragment {
    pub tree: FragmentTree,
    /// HTML serialization of the sanitized tree. Present for the built-in
    /// profiles and for a host-declared vocabulary that is HTML plus custom
    /// elements. Empty when the vocabulary has no HTML meaning.
    pub html: String,
    pub content_type: FragmentContentType,
    pub diagnostics: Vec<FragmentDiagnostic>,
    pub stripped_elements: Vec<String>,
    pub stripped_attributes: Vec<StrippedAttribute>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FragmentParseError {
    pub format: String,
    pub message: String,
}

/// The hyphenated names SVG and MathML already define, which a browser does not
/// resolve as custom elements.
const RESERVED_HYPHENATED_NAMES: [&str; 8] = [
    "annotation-xml",
    "color-profile",
    "font-face",
    "font-face-src",
    "font-face-uri",
    "font-face-format",
    "font-face-name",
    "missing-glyph",
];

/// A name a browser resolves as a custom element: it carries a hyphen, starts
/// with an ASCII letter, and is not one of the names SVG and MathML define.
fn is_custom_element_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let mut chars = lower.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    if !lower.contains('-') {
        return false;
    }
    if !lower
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'))
    {
        return false;
    }
    !RESERVED_HYPHENATED_NAMES.contains(&lower.as_str())
}

/// Whether a format has a meaningful HTML projection.
///
/// Built-in formats always do. A host-declared scope does when it is HTML plus
/// custom elements: the built-in html vocabulary is in scope, and every node
/// every declared vocabulary in scope contributes is a valid custom element
/// name. Those names mean something to a browser, so the tree serializes to
/// markup a host can mount directly instead of walking itself.
///
/// Both halves are load-bearing. A scope without html carries no HTML meaning at
/// all. And a scope that declares a name HTML already owns, or one a browser
/// would not treat as a custom element, must not project: a declared node named
/// `style` would become a live `<style>` element, and a name without a hyphen is
/// inert markup rather than a component. The scan spans every vocabulary in
/// scope, not just the format's inline block, so a referenced vocabulary cannot
/// smuggle a bare `<Panel>` into projected markup.
pub fn projects_to_html(profile: &FormatProfile) -> bool {
    if profile.builtin {
        return true;
    }
    if !speaks_html(profile) {
        return false;
    }
    profile
        .scope
        .iter()
        .flat_map(|entry| entry.declared_nodes())
        .all(|(name, _)| is_custom_element_name(name))
}

/// Sanitizes a fragment source against the vocabulary its format declares.
///
/// The tree, the diagnostics, the stripped lists, and the HTML projection all
/// come from a single vocabulary walk, so one traversal decides both what was
/// removed and what ships rather than a second reader arriving at its own answer.
pub fn sanitize_fragment(
    source: &str,
    profile: &FormatProfile,
    options: VocabularyOptions,
) -> Result<SanitizedFragment, FragmentParseError> {
    if profile.syntax == FragmentSyntax::J5ml {
        let nodes = parse_jsml_source(source, &profile.id)?;
        let parsed = sanitize_tree(&jsml_to_tree(&nodes), profile, options);
        return Ok(SanitizedFragment {
            html: if projects_to_html(profile) { tree_to_html_for(&parsed.tree, profile) } else { String::new() },
            content_type: if profile.builtin {
                FragmentContentType::Html
            } else {
                FragmentContentType::Tree
            },
            tree: parsed.tree,
            diagnostics: parsed.diagnostics,
            stripped_elements: parsed.stripped_elements,
            stripped_attributes: parsed.stripped_attributes,
        });
    }

    let parsed = sanitize_tree(&html_to_tree(source, Some(profile)), profile, options);

    if !profile.builtin {
        let html =
            if projects_to_html(profile) { tree_to_html_for(&parsed.tree, profile) } else { String::new() };
        return Ok(SanitizedFragment {
            tree: parsed.tree,
            html,
            content_type: FragmentContentType::Tree,
            diagnostics: parsed.diagnostics,
            stripped_elements: parsed.stripped_elements,
            stripped_attributes: parsed.stripped_attributes,
        });
    }

    Ok(SanitizedFragment {
        html: tree_to_html(&parsed.tree),
        tree: parsed.tree,
        content_type: FragmentContentType::Html,
        diagnostics: parsed.diagnostics,
        stripped_elements: parsed.stripped_elements,
        stripped_attributes: parsed.stripped_attributes,
    })
}

/// Parses a JSML source into the J5ML node list the tree builder expects. A
/// bare element (`["div", …]`) and a node list (`[["div"], ["p"]]`) are both
/// accepted.
pub fn parse_jsml_source(
    source: &str,
    format: &str,
) -> Result<Vec<OrderedJson>, FragmentParseError> {
    let parsed: OrderedJson = serde_json::from_str(source).map_err(|_| FragmentParseError {
        format: format.to_string(),
        message: "invalid JSON".to_string(),
    })?;

    match parsed {
        OrderedJson::Array(ref items)
            if !items.is_empty() && matches!(items[0], OrderedJson::String(_)) =>
        {
            Ok(vec![parsed])
        }
        OrderedJson::Array(items) => Ok(items),
        other => Ok(vec![other]),
    }
}
