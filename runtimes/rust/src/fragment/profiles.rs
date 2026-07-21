//! Format profiles: the vocabularies a fragment of a given media type may speak.

use std::fmt;

use super::rules::{
    default_uri_scheme_set, is_prohibited_uri_scheme, is_valid_uri_scheme_name, SchemeSet,
    STRIPPED_ELEMENTS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FragmentSyntax {
    Html,
    J5ml,
}

/// The only vocabulary a format may name without declaring it.
pub const BUILTIN_VOCABULARY_IDS: [&str; 1] = ["html"];

/// Where a prop's value lands. This, not the node's name, is the only thing
/// sanitization ever needed to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sink {
    Text,
    Uri,
    ImageUri,
    Css,
    Html,
}

impl Sink {
    pub fn as_str(self) -> &'static str {
        match self {
            Sink::Text => "text",
            Sink::Uri => "uri",
            Sink::ImageUri => "image-uri",
            Sink::Css => "css",
            Sink::Html => "html",
        }
    }
}

impl fmt::Display for Sink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A JSON Schema body plus the reserved `sink` keyword. Only `sink` and `type`
/// carry runtime meaning; the rest of the schema is the validator's business.
#[derive(Debug, Clone, PartialEq)]
pub struct PropDefinition {
    pub sink: Sink,
    pub types: Option<Vec<String>>,
    /// The `type` keyword exactly as authored, for diagnostic text.
    pub type_json: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChildrenConstraint {
    Any,
    None,
    Text,
    List(Vec<String>),
}

impl ChildrenConstraint {
    pub fn describe(&self) -> String {
        match self {
            ChildrenConstraint::Any => "any".to_string(),
            ChildrenConstraint::None => "none".to_string(),
            ChildrenConstraint::Text => "text".to_string(),
            ChildrenConstraint::List(names) => names.join(", "),
        }
    }

    pub fn allows_text(&self) -> bool {
        matches!(self, ChildrenConstraint::Any | ChildrenConstraint::Text)
    }

    pub fn allows_child(&self, name: &str) -> bool {
        match self {
            ChildrenConstraint::Any => true,
            ChildrenConstraint::None | ChildrenConstraint::Text => false,
            ChildrenConstraint::List(names) => names.iter().any(|candidate| candidate == name),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeDefinition {
    pub props: Vec<(String, PropDefinition)>,
    pub children: Option<ChildrenConstraint>,
    pub bind_to: Option<String>,
}

impl NodeDefinition {
    pub fn prop(&self, name: &str) -> Option<&PropDefinition> {
        self.props.iter().find(|(key, _)| key == name).map(|(_, def)| def)
    }

    pub fn children_constraint(&self) -> ChildrenConstraint {
        self.children.clone().unwrap_or(ChildrenConstraint::Any)
    }
}

/// One vocabulary in a format's resolved scope. A declared vocabulary carries its
/// own nodes and, when it came from the manifest's `vocabularies` block rather than
/// a format's inline `nodes`, the id it was declared under.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedVocabulary {
    Declared {
        id: Option<String>,
        /// Node declarations in a stable order, so diagnostics that enumerate the
        /// vocabulary read the same way on every run.
        nodes: Vec<(String, NodeDefinition)>,
    },
    BuiltinHtml,
}

impl ResolvedVocabulary {
    pub fn declared_nodes(&self) -> &[(String, NodeDefinition)] {
        match self {
            ResolvedVocabulary::Declared { nodes, .. } => nodes,
            ResolvedVocabulary::BuiltinHtml => &[],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormatProfile {
    pub id: String,
    pub syntax: FragmentSyntax,
    /// The vocabularies in scope, in resolution order: the first to claim a node
    /// name wins.
    pub scope: Vec<ResolvedVocabulary>,
    /// The URI schemes a `uri` or `image-uri` value may name, lowercase and without
    /// the colon. Absolute URIs naming anything else are dropped; relative values
    /// carry no scheme and are unaffected. Empty means deliberate closure: no
    /// absolute URIs at all.
    pub schemes: SchemeSet,
    /// True for the four reserved built-in profiles. Drives `content_type`.
    pub builtin: bool,
}

impl FormatProfile {
    /// The definition the first vocabulary in scope claiming `name` gives it.
    /// Names are matched verbatim and case-sensitively; the built-in HTML
    /// vocabulary is not consulted, since it resolves tags rather than declaring
    /// nodes.
    pub fn node(&self, name: &str) -> Option<&NodeDefinition> {
        for entry in &self.scope {
            if let Some((_, definition)) =
                entry.declared_nodes().iter().find(|(key, _)| key == name)
            {
                return Some(definition);
            }
        }
        None
    }
}

/// Whether the built-in HTML vocabulary is anywhere in the format's scope.
pub fn speaks_html(profile: &FormatProfile) -> bool {
    profile.scope.iter().any(|entry| matches!(entry, ResolvedVocabulary::BuiltinHtml))
}

/// Whether any declared vocabulary in scope owns `name` verbatim.
pub fn any_vocabulary_declares(profile: &FormatProfile, name: &str) -> bool {
    profile.node(name).is_some()
}

/// Props legal on every node of every vocabulary. Always strings, never
/// sanitized, never dropped.
pub const PROTOCOL_PROPS: [&str; 3] = ["id", "data-bind", "data-if"];

pub const BUILTIN_FORMAT_IDS: [&str; 4] = [
    "text/html",
    "text/html+jsml",
    "application/j5ml+json",
    "application/jsml+json",
];

/// Slot content types that are not fragments at all and are never sanitized.
pub const NON_FRAGMENT_FORMAT_IDS: [&str; 3] = [
    "application/x-xript-role",
    "application/x-xript-hook",
    "application/x-xript-command",
];

pub fn is_reserved_format_id(format: &str) -> bool {
    BUILTIN_FORMAT_IDS.contains(&format) || NON_FRAGMENT_FORMAT_IDS.contains(&format)
}

pub fn builtin_profile(format: &str) -> Option<FormatProfile> {
    let syntax = match format {
        "text/html" => FragmentSyntax::Html,
        // Despite the name this is an HTML-syntax alias of `text/html`.
        "text/html+jsml" => FragmentSyntax::Html,
        "application/j5ml+json" => FragmentSyntax::J5ml,
        // Deprecated spelling of `application/j5ml+json`; same vocabulary, same parser.
        "application/jsml+json" => FragmentSyntax::J5ml,
        _ => return None,
    };
    Some(FormatProfile {
        id: format.to_string(),
        syntax,
        scope: vec![ResolvedVocabulary::BuiltinHtml],
        schemes: default_uri_scheme_set().clone(),
        builtin: true,
    })
}

/// Why a format declaration was refused. Callers that report rather than raise —
/// the validator's lint pass, chiefly — need to tell an undeclared vocabulary
/// reference apart from a malformed scope without reading the message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatProfileErrorCode {
    Malformed,
    UnknownSyntax,
    UnknownVocabulary,
    HtmlNotLast,
    EmptyScope,
    StrippedNameShadowed,
    InvalidSchemes,
    ProhibitedScheme,
}

impl FormatProfileErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            FormatProfileErrorCode::Malformed => "malformed",
            FormatProfileErrorCode::UnknownSyntax => "unknown-syntax",
            FormatProfileErrorCode::UnknownVocabulary => "unknown-vocabulary",
            FormatProfileErrorCode::HtmlNotLast => "html-not-last",
            FormatProfileErrorCode::EmptyScope => "empty-scope",
            FormatProfileErrorCode::StrippedNameShadowed => "stripped-name-shadowed",
            FormatProfileErrorCode::InvalidSchemes => "invalid-schemes",
            FormatProfileErrorCode::ProhibitedScheme => "prohibited-scheme",
        }
    }
}

impl fmt::Display for FormatProfileErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormatProfileError {
    pub format: String,
    pub message: String,
    pub code: FormatProfileErrorCode,
}

impl fmt::Display for FormatProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FormatProfileError {}

/// Resolves a media type to the vocabularies a fragment of that type may speak.
///
/// Built-in ids always win: a host restating one in its own `formats` block is
/// ignored rather than rejected, matching the schema-level reservation.
///
/// Returns `Ok(None)` when the format is simply unknown; the caller decides
/// whether that is an error in its context.
pub fn resolve_format_profile(
    format: &str,
    formats: Option<&serde_json::Value>,
    vocabularies: Option<&serde_json::Value>,
) -> Result<Option<FormatProfile>, FormatProfileError> {
    if let Some(builtin) = builtin_profile(format) {
        return Ok(Some(builtin));
    }

    let Some(declaration) = formats.and_then(|formats| formats.get(format)) else {
        return Ok(None);
    };

    let refuse = |message: String, code: FormatProfileErrorCode| FormatProfileError {
        format: format.to_string(),
        message,
        code,
    };

    let Some(declaration) = declaration.as_object() else {
        return Err(refuse(
            format!("fragment format \"{format}\" is not an object"),
            FormatProfileErrorCode::Malformed,
        ));
    };

    let syntax = match declaration.get("syntax").and_then(|value| value.as_str()) {
        Some("html") => FragmentSyntax::Html,
        // `jsml` is a deprecated spelling of `j5ml` and parses identically.
        Some("j5ml") | Some("jsml") => FragmentSyntax::J5ml,
        _ => {
            return Err(refuse(
                format!(
                    "fragment format \"{format}\" declares an unknown syntax: {}",
                    json_text(declaration.get("syntax"))
                ),
                FormatProfileErrorCode::UnknownSyntax,
            ));
        }
    };

    let schemes = parse_schemes(declaration.get("schemes"), format)?;

    let mut scope: Vec<ResolvedVocabulary> = Vec::new();

    if let Some(raw_nodes) = declaration.get("nodes") {
        scope.push(ResolvedVocabulary::Declared {
            id: None,
            nodes: parse_nodes(raw_nodes, format, &format!("fragment format \"{format}\""))?,
        });
    }

    if let Some(refs) = declaration.get("vocabularies") {
        let Some(refs) = refs.as_array() else {
            return Err(refuse(
                format!("fragment format \"{format}\" declares a non-array 'vocabularies'"),
                FormatProfileErrorCode::Malformed,
            ));
        };
        for entry in refs {
            let Some(reference) = entry.as_str() else {
                return Err(refuse(
                    format!(
                        "fragment format \"{format}\" references a non-string vocabulary: {}",
                        json_text(Some(entry))
                    ),
                    FormatProfileErrorCode::Malformed,
                ));
            };

            if BUILTIN_VOCABULARY_IDS.contains(&reference) {
                scope.push(ResolvedVocabulary::BuiltinHtml);
                continue;
            }

            if let Some(declared) = vocabularies.and_then(|block| block.get(reference)) {
                if !declared.is_object() {
                    return Err(refuse(
                        format!("vocabulary \"{reference}\" is not an object"),
                        FormatProfileErrorCode::Malformed,
                    ));
                }
                scope.push(ResolvedVocabulary::Declared {
                    id: Some(reference.to_string()),
                    nodes: parse_nodes(
                        declared.get("nodes").unwrap_or(&serde_json::Value::Null),
                        format,
                        &format!("vocabulary \"{reference}\""),
                    )?,
                });
                continue;
            }

            if !reference.contains('.') {
                return Err(refuse(
                    format!(
                        "fragment format \"{format}\" references \"{reference}\", which is not a built-in vocabulary (built-ins: {}); a host-declared vocabulary id needs two or more dot-separated segments",
                        BUILTIN_VOCABULARY_IDS.join(", ")
                    ),
                    FormatProfileErrorCode::UnknownVocabulary,
                ));
            }

            return Err(refuse(
                format!(
                    "fragment format \"{format}\" references an undeclared vocabulary: \"{reference}\""
                ),
                FormatProfileErrorCode::UnknownVocabulary,
            ));
        }
    }

    let html_index =
        scope.iter().position(|entry| matches!(entry, ResolvedVocabulary::BuiltinHtml));

    if let Some(index) = html_index
        && index != scope.len() - 1
    {
        return Err(refuse(
            format!(
                "fragment format \"{format}\" lists the built-in html vocabulary before a declared vocabulary; html must be last so declared nodes always win"
            ),
            FormatProfileErrorCode::HtmlNotLast,
        ));
    }

    if scope.is_empty() {
        return Err(refuse(
            format!("fragment format \"{format}\" declares no vocabulary and admits no nodes"),
            FormatProfileErrorCode::EmptyScope,
        ));
    }

    if html_index.is_some() {
        for entry in &scope {
            for (name, _) in entry.declared_nodes() {
                if !STRIPPED_ELEMENTS.contains(name.to_lowercase().as_str()) {
                    continue;
                }
                return Err(refuse(
                    format!(
                        "fragment format \"{format}\" brings a vocabulary declaring \"{name}\" into scope alongside the built-in html vocabulary; \"{name}\" is an element the sanitizer always strips and may not be shadowed"
                    ),
                    FormatProfileErrorCode::StrippedNameShadowed,
                ));
            }
        }
    }

    Ok(Some(FormatProfile { id: format.to_string(), syntax, scope, schemes, builtin: false }))
}

fn parse_nodes(
    raw: &serde_json::Value,
    format: &str,
    origin: &str,
) -> Result<Vec<(String, NodeDefinition)>, FormatProfileError> {
    let Some(raw_nodes) = raw.as_object() else {
        return Err(FormatProfileError {
            format: format.to_string(),
            message: format!("{origin} declares a non-object 'nodes'"),
            code: FormatProfileErrorCode::Malformed,
        });
    };

    let mut nodes = Vec::new();
    for (name, definition) in raw_nodes {
        let Some(definition) = definition.as_object() else {
            return Err(FormatProfileError {
                format: format.to_string(),
                message: format!("{origin} declares a non-object node: {name}"),
                code: FormatProfileErrorCode::Malformed,
            });
        };
        nodes.push((name.clone(), parse_node_definition(definition)));
    }
    Ok(nodes)
}

/// Reads a format's `schemes` into the effective scheme set.
///
/// Absent means the default safe set. Present replaces it wholesale, so a host both
/// widens and narrows through the same key, and `[]` is deliberate closure rather
/// than a shorthand for the default. Naming `javascript` or `vbscript` is refused
/// outright: dropping them silently would let a host believe it had granted
/// something it had not, and the whole point of the floor is that no host can argue
/// its way under it.
fn parse_schemes(
    raw: Option<&serde_json::Value>,
    format: &str,
) -> Result<SchemeSet, FormatProfileError> {
    let refuse = |message: String, code: FormatProfileErrorCode| FormatProfileError {
        format: format.to_string(),
        message,
        code,
    };

    let Some(raw) = raw else {
        return Ok(default_uri_scheme_set().clone());
    };

    let Some(entries) = raw.as_array() else {
        return Err(refuse(
            format!("fragment format \"{format}\" declares a non-array 'schemes'"),
            FormatProfileErrorCode::InvalidSchemes,
        ));
    };

    let mut schemes = SchemeSet::new();
    for entry in entries {
        let Some(declared) = entry.as_str() else {
            return Err(refuse(
                format!(
                    "fragment format \"{format}\" declares a non-string scheme: {}",
                    json_text(Some(entry))
                ),
                FormatProfileErrorCode::InvalidSchemes,
            ));
        };
        let scheme = declared.to_lowercase();
        if is_prohibited_uri_scheme(&scheme) {
            return Err(refuse(
                format!(
                    "fragment format \"{format}\" declares the prohibited scheme \"{scheme}\"; it is refused in every fragment and cannot be allow-listed"
                ),
                FormatProfileErrorCode::ProhibitedScheme,
            ));
        }
        if !is_valid_uri_scheme_name(&scheme) {
            return Err(refuse(
                format!(
                    "fragment format \"{format}\" declares a malformed scheme: {}; a scheme is a lowercase name with no colon",
                    json_text(Some(entry))
                ),
                FormatProfileErrorCode::InvalidSchemes,
            ));
        }
        schemes.insert(scheme);
    }
    Ok(schemes)
}

fn json_text(value: Option<&serde_json::Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

fn parse_node_definition(definition: &serde_json::Map<String, serde_json::Value>) -> NodeDefinition {
    let mut props = Vec::new();
    if let Some(serde_json::Value::Object(raw_props)) = definition.get("props") {
        for (name, raw) in raw_props {
            props.push((name.clone(), parse_prop_definition(raw)));
        }
    }

    let children = match definition.get("children") {
        Some(serde_json::Value::String(value)) if value == "any" => Some(ChildrenConstraint::Any),
        Some(serde_json::Value::String(value)) if value == "none" => Some(ChildrenConstraint::None),
        Some(serde_json::Value::String(value)) if value == "text" => Some(ChildrenConstraint::Text),
        Some(serde_json::Value::Array(items)) => Some(ChildrenConstraint::List(
            items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect(),
        )),
        _ => None,
    };

    NodeDefinition {
        props,
        children,
        bind_to: definition.get("bindTo").and_then(|v| v.as_str()).map(str::to_string),
    }
}

fn parse_prop_definition(raw: &serde_json::Value) -> PropDefinition {
    let sink = match raw.get("sink").and_then(|value| value.as_str()) {
        Some("uri") => Sink::Uri,
        Some("image-uri") => Sink::ImageUri,
        Some("css") => Sink::Css,
        Some("html") => Sink::Html,
        _ => Sink::Text,
    };

    let type_json = raw.get("type").cloned().filter(|value| !value.is_null());
    let types = type_json.as_ref().and_then(|value| match value {
        serde_json::Value::String(name) => Some(vec![name.clone()]),
        serde_json::Value::Array(items) => {
            Some(items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        }
        _ => None,
    });

    PropDefinition { sink, types, type_json }
}
