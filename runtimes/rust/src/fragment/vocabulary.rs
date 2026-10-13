//! The vocabulary walk: default-deny sanitization of a parsed tree against the
//! vocabulary its format declares.

use serde_json::Value;
use xript_expr::{contains_interpolation, segment_text};

use super::html::StrippedAttribute;
use super::profiles::{
    ChildrenConstraint, FormatProfile, FragmentSyntax, NodeDefinition, ResolvedVocabulary, Sink,
    PROTOCOL_PROPS,
};
use super::rules::{
    canonical_attribute_name, is_allowed_attribute, is_valid_attribute_name, sanitize_style_value,
    sanitize_uri, SchemeSet, ALLOWED_ELEMENTS, STRIPPED_ELEMENTS, SVG_TEXT_ATTRIBUTES,
    SVG_TEXT_ELEMENTS, UNWRAPPED_ELEMENTS,
};
use super::tree::{
    is_forbidden_prop_name, js_string, matches_json_type, FragmentElement, FragmentNode,
    FragmentTree, Props,
};

pub use xript_tree::diagnostic::{DiagnosticCode, DiagnosticSeverity, FragmentDiagnostic};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VocabularyOptions {
    /// Promotes an unknown node under a built-in HTML vocabulary from a warning
    /// to an error. HTML's tag surface is open and externally defined, so the
    /// allow-list drops unknown tags rather than refusing the fragment; a host
    /// that wants the stricter contract opts in.
    pub strict_vocabulary: bool,
    /// Turns on `{{ expr }}` segmentation for text nodes. Off by default, and that is
    /// a compatibility requirement rather than a preference: a fragment shipped before
    /// this mode existed may carry `{{` in prose or a code sample, and its meaning must
    /// not change. Mods opt in per fill via the manifest's `interpolate` flag.
    pub interpolate: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TreeSanitizeResult {
    pub tree: FragmentTree,
    pub diagnostics: Vec<FragmentDiagnostic>,
    pub stripped_elements: Vec<String>,
    pub stripped_attributes: Vec<StrippedAttribute>,
}

/// Segments a text node's interpolation sites.
///
/// This runs *inside the sanitizer*, on the way from source to validated tree, and that
/// placement is the structural half of the safety argument: substitution happens later,
/// in the bind pass, over an already-validated tree. There is no code path from a binding
/// value back into the tokenizer, because the tokenizer has already run and is never
/// called again.
fn segment_text_node(value: &str, ctx: &mut Context, path: &str) -> FragmentNode {
    if !ctx.interpolate || !contains_interpolation(value) {
        return FragmentNode::text(value);
    }

    let result = segment_text(value);
    for issue in &result.issues {
        ctx.report(
            DiagnosticCode::InvalidExpression,
            DiagnosticSeverity::Error,
            path,
            "#text",
            None,
            format!("invalid interpolation: {}", issue.message),
        );
    }

    FragmentNode::Text { value: value.to_string(), segments: result.segments }
}

struct Context<'a> {
    profile: &'a FormatProfile,
    strict: bool,
    interpolate: bool,
    diagnostics: Vec<FragmentDiagnostic>,
    stripped_elements: Vec<String>,
    stripped_attributes: Vec<StrippedAttribute>,
    depth: usize,
    /// True while walking the descendants of a built-in `<svg>` element.
    in_svg: bool,
}

impl Context<'_> {
    fn vocabulary_severity(&self) -> DiagnosticSeverity {
        if !self.profile.builtin {
            return DiagnosticSeverity::Error;
        }
        if self.strict {
            DiagnosticSeverity::Error
        } else {
            DiagnosticSeverity::Warning
        }
    }

    fn report(
        &mut self,
        code: DiagnosticCode,
        severity: DiagnosticSeverity,
        path: &str,
        node: &str,
        prop: Option<&str>,
        message: String,
    ) {
        self.diagnostics.push(FragmentDiagnostic {
            code,
            severity,
            path: path.to_string(),
            node: node.to_string(),
            prop: prop.map(str::to_string),
            message,
        });
    }
}

enum Resolution<'a> {
    Declared(&'a NodeDefinition),
    Html(String),
    SvgText(String),
    Stripped(String),
    Unwrap,
    Unknown,
}

/// Applies a fragment format's vocabulary to a parsed tree: node names are
/// matched against the vocabulary, props against each node's declaration, and
/// prop values are routed through the sanitizer their declared sink names.
///
/// Default-deny throughout. A node the vocabulary does not declare is refused:
/// under a host-declared vocabulary that is an error and the subtree is dropped.
/// Under a built-in profile, whose tag surface is open and externally defined,
/// the drop is reported as a warning rather than passing silently, and the
/// disposition follows the source syntax: an HTML-syntax source unwraps the
/// unknown tag so its sanitized children survive, while a JSON-syntax (`jsml`)
/// source drops the whole subtree.
/// A prop name every vocabulary admits by prefix: dataset keys and ARIA
/// attributes. Both are inert metadata, so they are legal on a declared node
/// without the vocabulary naming them one at a time.
pub fn is_metadata_prop_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("data-") || lower.starts_with("aria-")
}

pub fn sanitize_tree(
    tree: &[FragmentNode],
    profile: &FormatProfile,
    options: VocabularyOptions,
) -> TreeSanitizeResult {
    let mut ctx = Context {
        profile,
        strict: options.strict_vocabulary,
        interpolate: options.interpolate,
        diagnostics: Vec::new(),
        stripped_elements: Vec::new(),
        stripped_attributes: Vec::new(),
        depth: 0,
        in_svg: false,
    };

    let sanitized = walk_nodes(tree, &mut ctx, "", &ChildrenConstraint::Any);

    TreeSanitizeResult {
        tree: sanitized,
        diagnostics: ctx.diagnostics,
        stripped_elements: ctx.stripped_elements,
        stripped_attributes: ctx.stripped_attributes,
    }
}

/// The deepest node nesting the walker will descend into.
///
/// The walk is recursive, so input nesting maps directly onto native stack frames.
/// A Rust stack overflow aborts the process and cannot be caught, which would let a
/// mod-supplied fragment kill its host outright, so depth is bounded and reported as
/// a diagnostic instead. The bound is well past any realistic document and low enough
/// to hold in an unoptimized build, where frames are largest.
pub const MAX_TREE_DEPTH: usize = 128;

fn walk_nodes(
    nodes: &[FragmentNode],
    ctx: &mut Context,
    path: &str,
    constraint: &ChildrenConstraint,
) -> FragmentTree {
    if ctx.depth >= MAX_TREE_DEPTH {
        ctx.report(
            DiagnosticCode::MaxDepthExceeded,
            DiagnosticSeverity::Error,
            path,
            "#depth",
            None,
            format!("nesting exceeds the maximum fragment depth of {MAX_TREE_DEPTH}"),
        );
        return Vec::new();
    }

    ctx.depth += 1;
    let result = walk_nodes_bounded(nodes, ctx, path, constraint);
    ctx.depth -= 1;
    result
}

fn walk_nodes_bounded(
    nodes: &[FragmentNode],
    ctx: &mut Context,
    path: &str,
    constraint: &ChildrenConstraint,
) -> FragmentTree {
    let mut result = Vec::new();

    for (index, node) in nodes.iter().enumerate() {
        let node_path = format!("{path}/{index}");

        let element = match node {
            FragmentNode::Text { value, .. } => {
                if constraint.allows_text() {
                    result.push(segment_text_node(value, ctx, &node_path));
                } else if !value.trim().is_empty() {
                    let severity = ctx.vocabulary_severity();
                    ctx.report(
                        DiagnosticCode::IllegalChild,
                        severity,
                        &node_path,
                        "#text",
                        None,
                        format!(
                            "text is not permitted here (children: {})",
                            constraint.describe()
                        ),
                    );
                }
                continue;
            }
            FragmentNode::Element(element) => element,
        };

        match resolve_node(&element.name, ctx.profile, ctx.in_svg) {
            Resolution::Unknown => {
                let severity = ctx.vocabulary_severity();
                ctx.report(
                    DiagnosticCode::UnknownNode,
                    severity,
                    &node_path,
                    &element.name,
                    None,
                    format!(
                        "node \"{}\" is not declared by format \"{}\"",
                        element.name, ctx.profile.id
                    ),
                );
                if severity == DiagnosticSeverity::Warning
                    && ctx.profile.syntax == FragmentSyntax::Html
                {
                    result.extend(walk_nodes(&element.children, ctx, &node_path, constraint));
                }
            }
            Resolution::Stripped(name) => {
                ctx.stripped_elements.push(name.clone());
                ctx.report(
                    DiagnosticCode::StrippedNode,
                    DiagnosticSeverity::Warning,
                    &node_path,
                    &name,
                    None,
                    format!("stripped dangerous element: <{name}>"),
                );
            }
            Resolution::Unwrap => {
                result.extend(walk_nodes(&element.children, ctx, &node_path, constraint));
            }
            Resolution::Declared(definition) => {
                if !constraint.allows_child(&element.name) {
                    let severity = ctx.vocabulary_severity();
                    ctx.report(
                        DiagnosticCode::IllegalChild,
                        severity,
                        &node_path,
                        &element.name,
                        None,
                        format!(
                            "node \"{}\" is not permitted here (children: {})",
                            element.name,
                            constraint.describe()
                        ),
                    );
                    continue;
                }
                let definition = definition.clone();
                result.push(FragmentNode::Element(sanitize_declared_node(
                    element,
                    &definition,
                    ctx,
                    &node_path,
                )));
            }
            Resolution::Html(tag) => {
                if !constraint.allows_child(&tag) {
                    let severity = ctx.vocabulary_severity();
                    ctx.report(
                        DiagnosticCode::IllegalChild,
                        severity,
                        &node_path,
                        &tag,
                        None,
                        format!(
                            "node \"{}\" is not permitted here (children: {})",
                            tag,
                            constraint.describe()
                        ),
                    );
                    continue;
                }
                result.push(FragmentNode::Element(sanitize_html_node(
                    element, &tag, ctx, &node_path,
                )));
            }
            Resolution::SvgText(tag) => {
                if !constraint.allows_child(&tag) {
                    let severity = ctx.vocabulary_severity();
                    ctx.report(
                        DiagnosticCode::IllegalChild,
                        severity,
                        &node_path,
                        &tag,
                        None,
                        format!(
                            "node \"{}\" is not permitted here (children: {})",
                            tag,
                            constraint.describe()
                        ),
                    );
                    continue;
                }
                result.push(FragmentNode::Element(sanitize_svg_text_node(
                    element, &tag, ctx, &node_path,
                )));
            }
        }
    }

    result
}

/// An SVG `title` or `desc`. Text-only: element children are reduced to their
/// text, a stripped element's subtree is dropped outright, and a `style`
/// element's content is dropped rather than surfacing as prose. Each removal is
/// reported. Attributes are held to [`SVG_TEXT_ATTRIBUTES`] plus the inert
/// `data-*`/`aria-*` prefixes.
fn sanitize_svg_text_node(
    node: &FragmentElement,
    tag: &str,
    ctx: &mut Context,
    path: &str,
) -> FragmentElement {
    let mut props = Props::new();

    for (key, value) in node.props.iter() {
        let lower_key = key.to_lowercase();
        let allowed = !is_forbidden_prop_name(&lower_key)
            && is_valid_attribute_name(&lower_key)
            && (SVG_TEXT_ATTRIBUTES.contains(&lower_key.as_str())
                || is_metadata_prop_name(&lower_key));
        if !allowed {
            ctx.stripped_attributes.push(StrippedAttribute {
                element: tag.to_string(),
                attribute: lower_key.clone(),
            });
            let code = if lower_key.starts_with("on") {
                DiagnosticCode::UnsafeProp
            } else {
                DiagnosticCode::UnknownProp
            };
            ctx.report(
                code,
                DiagnosticSeverity::Warning,
                path,
                tag,
                Some(&lower_key),
                format!("stripped attribute \"{lower_key}\" on <{tag}>"),
            );
            continue;
        }
        props.set(lower_key, value.clone());
    }

    let text = collect_svg_text(&node.children, tag, ctx, path);
    let mut children = Vec::new();
    if !text.is_empty() {
        children.push(segment_text_node(&text, ctx, &format!("{path}/0")));
    }

    FragmentElement { name: tag.to_string(), props, children, self_closing: false }
}

fn collect_svg_text(nodes: &[FragmentNode], owner: &str, ctx: &mut Context, path: &str) -> String {
    let mut text = String::new();
    for (index, child) in nodes.iter().enumerate() {
        let child_path = format!("{path}/{index}");
        let element = match child {
            FragmentNode::Text { value, .. } => {
                text.push_str(value);
                continue;
            }
            FragmentNode::Element(element) => element,
        };

        let lower = element.name.to_lowercase();
        if STRIPPED_ELEMENTS.contains(lower.as_str()) {
            ctx.stripped_elements.push(lower.clone());
            ctx.report(
                DiagnosticCode::StrippedNode,
                DiagnosticSeverity::Warning,
                &child_path,
                &lower,
                None,
                format!("stripped dangerous element: <{lower}>"),
            );
            continue;
        }

        let keeps_text = lower != "style";
        let message = if keeps_text {
            format!(
                "node \"{}\" is not permitted inside svg <{owner}>; its text was kept",
                element.name
            )
        } else {
            format!("node \"{}\" is not permitted inside svg <{owner}> and was dropped", element.name)
        };
        ctx.report(
            DiagnosticCode::IllegalChild,
            DiagnosticSeverity::Warning,
            &child_path,
            &element.name,
            None,
            message,
        );
        if keeps_text {
            if ctx.depth >= MAX_TREE_DEPTH {
                ctx.report(
                    DiagnosticCode::MaxDepthExceeded,
                    DiagnosticSeverity::Error,
                    &child_path,
                    "#depth",
                    None,
                    format!("nesting exceeds the maximum fragment depth of {MAX_TREE_DEPTH}"),
                );
                continue;
            }
            ctx.depth += 1;
            text.push_str(&collect_svg_text(&element.children, owner, ctx, &child_path));
            ctx.depth -= 1;
        }
    }
    text
}

/// Walks the vocabularies in scope in order: the first to claim a node name wins.
///
/// The built-in HTML arm falls through rather than terminating, so a name HTML
/// declines is still offered to whatever follows it in scope.
fn resolve_node<'a>(name: &str, profile: &'a FormatProfile, in_svg: bool) -> Resolution<'a> {
    for entry in &profile.scope {
        match entry {
            ResolvedVocabulary::Declared { nodes, .. } => {
                if let Some((_, declared)) = nodes.iter().find(|(key, _)| key == name) {
                    return Resolution::Declared(declared);
                }
            }
            ResolvedVocabulary::BuiltinHtml => {
                let lower = name.to_lowercase();
                if in_svg && SVG_TEXT_ELEMENTS.contains(&lower.as_str()) {
                    return Resolution::SvgText(lower);
                }
                if STRIPPED_ELEMENTS.contains(lower.as_str()) {
                    return Resolution::Stripped(lower);
                }
                if UNWRAPPED_ELEMENTS.contains(lower.as_str())
                    && profile.syntax == FragmentSyntax::Html
                {
                    return Resolution::Unwrap;
                }
                if ALLOWED_ELEMENTS.contains(lower.as_str()) {
                    return Resolution::Html(lower);
                }
            }
        }
    }

    Resolution::Unknown
}

/// Whether a prop value reaches markup as an attribute *value*. `true` projects as
/// a bare attribute and `false`/`null` are omitted entirely, so neither carries text
/// into the document; every other type is stringified into the attribute and must
/// therefore be sanitized when the attribute is a dangerous sink.
fn projects_to_markup(value: &Value) -> bool {
    !matches!(value, Value::Bool(_) | Value::Null)
}

/// The built-in HTML vocabulary. Node and attribute names are folded to lower
/// case, attributes are filtered against a global allow-list, and
/// `href`/`src`/`style` values are routed through the value sanitizers by
/// attribute name.
fn sanitize_html_node(
    node: &FragmentElement,
    tag: &str,
    ctx: &mut Context,
    path: &str,
) -> FragmentElement {
    let mut props = Props::new();

    for (key, value) in node.props.iter() {
        let lower_key = key.to_lowercase();

        if is_forbidden_prop_name(&lower_key) {
            ctx.stripped_attributes.push(StrippedAttribute {
                element: tag.to_string(),
                attribute: lower_key.clone(),
            });
            ctx.report(
                DiagnosticCode::UnsafeProp,
                DiagnosticSeverity::Warning,
                path,
                tag,
                Some(key),
                format!("prop \"{key}\" is reserved and was dropped"),
            );
            continue;
        }

        if !is_valid_attribute_name(&lower_key) {
            ctx.stripped_attributes.push(StrippedAttribute {
                element: tag.to_string(),
                attribute: lower_key.clone(),
            });
            ctx.report(
                DiagnosticCode::UnsafeProp,
                DiagnosticSeverity::Warning,
                path,
                tag,
                Some(key),
                format!("stripped attribute with a malformed name on <{tag}>"),
            );
            continue;
        }

        if !is_allowed_attribute(tag, &lower_key) {
            ctx.stripped_attributes.push(StrippedAttribute {
                element: tag.to_string(),
                attribute: lower_key.clone(),
            });
            let code = if lower_key.starts_with("on") {
                DiagnosticCode::UnsafeProp
            } else {
                DiagnosticCode::UnknownProp
            };
            ctx.report(
                code,
                DiagnosticSeverity::Warning,
                path,
                tag,
                Some(&lower_key),
                format!("stripped attribute \"{lower_key}\" on <{tag}>"),
            );
            continue;
        }

        if (lower_key == "href" || lower_key == "src") && projects_to_markup(value) {
            match sanitize_uri(&js_string(value), &lower_key, &ctx.profile.schemes) {
                None => {
                    ctx.stripped_attributes.push(StrippedAttribute {
                        element: tag.to_string(),
                        attribute: lower_key.clone(),
                    });
                    ctx.report(
                        DiagnosticCode::UnsafeProp,
                        DiagnosticSeverity::Warning,
                        path,
                        tag,
                        Some(&lower_key),
                        format!("stripped attribute \"{lower_key}\" on <{tag}>: unsafe URI"),
                    );
                }
                Some(cleaned) => props.set(lower_key, Value::String(cleaned)),
            }
            continue;
        }

        if lower_key == "style" && projects_to_markup(value) {
            let cleaned = sanitize_style_value(&js_string(value));
            if !cleaned.is_empty() {
                props.set(lower_key, Value::String(cleaned));
            }
            continue;
        }

        props.set(canonical_attribute_name(&lower_key), value.clone());
    }

    let enclosing_svg = ctx.in_svg;
    if tag == "svg" {
        ctx.in_svg = true;
    }
    let children = walk_nodes(&node.children, ctx, path, &ChildrenConstraint::Any);
    ctx.in_svg = enclosing_svg;

    FragmentElement { name: tag.to_string(), props, children, self_closing: node.self_closing }
}

/// A node the host's own vocabulary declares. The name and every prop name are
/// matched verbatim, prop values keep their JSON type, and a value is only
/// sanitized when the prop declares a sink saying where it lands.
fn sanitize_declared_node(
    node: &FragmentElement,
    definition: &NodeDefinition,
    ctx: &mut Context,
    path: &str,
) -> FragmentElement {
    let mut props = Props::new();

    for (key, value) in node.props.iter() {
        if is_forbidden_prop_name(key) || is_event_handler_prop(key) {
            ctx.report(
                DiagnosticCode::UnsafeProp,
                DiagnosticSeverity::Warning,
                path,
                &node.name,
                Some(key),
                format!("prop \"{key}\" is reserved and was dropped"),
            );
            continue;
        }

        if PROTOCOL_PROPS.contains(&key.as_str()) {
            match value {
                Value::String(_) => props.set(key.clone(), value.clone()),
                _ => ctx.report(
                    DiagnosticCode::InvalidProp,
                    DiagnosticSeverity::Warning,
                    path,
                    &node.name,
                    Some(key),
                    format!("prop \"{key}\" must be a string"),
                ),
            }
            continue;
        }

        // `data-*` and `aria-*` are inert by construction and carry no value into a
        // sink, so a vocabulary does not have to enumerate them. The built-in HTML
        // vocabulary already admits both by prefix; a declared one that did not
        // would force a host to restate every dataset key and ARIA attribute it
        // ever writes, and silently drop the ones it forgot.
        if is_metadata_prop_name(key) {
            props.set(key, value.clone());
            continue;
        }

        let Some(declared) = definition.prop(key) else {
            ctx.report(
                DiagnosticCode::UnknownProp,
                DiagnosticSeverity::Warning,
                path,
                &node.name,
                Some(key),
                format!("prop \"{key}\" is not declared on node \"{}\"", node.name),
            );
            continue;
        };

        if let Some(ref types) = declared.types
            && !matches_json_type(value, types)
        {
            let rendered = declared
                .type_json
                .as_ref()
                .map(|value| serde_json::to_string(value).unwrap_or_default())
                .unwrap_or_default();
            ctx.report(
                DiagnosticCode::InvalidProp,
                DiagnosticSeverity::Warning,
                path,
                &node.name,
                Some(key),
                format!("prop \"{key}\" expects type {rendered}"),
            );
            continue;
        }

        let sink = declared.sink;
        if sink == Sink::Text {
            props.set(key.clone(), value.clone());
            continue;
        }

        let Value::String(raw) = value else {
            ctx.report(
                DiagnosticCode::InvalidProp,
                DiagnosticSeverity::Warning,
                path,
                &node.name,
                Some(key),
                format!("prop \"{key}\" declares sink \"{sink}\" and must be a string"),
            );
            continue;
        };

        match apply_sink(sink, raw, &ctx.profile.schemes) {
            None => ctx.report(
                DiagnosticCode::UnsafeProp,
                DiagnosticSeverity::Warning,
                path,
                &node.name,
                Some(key),
                format!("prop \"{key}\" was rejected by sink \"{sink}\""),
            ),
            Some(cleaned) => props.set(key.clone(), Value::String(cleaned)),
        }
    }

    let constraint = definition.children_constraint();

    FragmentElement {
        name: node.name.clone(),
        props,
        children: walk_nodes(&node.children, ctx, path, &constraint),
        self_closing: node.self_closing,
    }
}

/// Event-handler props are a hard floor: rejected even when the vocabulary
/// declares them, because a live handler is the one thing a fragment must never
/// carry out of the sandbox.
fn is_event_handler_prop(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('o') | Some('O')) && matches!(chars.next(), Some('n') | Some('N'))
}

/// Routes a string value through the sanitizer its sink names. Returns `None`
/// when the value must be dropped entirely.
pub fn apply_sink(sink: Sink, value: &str, schemes: &SchemeSet) -> Option<String> {
    match sink {
        Sink::Text => Some(value.to_string()),
        Sink::Uri => sanitize_uri(value, "href", schemes),
        Sink::ImageUri => sanitize_uri(value, "src", schemes),
        Sink::Css => {
            let cleaned = sanitize_style_value(value);
            if cleaned.is_empty() && !value.trim().is_empty() {
                None
            } else {
                Some(cleaned)
            }
        }
        Sink::Html => Some(super::sanitize_html(value)),
    }
}
