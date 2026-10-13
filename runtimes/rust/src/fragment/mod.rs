pub mod html;
pub mod ops;
pub mod profiles;
pub mod rules;
pub mod sanitize;
mod tokenizer;
pub mod tree;
pub mod vocabulary;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::Value;
use regex::Regex;
use xript_expr::{
    evaluate_ast, evaluate_repeat_items, expression_kind, parse_cached, parse_repeat_header,
    render, repeat_scope, ExpressionKind, TextSegment, MAX_REPEAT_COPIES,
};
use xript_tree::{
    diff_repeat, replace_keys, resolve_repeat_keys, DiagnosticCode, FragmentRepeat, RepeatKey,
    RepeatKeyProblem, RepeatKeyResolution, RepeatMode, RepeatSite,
};

use crate::error::{FragmentIssue, Result, XriptError};
use crate::manifest::{FragmentDeclaration, ModManifest};

use self::profiles::{
    resolve_format_profile, speaks_html, FormatProfile, Sink, PROTOCOL_PROPS,
};
use self::rules::{is_allowed_attribute, sanitize_style_value, sanitize_uri};
use self::sanitize::{sanitize_fragment, FragmentContentType, SanitizedFragment};
use self::tokenizer::decode_text_entities;
use self::tree::{FragmentElement, FragmentNode, FragmentTree};
use self::vocabulary::{
    apply_sink, DiagnosticSeverity, FragmentDiagnostic, VocabularyOptions,
};

/// Sanitizes an HTML string by parsing it into the fragment tree, sanitizing the
/// tree, and serializing the result — so the output is always well-formed, even
/// when the input leaves elements unclosed.
///
/// Always sanitizes against the built-in HTML profile rather than a caller's,
/// which is what bounds the recursion: the built-in profile declares no sinks, so
/// a nested `html` sink cannot re-enter this function.
pub fn sanitize_html(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }

    let profile = profiles::builtin_profile("text/html").expect("built-in html profile");
    let parsed = vocabulary::sanitize_tree(
        &html::html_to_tree(input, Some(&profile)),
        &profile,
        VocabularyOptions::default(),
    );
    tree::tree_to_html(&parsed.tree)
}

#[derive(Debug, Clone)]
pub struct FragmentResult {
    pub fragment_id: String,
    pub format: String,
    pub content_type: FragmentContentType,
    /// The HTML projection. Empty for a host-declared vocabulary, which the host
    /// mounts from `tree` instead.
    pub html: String,
    /// The bound tree. Always present, for every format.
    pub tree: FragmentTree,
    /// Keyed by `data-if` expression text; two nodes carrying the same condition
    /// collapse into one entry. Deprecated in favour of `conditions`.
    pub visibility: HashMap<String, bool>,
    /// Every `data-if` in the bound tree, keyed by tree position rather than by text.
    pub conditions: Vec<FragmentCondition>,
    /// Every `data-each` expansion, in document order: where its copies sit, their
    /// keys, and how to patch the copies of the previous render into these.
    pub repeats: Vec<FragmentRepeat>,
    pub diagnostics: Vec<FragmentDiagnostic>,
}

impl FragmentResult {
    /// Projects the result into `xript-tree/1`, the one value a renderer receives.
    ///
    /// This is the seam: everything a renderer is allowed to read crosses here, and
    /// `html`, `visibility`, and every runtime-internal type stay behind it.
    pub fn to_rendered(&self) -> xript_tree::RenderedFragment {
        xript_tree::RenderedFragment {
            contract: xript_tree::CONTRACT_VERSION,
            fragment_id: self.fragment_id.clone(),
            format: self.format.clone(),
            content_type: match self.content_type {
                FragmentContentType::Html => xript_tree::ContentType::Html,
                FragmentContentType::Tree => xript_tree::ContentType::Tree,
            },
            tree: self.tree.clone(),
            conditions: self.conditions.clone(),
            repeats: self.repeats.clone(),
            diagnostics: self.diagnostics.clone(),
        }
    }
}

pub fn process_fragment(
    fragment_id: &str,
    sanitized_source: &str,
    bindings: &HashMap<String, serde_json::Value>,
) -> FragmentResult {
    let data_bind_re = Regex::new(
        r#"(<[^>]*\bdata-bind="([^"]*)"[^>]*>)([\s\S]*?)(</[^>]+>)"#,
    ).unwrap();

    let self_closing_bind_re = Regex::new(
        r#"(<[^>]*\bdata-bind="([^"]*)"[^>]*)\s*/>"#,
    ).unwrap();

    let data_if_re = Regex::new(
        r#"<[^>]*\bdata-if="([^"]*)"[^>]*>"#,
    ).unwrap();

    let html = data_bind_re.replace_all(sanitized_source, |caps: &regex::Captures| {
        let open_tag = &caps[1];
        let bind_name = &caps[2];
        let close_tag = &caps[4];

        match bindings.get(bind_name) {
            Some(val) => {
                let text = rules::escape_html(&render(val));
                format!("{}{}{}", open_tag, text, close_tag)
            }
            None => caps[0].to_string(),
        }
    }).to_string();

    let html = self_closing_bind_re.replace_all(&html, |caps: &regex::Captures| {
        let before_close = caps[1].trim_end();
        let bind_name = &caps[2];

        match bindings.get(bind_name) {
            Some(val) => {
                let text = rules::escape_attr_value(&render(val));
                let value_attr = format!("value=\"{}\"", text);
                let value_re = Regex::new(r#"value="[^"]*""#).unwrap();
                if value_re.is_match(before_close) {
                    let updated = value_re.replace(before_close, regex::NoExpand(value_attr.as_str()));
                    format!("{} />", updated)
                } else {
                    format!("{} {} />", before_close, value_attr)
                }
            }
            None => caps[0].to_string(),
        }
    }).to_string();

    let mut visibility = HashMap::new();
    for caps in data_if_re.captures_iter(&html) {
        let expression = decode_text_entities(&caps[1]);
        let result = evaluate_condition(&expression, bindings);
        visibility.insert(expression, result);
    }

    FragmentResult {
        fragment_id: fragment_id.to_string(),
        format: "text/html".to_string(),
        content_type: FragmentContentType::Html,
        html,
        tree: Vec::new(),
        visibility,
        conditions: Vec::new(),
        repeats: Vec::new(),
        diagnostics: Vec::new(),
    }
}

/// Evaluates a `data-if` body.
///
/// One grammar, one evaluator, shared with `data-bind` and interpolation. The six-regex
/// ladder this replaced could only read `name op literal`, so `alive && health < 50` was
/// silently `false` here and true in a browser host — the same mod rendering two different
/// ways depending on where it ran.
fn evaluate_condition(expression: &str, bindings: &HashMap<String, serde_json::Value>) -> bool {
    xript_expr::evaluate_condition(expression, bindings)
}

/// Resolves what a `data-bind` writes, or `None` when it writes nothing.
///
/// A value renders through `str()` on both paths, so a bare name renders exactly as the
/// same name inside an expression does: `null` is the empty string, `0` is `"0"`.
///
/// The paths differ only in absence. A bare name whose binding is undeclared, or whose
/// path resolved to nothing, writes nothing, so the fragment's authored fallback
/// survives. An expression always writes, because a computed result has no absent state
/// to fall back from.
fn bind_value(source: &str, bindings: &HashMap<String, serde_json::Value>) -> Option<String> {
    bind_json(source, bindings).as_ref().map(render)
}

/// The bound value with its JSON type intact.
///
/// `data-bind` resolving to `0.62` is the number `0.62` here, not the string
/// `"0.62"`, which is what makes a numeric widget -- a gauge ratio, a sparkline
/// series -- drawable from the tree alone. Whether the type survives into the node
/// depends on what the target prop declares; see [`route_prop_value`].
fn bind_json(source: &str, bindings: &HashMap<String, serde_json::Value>) -> Option<Value> {
    match parse_cached(source) {
        Ok(expression) if expression.kind == ExpressionKind::Expression => {
            Some(evaluate_ast(&expression.ast, bindings))
        }
        Ok(expression) => {
            let name = match &expression.ast {
                xript_expr::Ast::Name(name) => name.clone(),
                _ => source.to_string(),
            };
            bindings.get(&name).cloned()
        }
        Err(_) => bindings.get(source).cloned(),
    }
}

/// Classifies a `data-bind` body. A bare identifier is an lvalue and keeps two-way
/// write-back; anything else computes a value with no inverse and is read-only.
pub fn bind_expression_kind(source: &str) -> Option<ExpressionKind> {
    expression_kind(source)
}

/// Concatenates a segmented text node's resolved content.
///
/// Every piece joins as plain text and the result stays inside a text node, which has no
/// props and no children. A resolved value has nowhere to land that would make it markup,
/// and the tokenizer is never re-entered, so a value that itself contains `{{` or a tag is
/// inert text.
pub fn resolve_segments(
    segments: &[TextSegment],
    bindings: &HashMap<String, serde_json::Value>,
) -> String {
    xript_expr::resolve_segments(segments, bindings)
}

/// The value at a dotted path, or `Null` when any segment is missing. Use
/// [`lookup_binding_path`] where a missing path must stay distinguishable from `null`.
pub fn resolve_binding_path(data: &serde_json::Value, path: &str) -> serde_json::Value {
    lookup_binding_path(data, path).cloned().unwrap_or(serde_json::Value::Null)
}

/// The value at a dotted path, or `None` when any segment is missing. A present `null`
/// is `Some(Null)`.
///
/// A segment walks a key of an object or a canonical numeric index of an array
/// (`items.0`), and nothing else: never a primitive's property (`name.length`) and never
/// an array's `length`.
pub fn lookup_binding_path<'a>(data: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    path.split('.').try_fold(data, |current, part| match current {
        serde_json::Value::Object(map) => map.get(part),
        serde_json::Value::Array(items) => canonical_index(part).and_then(|index| items.get(index)),
        _ => None,
    })
}

fn canonical_index(part: &str) -> Option<usize> {
    let canonical = !part.is_empty()
        && part.bytes().all(|byte| byte.is_ascii_digit())
        && (part == "0" || !part.starts_with('0'));
    if canonical { part.parse().ok() } else { None }
}

/// Resolves each declared binding against `data`. A binding whose path is missing is left
/// out of the map rather than set to `null`, so a bare-name `data-bind` on it writes
/// nothing and the authored fallback survives, while a present `null` renders as empty.
pub fn resolve_bindings(
    declarations: &[crate::manifest::FragmentBinding],
    data: &serde_json::Value,
) -> HashMap<String, serde_json::Value> {
    declarations
        .iter()
        .filter_map(|binding| {
            lookup_binding_path(data, &binding.path).map(|value| (binding.name.clone(), value.clone()))
        })
        .collect()
}

/// Host-supplied context for resolving and sanitizing a fragment.
#[derive(Debug, Clone, Default)]
pub struct FragmentOptions {
    /// The host manifest's top-level `formats` block.
    pub formats: Option<serde_json::Value>,
    /// The host manifest's top-level `vocabularies` block.
    pub vocabularies: Option<serde_json::Value>,
    /// Promotes an unknown node under the built-in HTML vocabulary from a
    /// warning to an error.
    pub strict_html_vocabulary: bool,
}

#[derive(Debug, Clone)]
pub struct FragmentInstance {
    pub id: String,
    pub slot: String,
    pub format: String,
    pub priority: i32,
    pub declaration: FragmentDeclaration,
    /// The HTML projection of the sanitized source. Empty for a host-declared
    /// vocabulary; prefer `sanitized_tree`, which is populated for every format.
    pub sanitized_source: String,
    pub sanitized_tree: FragmentTree,
    pub content_type: FragmentContentType,
    pub profile: FormatProfile,
    pub diagnostics: Vec<FragmentDiagnostic>,
    repeat_state: RepeatStateCell,
}

/// What each repeat site looked like on the previous render, keyed by
/// [`RepeatSite::id`]. Carried from one `get_content` to the next so each repeat can
/// report how to patch the copies the host already drew.
pub type RepeatState = HashMap<String, (RepeatMode, Vec<RepeatKey>)>;

#[derive(Debug, Default)]
struct RepeatStateCell(Mutex<Option<RepeatState>>);

impl Clone for RepeatStateCell {
    fn clone(&self) -> Self {
        RepeatStateCell(Mutex::new(self.take_snapshot()))
    }
}

impl RepeatStateCell {
    fn take_snapshot(&self) -> Option<RepeatState> {
        self.0.lock().map(|state| state.clone()).unwrap_or(None)
    }

    fn replace(&self, next: RepeatState) {
        if let Ok(mut state) = self.0.lock() {
            *state = Some(next);
        }
    }
}

impl FragmentInstance {
    pub fn get_content(&self, data: &serde_json::Value) -> FragmentResult {
        let bindings = if let Some(ref decls) = self.declaration.bindings {
            resolve_bindings(decls, data)
        } else {
            HashMap::new()
        };

        let previous = self.repeat_state.take_snapshot();
        let bound = process_tree_with_state(
            &self.sanitized_tree,
            &bindings,
            &self.profile,
            previous.as_ref(),
        );
        self.repeat_state.replace(bound.repeat_state.clone());

        // The HTML projection is serialized from the bound tree rather than patched
        // into the sanitized source string. One bind pass feeds both outputs, so an
        // expression-valued `data-bind` and a resolved interpolation site reach `html`
        // and `tree` identically instead of only the one a regex could see.
        let html = if sanitize::projects_to_html(&self.profile) {
            tree::tree_to_html_for(&bound.tree, &self.profile)
        } else {
            String::new()
        };

        let mut diagnostics = self.diagnostics.clone();
        diagnostics.extend(bound.diagnostics);

        FragmentResult {
            fragment_id: self.id.clone(),
            format: self.format.clone(),
            content_type: self.content_type,
            html,
            tree: bound.tree,
            visibility: bound.visibility,
            conditions: bound.conditions,
            repeats: bound.repeats,
            diagnostics,
        }
    }

    pub fn get_handlers(&self) -> Vec<crate::manifest::FragmentHandler> {
        self.declaration
            .resolved_handlers()
            .cloned()
            .unwrap_or_default()
    }

    #[deprecated(note = "renamed to get_handlers")]
    pub fn get_events(&self) -> Vec<crate::manifest::FragmentHandler> {
        self.get_handlers()
    }
}

/// Resolves the vocabulary a fragment's declared format speaks.
///
/// An unrecognized format is a hard error rather than a silent fall-through to
/// the HTML sanitizer: a source in an unknown syntax run through an HTML cleaner
/// is corrupted at best and misjudged at worst.
pub fn resolve_fragment_profile(
    format: &str,
    fragment_id: &str,
    formats: Option<&serde_json::Value>,
    vocabularies: Option<&serde_json::Value>,
) -> Result<FormatProfile> {
    match resolve_format_profile(format, formats, vocabularies) {
        Err(err) => Err(XriptError::FragmentFormat {
            fragment_id: fragment_id.to_string(),
            format: format.to_string(),
            message: err.message,
        }),
        Ok(None) => Err(XriptError::FragmentFormat {
            fragment_id: fragment_id.to_string(),
            format: format.to_string(),
            message: format!(
                "unknown fragment format '{format}' — declare it in the host manifest's 'formats' block"
            ),
        }),
        Ok(Some(profile)) => Ok(profile),
    }
}

pub fn create_fragment_instance(
    declaration: &FragmentDeclaration,
    source: &str,
    options: &FragmentOptions,
) -> Result<FragmentInstance> {
    let profile = resolve_fragment_profile(
        &declaration.format,
        &declaration.id,
        options.formats.as_ref(),
        options.vocabularies.as_ref(),
    )?;

    let sanitized: SanitizedFragment = sanitize_fragment(
        source,
        &profile,
        VocabularyOptions {
            strict_vocabulary: options.strict_html_vocabulary,
            interpolate: declaration.interpolate.unwrap_or(false),
        },
    )
    .map_err(|err| XriptError::FragmentParse {
        fragment_id: declaration.id.clone(),
        format: err.format,
        message: err.message,
    })?;

    let errors: Vec<FragmentIssue> = sanitized
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
        .map(|diagnostic| FragmentIssue {
            path: diagnostic.path.clone(),
            message: diagnostic.message.clone(),
        })
        .collect();
    if !errors.is_empty() {
        return Err(XriptError::FragmentSanitize {
            fragment_id: declaration.id.clone(),
            diagnostics: errors,
        });
    }

    Ok(FragmentInstance {
        id: declaration.id.clone(),
        slot: declaration.slot.clone(),
        format: declaration.format.clone(),
        priority: declaration.priority.unwrap_or(0),
        declaration: declaration.clone(),
        sanitized_source: sanitized.html,
        sanitized_tree: sanitized.tree,
        content_type: sanitized.content_type,
        profile,
        diagnostics: sanitized.diagnostics,
        repeat_state: RepeatStateCell::default(),
    })
}

pub use xript_tree::FragmentCondition;

#[derive(Debug, Clone, Default)]
pub struct BoundTree {
    pub tree: FragmentTree,
    /// Keyed by `data-if` expression text, so two nodes carrying the same condition
    /// collapse into one entry. Deprecated in favour of `conditions`; still populated,
    /// last-write-wins, as before.
    pub visibility: HashMap<String, bool>,
    /// Every `data-if` in the bound tree, keyed by tree position rather than by text.
    pub conditions: Vec<FragmentCondition>,
    /// Every `data-each` expansion, in document order.
    pub repeats: Vec<FragmentRepeat>,
    /// Findings the bind pass made: bound values the vocabulary refused to write,
    /// duplicate or invalid repeat keys, and the copy ceiling.
    pub diagnostics: Vec<FragmentDiagnostic>,
    /// This render's repeat sites, to pass back as `previous` on the next render.
    pub repeat_state: RepeatState,
}

/// Applies `data-each`, `data-bind`, and `data-if` across a sanitized tree, with no
/// previous render to patch against.
pub fn process_tree(
    tree: &[FragmentNode],
    bindings: &HashMap<String, serde_json::Value>,
    profile: &FormatProfile,
) -> BoundTree {
    process_tree_with_state(tree, bindings, profile, None)
}

struct BindContext<'a> {
    profile: &'a FormatProfile,
    visibility: HashMap<String, bool>,
    conditions: Vec<FragmentCondition>,
    repeats: Vec<FragmentRepeat>,
    diagnostics: Vec<FragmentDiagnostic>,
    previous: Option<&'a RepeatState>,
    next: RepeatState,
    remaining_copies: usize,
}

/// Applies `data-each`, `data-bind`, and `data-if` across a sanitized tree.
///
/// `data-if` records visibility but never prunes: fragments stay inert and the
/// host decides what a hidden node means in its own rendering model. A `data-each`
/// template is replaced by its copies before any of their own attributes are read,
/// so a `data-if` on the template is evaluated per copy with the item in scope.
pub fn process_tree_with_state(
    tree: &[FragmentNode],
    bindings: &HashMap<String, serde_json::Value>,
    profile: &FormatProfile,
    previous: Option<&RepeatState>,
) -> BoundTree {
    let mut ctx = BindContext {
        profile,
        visibility: HashMap::new(),
        conditions: Vec::new(),
        repeats: Vec::new(),
        diagnostics: Vec::new(),
        previous,
        next: HashMap::new(),
        remaining_copies: MAX_REPEAT_COPIES,
    };
    let bound = bind_children(tree, bindings, &mut ctx, &[], &[], &[]);
    BoundTree {
        tree: bound,
        visibility: ctx.visibility,
        conditions: ctx.conditions,
        repeats: ctx.repeats,
        diagnostics: ctx.diagnostics,
        repeat_state: ctx.next,
    }
}

fn source_pointer(path: &[usize]) -> String {
    path.iter().map(|index| format!("/{index}")).collect()
}

fn bind_children(
    nodes: &[FragmentNode],
    bindings: &HashMap<String, serde_json::Value>,
    ctx: &mut BindContext,
    parent_path: &[usize],
    parent_source: &[usize],
    within: &[RepeatKey],
) -> Vec<FragmentNode> {
    let mut out = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        let mut source = parent_source.to_vec();
        source.push(index);
        if let FragmentNode::Element(element) = node {
            if let Some(Value::String(each)) = element.props.get("data-each") {
                let each = each.clone();
                expand_repeat(element, &each, bindings, ctx, parent_path, &source, within, &mut out);
                continue;
            }
        }
        let mut path = parent_path.to_vec();
        path.push(out.len());
        out.push(bind_node(node, bindings, ctx, &path, &source, within));
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn expand_repeat(
    template: &FragmentElement,
    each_source: &str,
    bindings: &HashMap<String, serde_json::Value>,
    ctx: &mut BindContext,
    parent_path: &[usize],
    source: &[usize],
    within: &[RepeatKey],
    out: &mut Vec<FragmentNode>,
) {
    let key_source = template.props.get_str("data-key").map(str::to_string);
    let header = parse_repeat_header(each_source).ok();

    let mut items = header
        .as_ref()
        .map(|header| evaluate_repeat_items(header, bindings))
        .unwrap_or_default();
    if items.len() > ctx.remaining_copies {
        ctx.diagnostics.push(FragmentDiagnostic {
            code: DiagnosticCode::RepeatLimit,
            severity: DiagnosticSeverity::Warning,
            path: source_pointer(source),
            node: template.name.clone(),
            prop: Some("data-each".into()),
            message: format!(
                "repeat truncated to {} of {} copies; a render produces at most {}",
                ctx.remaining_copies,
                items.len(),
                MAX_REPEAT_COPIES
            ),
        });
        items.truncate(ctx.remaining_copies);
    }
    ctx.remaining_copies -= items.len();

    let scopes: Vec<HashMap<String, Value>> = match &header {
        Some(header) => items
            .into_iter()
            .enumerate()
            .map(|(index, item)| repeat_scope(bindings, header, item, index))
            .collect(),
        None => Vec::new(),
    };

    let resolution = match &key_source {
        None => RepeatKeyResolution {
            mode: RepeatMode::Replace,
            keys: replace_keys(scopes.len()),
            problem: None,
        },
        Some(key) => resolve_repeat_keys(
            scopes.iter().map(|scope| xript_expr::evaluate(key, scope)).collect(),
        ),
    };
    if let Some(problem) = resolution.problem {
        let key = key_source.as_deref().unwrap_or_default();
        let (code, message) = match problem {
            RepeatKeyProblem::DuplicateKey => (
                DiagnosticCode::DuplicateKey,
                format!("data-key \"{key}\" produced a duplicate key; copies are keyed by index"),
            ),
            RepeatKeyProblem::InvalidKey => (
                DiagnosticCode::InvalidKey,
                format!("data-key \"{key}\" produced a key that is not a string or a number; copies are keyed by index"),
            ),
        };
        ctx.diagnostics.push(FragmentDiagnostic {
            code,
            severity: DiagnosticSeverity::Warning,
            path: source_pointer(source),
            node: template.name.clone(),
            prop: Some("data-key".into()),
            message,
        });
    }

    let site = RepeatSite { template: source.to_vec(), within: within.to_vec() };
    let site_id = site.id();
    let previous = ctx
        .previous
        .and_then(|state| state.get(&site_id))
        .map(|(mode, keys)| (*mode, keys.as_slice()));
    let patch = diff_repeat(previous, (resolution.mode, &resolution.keys));
    ctx.next.insert(site_id, (resolution.mode, resolution.keys.clone()));

    ctx.repeats.push(FragmentRepeat {
        site,
        path: parent_path.to_vec(),
        start: out.len(),
        count: scopes.len(),
        expression: each_source.to_string(),
        key: key_source,
        mode: resolution.mode,
        keys: resolution.keys.clone(),
        patch,
    });

    let copy = FragmentNode::Element(FragmentElement {
        name: template.name.clone(),
        props: template
            .props
            .iter()
            .filter(|(name, _)| name.as_str() != "data-each" && name.as_str() != "data-key")
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect(),
        children: template.children.clone(),
        self_closing: template.self_closing,
    });
    for (index, scope) in scopes.iter().enumerate() {
        let mut path = parent_path.to_vec();
        path.push(out.len());
        let mut copy_within = within.to_vec();
        copy_within.push(resolution.keys[index].clone());
        out.push(bind_node(&copy, scope, ctx, &path, source, &copy_within));
    }
}

/// Why a bound value was not written: the node's vocabulary does not reach the
/// prop at all, or the prop's sink rejected the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindRefusal {
    Undeclared,
    Rejected,
}

/// A bound value the target prop cannot take. The node's reachable props are the
/// ones its vocabulary lists, so a `data-bind` aimed at any other prop writes
/// nothing; the drop is reported rather than silent.
fn bind_refusal(node: &str, prop: &str, refusal: BindRefusal, path: &[usize]) -> FragmentDiagnostic {
    let rendered_path: String = path.iter().map(|index| format!("/{index}")).collect();
    let (code, message) = match refusal {
        BindRefusal::Undeclared => (
            vocabulary::DiagnosticCode::UnknownProp,
            format!(
                "data-bind target \"{prop}\" is not declared on node \"{node}\"; the bound value was dropped"
            ),
        ),
        BindRefusal::Rejected => (
            vocabulary::DiagnosticCode::UnsafeProp,
            format!("data-bind value for prop \"{prop}\" on node \"{node}\" was rejected by its sink"),
        ),
    };
    FragmentDiagnostic {
        code,
        severity: DiagnosticSeverity::Warning,
        path: rendered_path,
        node: node.to_string(),
        prop: Some(prop.to_string()),
        message,
    }
}

fn bind_node(
    node: &FragmentNode,
    bindings: &HashMap<String, serde_json::Value>,
    ctx: &mut BindContext,
    path: &[usize],
    source: &[usize],
    within: &[RepeatKey],
) -> FragmentNode {
    let profile = ctx.profile;
    let element = match node {
        FragmentNode::Text { value, segments } => {
            return match segments {
                None => FragmentNode::text(value.clone()),
                Some(segments) => FragmentNode::text(resolve_segments(segments, bindings)),
            }
        }
        FragmentNode::Element(element) => element,
    };

    let mut props = element.props.clone();
    let mut children = bind_children(&element.children, bindings, ctx, path, source, within);

    if let Some(Value::String(expression)) = props.get("data-if") {
        let expression = expression.clone();
        let visible = evaluate_condition(&expression, bindings);
        ctx.visibility.insert(expression.clone(), visible);
        ctx.conditions.push(FragmentCondition { path: path.to_vec(), expression, visible });
    }

    if let Some(Value::String(source)) = props.get("data-bind") {
        let source = source.clone();
        if let Some(written) = bind_value(&source, bindings) {
            match bind_target(profile, element) {
                // Children are text. A resolved value has nowhere to land inside a
                // text node that would make it markup, so the typed reading has no
                // meaning here.
                target if target == "children" => {
                    children = vec![FragmentNode::text(written)];
                }
                target => {
                    let typed = bind_json(&source, bindings);
                    match route_prop_value(
                        profile,
                        &element.name,
                        &target,
                        &written,
                        typed.as_ref(),
                    ) {
                        Ok(routed) => props.set(target, routed),
                        Err(refusal) => ctx
                            .diagnostics
                            .push(bind_refusal(&element.name, &target, refusal, path)),
                    }
                }
            }
        }
    }

    FragmentNode::Element(FragmentElement {
        name: element.name.clone(),
        props,
        children,
        self_closing: element.self_closing,
    })
}

fn is_void_node(profile: &FormatProfile, element: &FragmentElement) -> bool {
    match profile.node(&element.name) {
        Some(definition) => {
            definition.children == Some(self::profiles::ChildrenConstraint::None)
        }
        None => rules::VOID_ELEMENTS.contains(element.name.as_str()),
    }
}

fn bind_target(profile: &FormatProfile, element: &FragmentElement) -> String {
    if let Some(definition) = profile.node(&element.name)
        && let Some(ref bind_to) = definition.bind_to
    {
        return bind_to.clone();
    }
    if is_void_node(profile, element) {
        "value".to_string()
    } else {
        "children".to_string()
    }
}

/// Routes a bound value into a prop through whatever sink that prop declares,
/// so a binding can never write past the sanitization the source went through.
fn route_prop_value(
    profile: &FormatProfile,
    node_name: &str,
    prop: &str,
    value: &str,
    typed: Option<&Value>,
) -> std::result::Result<Value, BindRefusal> {
    let settle = |routed: Option<String>| routed.map(Value::String).ok_or(BindRefusal::Rejected);

    if let Some(definition) = profile.node(node_name) {
        if PROTOCOL_PROPS.contains(&prop) {
            return Ok(Value::String(value.to_string()));
        }
        let declared = definition.prop(prop).ok_or(BindRefusal::Undeclared)?;
        if declared.sink == Sink::Text {
            // A vocabulary that types a prop as something other than a string is
            // asking for that type, and stringifying into it hands a renderer
            // "0.62" where the profile promised a number. An inert sink is the only
            // place this is safe: every other sink sanitizes strings.
            if let (Some(typed), Some(types)) = (typed, declared.types.as_deref())
                && !types.iter().any(|candidate| candidate == "string")
                && tree::matches_json_type(typed, types)
            {
                return Ok(typed.clone());
            }
            return Ok(Value::String(value.to_string()));
        }
        return settle(apply_sink(declared.sink, value, &profile.schemes));
    }

    if !speaks_html(profile) {
        return Err(BindRefusal::Undeclared);
    }

    let lower = prop.to_lowercase();
    if !is_allowed_attribute(node_name, &lower) {
        return Err(BindRefusal::Undeclared);
    }
    if lower == "href" || lower == "src" {
        return settle(sanitize_uri(value, &lower, &profile.schemes));
    }
    if lower == "style" {
        return Ok(Value::String(sanitize_style_value(value)));
    }
    Ok(Value::String(value.to_string()))
}

#[derive(Debug, Clone)]
pub struct ModInstance {
    pub id: String,
    pub name: String,
    pub version: String,
    pub fragments: Vec<FragmentInstance>,
    pub provides: Vec<crate::manifest::ProviderRole>,
    /// Findings raised while loading this mod, in the order they were raised:
    /// fragment declarations first, then the entry. Under
    /// [`EntryErrorPolicy::Report`](crate::EntryErrorPolicy::Report), an entry
    /// that did not run is recorded here instead of returned as an error.
    pub diagnostics: Vec<crate::mod_load::ModDiagnostic>,
}

impl ModInstance {
    pub fn update_bindings(&self, data: &serde_json::Value) -> Vec<FragmentResult> {
        self.fragments.iter().map(|f| f.get_content(data)).collect()
    }
}

static MOD_ID_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn create_mod_instance(
    mod_manifest: &ModManifest,
    fragment_sources: &HashMap<String, String>,
    options: &FragmentOptions,
) -> Result<ModInstance> {
    let counter = MOD_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("mod-{}-{}", counter, mod_manifest.name);
    let mut fragments = Vec::new();

    if let Some(ref decls) = mod_manifest.fragments {
        for decl in decls {
            let source = if decl.inline.unwrap_or(false) {
                decl.source.clone()
            } else {
                match fragment_sources.get(&decl.source) {
                    Some(supplied) => supplied.clone(),
                    None => empty_source(decl, options)?,
                }
            };
            fragments.push(create_fragment_instance(decl, &source, options)?);
        }
    }

    let provides = mod_manifest
        .contributions
        .as_ref()
        .map(|c| c.provides.clone())
        .unwrap_or_default();

    let diagnostics = crate::mod_load::fragment_declaration_diagnostics(
        &mod_manifest.name,
        mod_manifest.fragments.as_deref().unwrap_or(&[]),
        fragment_sources,
    );

    Ok(ModInstance {
        id,
        name: mod_manifest.name.clone(),
        version: mod_manifest.version.clone(),
        fragments,
        provides,
        diagnostics,
    })
}

/// What an unsupplied fragment source mounts as: an empty document in the
/// format's own syntax, so a missing JSON-syntax source mounts empty (with a
/// diagnostic) the same way a missing HTML source always has, rather than
/// failing to parse an empty string.
fn empty_source(decl: &FragmentDeclaration, options: &FragmentOptions) -> Result<String> {
    let profile = resolve_fragment_profile(
        &decl.format,
        &decl.id,
        options.formats.as_ref(),
        options.vocabularies.as_ref(),
    )?;
    Ok(match profile.syntax {
        profiles::FragmentSyntax::J5ml => "[]".to_string(),
        _ => String::new(),
    })
}

/// An event/hook-slot fill resolved from a mod's `fills`: when the host fires
/// the named hook, the runtime also invokes the mod export the fill names.
#[derive(Debug, Clone)]
pub struct HookFillDecl {
    pub hook: String,
    pub handler: String,
    /// The mod that declared the fill. A handler resolves inside this mod's own
    /// export namespace, so a fill can never reach an export another mod owns.
    pub mod_name: String,
}

/// The outcome of normalizing a mod's `fills`: the rewritten manifest plus the
/// contributions that live outside it because the runtime, not the manifest,
/// dispatches them.
#[derive(Debug, Clone)]
pub struct NormalizedFills {
    pub manifest_json: String,
    pub hook_fills: Vec<HookFillDecl>,
    pub command_fills: Vec<crate::commands::CommandFill>,
}

/// Resolves a mod's canonical `fills` surface into the runtime's internal
/// contribution model, typed by each target slot's `accepts`: a role fill
/// becomes a provider role, an event/hook fill becomes an export-backed hook
/// handler, a command fill becomes a named invocable action, and a
/// fragment-format fill becomes a fragment declaration. A mod that mixes
/// `fills` with the deprecated `fragments`/`contributions` surfaces is rejected
/// rather than silently double-contributing.
pub fn normalize_mod_fills(
    mod_manifest_json: &str,
    slots: &[crate::manifest::Slot],
    granted: &std::collections::HashSet<String>,
) -> Result<NormalizedFills> {
    let mut value: serde_json::Value =
        serde_json::from_str(mod_manifest_json).map_err(XriptError::Json)?;
    let untouched = || NormalizedFills {
        manifest_json: mod_manifest_json.to_string(),
        hook_fills: Vec::new(),
        command_fills: Vec::new(),
    };
    let Some(obj) = value.as_object_mut() else {
        return Ok(untouched());
    };
    if !obj.contains_key("fills") {
        return Ok(untouched());
    }
    if obj.contains_key("fragments") || obj.contains_key("contributions") {
        return Err(XriptError::ManifestValidation {
            issues: vec![crate::error::ValidationIssue {
                path: "/fills".into(),
                message: "a mod contributes through 'fills' alone — remove the deprecated 'fragments'/'contributions' surfaces instead of mixing the two".into(),
            }],
        });
    }
    let fills = obj.remove("fills").expect("checked above");
    let Some(fill_map) = fills.as_object() else {
        return Err(XriptError::ManifestValidation {
            issues: vec![crate::error::ValidationIssue {
                path: "/fills".into(),
                message: "'fills' must be an object keyed by host slot id".into(),
            }],
        });
    };

    let mut issues: Vec<crate::error::ValidationIssue> = Vec::new();
    let mod_name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut fragments: Vec<serde_json::Value> = Vec::new();
    let mut provides: Vec<serde_json::Value> = Vec::new();
    let mut hook_fills: Vec<HookFillDecl> = Vec::new();
    let mut command_fills: Vec<crate::commands::CommandFill> = Vec::new();

    for (slot_id, entries) in fill_map {
        let Some(entries) = entries.as_array() else {
            issues.push(crate::error::ValidationIssue {
                path: format!("/fills/{slot_id}"),
                message: "fill entries must be an array".into(),
            });
            continue;
        };
        let Some(slot) = slots.iter().find(|slot| &slot.id == slot_id) else {
            issues.push(crate::error::ValidationIssue {
                path: format!("/fills/{slot_id}"),
                message: format!("slot '{slot_id}' does not exist in the app manifest"),
            });
            continue;
        };
        let gate_denied = slot
            .capability
            .as_ref()
            .is_some_and(|cap| !crate::cap_match::granted_satisfies(granted, cap));

        // Command fills normalize as a set, because id uniqueness is a
        // property of the whole (mod, slot) pair rather than of one entry.
        if !slot.is_role_slot() && !slot.is_hook_slot() && slot.is_command_slot() {
            let malformed = entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| !entry.is_object())
                .map(|(index, _)| crate::error::ValidationIssue {
                    path: format!("/fills/{slot_id}/{index}"),
                    message: "a fill must be an object".into(),
                })
                .collect::<Vec<_>>();
            if !malformed.is_empty() {
                issues.extend(malformed);
                continue;
            }
            if gate_denied {
                for index in 0..entries.len() {
                    issues.push(crate::error::ValidationIssue {
                        path: format!("/fills/{slot_id}/{index}"),
                        message: format!(
                            "slot '{slot_id}' requires capability '{}'",
                            slot.capability.as_deref().unwrap_or("")
                        ),
                    });
                }
                continue;
            }
            match crate::commands::normalize_command_fills(&mod_name, slot_id, entries) {
                Ok(normalized) => command_fills.extend(normalized),
                Err(defect) => issues.push(crate::error::ValidationIssue {
                    path: defect.path(),
                    message: defect.message(),
                }),
            }
            continue;
        }

        for (index, entry) in entries.iter().enumerate() {
            let prefix = format!("/fills/{slot_id}/{index}");
            let Some(fill) = entry.as_object() else {
                issues.push(crate::error::ValidationIssue {
                    path: prefix,
                    message: "a fill must be an object".into(),
                });
                continue;
            };
            if slot.is_role_slot() {
                if !fill.get("fns").map(|fns| fns.is_object()).unwrap_or(false) {
                    issues.push(crate::error::ValidationIssue {
                        path: format!("{prefix}/fns"),
                        message: "a role fill must map logical fn names to exports via 'fns'".into(),
                    });
                    continue;
                }
                if gate_denied {
                    issues.push(crate::error::ValidationIssue {
                        path: prefix,
                        message: format!(
                            "slot '{slot_id}' requires capability '{}'",
                            slot.capability.as_deref().unwrap_or("")
                        ),
                    });
                    continue;
                }
                provides.push(serde_json::json!({ "role": slot_id, "fns": fill.get("fns").expect("checked above") }));
            } else if slot.is_hook_slot() {
                let handler = fill
                    .get("handler")
                    .and_then(|handler| handler.as_str())
                    .filter(|handler| !handler.is_empty());
                let Some(handler) = handler else {
                    issues.push(crate::error::ValidationIssue {
                        path: format!("{prefix}/handler"),
                        message: "an event/hook fill must name a 'handler' export".into(),
                    });
                    continue;
                };
                if gate_denied {
                    issues.push(crate::error::ValidationIssue {
                        path: prefix,
                        message: format!(
                            "slot '{slot_id}' requires capability '{}'",
                            slot.capability.as_deref().unwrap_or("")
                        ),
                    });
                    continue;
                }
                hook_fills.push(HookFillDecl {
                    hook: slot_id.clone(),
                    handler: handler.to_string(),
                    mod_name: mod_name.clone(),
                });
            } else {
                let mut fragment = serde_json::Map::new();
                fragment.insert("id".into(), serde_json::json!(format!("{slot_id}-fill-{index}")));
                for (key, val) in fill {
                    fragment.insert(key.clone(), val.clone());
                }
                fragment.insert("slot".into(), serde_json::json!(slot_id));
                fragments.push(serde_json::Value::Object(fragment));
            }
        }
    }

    if !issues.is_empty() {
        return Err(XriptError::ManifestValidation { issues });
    }

    if !fragments.is_empty() {
        obj.insert("fragments".into(), serde_json::Value::Array(fragments));
    }
    if !provides.is_empty() {
        obj.insert("contributions".into(), serde_json::json!({ "provides": provides }));
    }

    Ok(NormalizedFills {
        manifest_json: serde_json::to_string(&value).map_err(XriptError::Json)?,
        hook_fills,
        command_fills,
    })
}

pub fn load_mod(
    mod_manifest_json: &str,
    app_manifest: &crate::manifest::Manifest,
    granted_capabilities: &HashSet<String>,
    fragment_sources: &HashMap<String, String>,
) -> Result<ModInstance> {
    load_mod_with_options(
        mod_manifest_json,
        app_manifest,
        granted_capabilities,
        fragment_sources,
        false,
    )
}

pub fn load_mod_with_options(
    mod_manifest_json: &str,
    app_manifest: &crate::manifest::Manifest,
    granted_capabilities: &HashSet<String>,
    fragment_sources: &HashMap<String, String>,
    strict_html_vocabulary: bool,
) -> Result<ModInstance> {
    let mod_manifest: ModManifest = serde_json::from_str(mod_manifest_json)
        .map_err(XriptError::Json)?;

    crate::manifest::validate_mod_manifest(&mod_manifest)?;

    let slots = app_manifest.slots.as_deref().unwrap_or(&[]);
    let cross_issues = crate::manifest::validate_mod_against_app(
        &mod_manifest,
        slots,
        granted_capabilities,
        app_manifest.formats.as_ref(),
        app_manifest.vocabularies.as_ref(),
    );

    if !cross_issues.is_empty() {
        return Err(XriptError::ManifestValidation {
            issues: cross_issues,
        });
    }

    let options = FragmentOptions {
        formats: app_manifest.formats.clone(),
        vocabularies: app_manifest.vocabularies.clone(),
        strict_html_vocabulary,
    };
    create_mod_instance(&mod_manifest, fragment_sources, &options)
}

#[cfg(test)]
mod sanitizer_conformance {
    use super::sanitize_html;

    const CORPUS: &str = include_str!("../../../../spec/sanitizer-tests.json");

    #[derive(serde::Deserialize)]
    struct Case {
        input: String,
        expected: String,
        description: String,
    }

    #[test]
    fn matches_canonical_corpus_byte_for_byte() {
        let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("corpus parses");
        let mut failures = Vec::new();
        for case in &cases {
            let got = sanitize_html(&case.input);
            if got != case.expected {
                failures.push(format!(
                    "case '{}'\n  input:    {:?}\n  expected: {:?}\n  got:      {:?}",
                    case.description, case.input, case.expected, got
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} sanitizer corpus cases failed:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }

    /// Sanitizing the sanitizer's own output must be a fixed point. The output
    /// is markup a host inserts into a live document, where the browser re-parses
    /// it against that context rather than against the tree the sanitizer walked;
    /// if a second pass found anything left to strip, that residue was already
    /// sitting in shipped markup.
    #[test]
    fn output_is_a_fixed_point_across_the_corpus() {
        let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("corpus parses");
        let mut failures = Vec::new();
        for case in &cases {
            let once = sanitize_html(&case.input);
            let twice = sanitize_html(&once);
            if once != twice {
                failures.push(format!(
                    "case '{}' is not stable under re-sanitization
  once:  {:?}
  twice: {:?}",
                    case.description, once, twice
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} corpus cases changed on a second pass:
{}",
            failures.len(),
            cases.len(),
            failures.join("
")
        );
    }

    #[test]
    fn strips_dangerous_data_uri_on_img_src() {
        let out = sanitize_html(r#"<img src="data:text/html,<script>alert('xss')</script>" />"#);
        assert!(!out.contains("data:text/html"));
        assert_eq!(out, "<img />");
    }

    #[test]
    fn preserves_safe_data_image_on_img_src() {
        let out = sanitize_html(r#"<img src="data:image/png;base64,abc123" />"#);
        assert_eq!(out, r#"<img src="data:image/png;base64,abc123" />"#);
    }

    #[test]
    fn strips_data_uri_on_href() {
        let out = sanitize_html(r#"<a href="data:text/html,<script>alert(1)</script>">click</a>"#);
        assert_eq!(out, "<a>click</a>");
    }

    #[test]
    fn collapses_bare_boolean_attributes() {
        let out = sanitize_html(r#"<details open><summary>Info</summary><p>x</p></details>"#);
        assert!(out.contains("<details open>"));
        assert!(!out.contains(r#"open="""#));
    }

    #[test]
    fn renders_void_elements_self_closing() {
        let out = sanitize_html(r#"<img src="icon.png" alt="i" />"#);
        assert!(out.ends_with(" />"));
    }

    #[test]
    fn renders_empty_svg_shapes_self_closing() {
        let out = sanitize_html(r#"<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red" /></svg>"#);
        assert!(out.contains("<circle "));
        assert!(out.contains("/>"));
        assert!(!out.contains("</circle>"));
    }
}
