use std::collections::{HashMap, HashSet};

use regex::Regex;

use crate::error::{Result, XriptError};
use crate::manifest::{FragmentDeclaration, ModManifest};

pub fn sanitize_html(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }

    let mut builder = ammonia::Builder::default();

    let allowed_tags: HashSet<&str> = [
        "div", "span", "p",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li", "dl", "dt", "dd",
        "table", "thead", "tbody", "tfoot", "tr", "td", "th",
        "caption", "col", "colgroup",
        "figure", "figcaption", "blockquote", "pre", "code",
        "em", "strong", "b", "i", "u", "s", "small", "sub", "sup",
        "br", "hr",
        "img", "picture", "source", "audio", "video", "track",
        "details", "summary",
        "section", "article", "aside", "nav",
        "header", "footer", "main",
        "a", "abbr", "mark", "time", "wbr",
        "style",
        "input", "textarea", "select", "option", "label",
        "button", "progress", "meter", "output", "fieldset", "legend",
        "svg", "g", "defs", "symbol", "use",
        "circle", "ellipse", "path", "rect", "line", "polygon", "polyline",
        "text", "tspan",
    ].into_iter().collect();

    let stripped_tags: HashSet<&str> = [
        "script", "iframe", "object", "embed", "form",
        "base", "link", "meta", "title",
        "noscript", "applet", "frame", "frameset",
        "param",
        "foreignobject", "animate", "set",
    ].into_iter().collect();

    builder.tags(allowed_tags);
    builder.clean_content_tags(stripped_tags);

    let generic_attrs: HashSet<&str> = [
        "class", "id", "style", "role", "tabindex", "hidden",
        "lang", "dir", "title", "rel",
    ].into_iter().collect();
    builder.generic_attributes(generic_attrs);
    builder.link_rel(None);

    let mut tag_attrs: HashMap<&str, HashSet<&str>> = HashMap::new();

    let img_attrs: HashSet<&str> = ["src", "alt", "width", "height"].into_iter().collect();
    tag_attrs.insert("img", img_attrs);

    let a_attrs: HashSet<&str> = ["href", "target"].into_iter().collect();
    tag_attrs.insert("a", a_attrs);

    let td_attrs: HashSet<&str> = ["colspan", "rowspan", "scope", "headers"].into_iter().collect();
    tag_attrs.insert("td", td_attrs.clone());
    tag_attrs.insert("th", td_attrs);

    let input_attrs: HashSet<&str> = [
        "type", "value", "placeholder", "name", "for",
        "checked", "disabled", "readonly", "required",
        "rows", "cols", "maxlength", "minlength",
        "min", "max", "step", "pattern",
    ].into_iter().collect();
    tag_attrs.insert("input", input_attrs.clone());
    tag_attrs.insert("textarea", input_attrs.clone());
    tag_attrs.insert("select", input_attrs.clone());
    tag_attrs.insert("label", {
        let mut s = HashSet::new();
        s.insert("for");
        s
    });

    let source_attrs: HashSet<&str> = ["src", "type"].into_iter().collect();
    tag_attrs.insert("source", source_attrs);
    tag_attrs.insert("audio", {
        let mut s = HashSet::new();
        s.insert("src");
        s
    });
    tag_attrs.insert("video", {
        let mut s: HashSet<&str> = HashSet::new();
        s.insert("src");
        s.insert("width");
        s.insert("height");
        s
    });
    tag_attrs.insert("track", {
        let mut s: HashSet<&str> = HashSet::new();
        s.insert("src");
        s
    });

    let button_attrs: HashSet<&str> = ["type", "disabled", "name", "value"].into_iter().collect();
    tag_attrs.insert("button", button_attrs);

    let progress_attrs: HashSet<&str> = ["value", "max"].into_iter().collect();
    tag_attrs.insert("progress", progress_attrs);

    let meter_attrs: HashSet<&str> = ["value", "min", "max", "low", "high", "optimum"].into_iter().collect();
    tag_attrs.insert("meter", meter_attrs);

    let output_attrs: HashSet<&str> = ["for", "name"].into_iter().collect();
    tag_attrs.insert("output", output_attrs);

    let fieldset_attrs: HashSet<&str> = ["disabled", "name"].into_iter().collect();
    tag_attrs.insert("fieldset", fieldset_attrs);

    let details_attrs: HashSet<&str> = ["open"].into_iter().collect();
    tag_attrs.insert("details", details_attrs);

    let svg_presentation: HashSet<&str> = [
        "fill", "stroke", "stroke-width", "opacity", "transform",
    ].into_iter().collect();

    let with_presentation = |extra: &[&'static str]| -> HashSet<&str> {
        extra.iter().copied().chain(svg_presentation.iter().copied()).collect()
    };

    let svg_attrs: HashSet<&str> = [
        "viewBox", "preserveAspectRatio", "xmlns",
        "fill", "stroke", "stroke-width", "opacity", "transform",
    ].into_iter().collect();
    tag_attrs.insert("svg", svg_attrs);

    tag_attrs.insert("circle",   with_presentation(&["cx", "cy", "r"]));
    tag_attrs.insert("ellipse",  with_presentation(&["cx", "cy", "rx", "ry"]));
    tag_attrs.insert("rect",     with_presentation(&["x", "y", "width", "height", "rx", "ry"]));
    tag_attrs.insert("line",     with_presentation(&["x1", "y1", "x2", "y2"]));
    tag_attrs.insert("path",     with_presentation(&["d"]));
    tag_attrs.insert("polygon",  with_presentation(&["points"]));
    tag_attrs.insert("polyline", with_presentation(&["points"]));
    tag_attrs.insert("text",     with_presentation(&["x", "y"]));
    tag_attrs.insert("tspan",    with_presentation(&["x", "y"]));

    for tag in ["g", "defs", "symbol"] {
        tag_attrs.insert(tag, svg_presentation.clone());
    }

    tag_attrs.insert("use", with_presentation(&["href", "x", "y", "width", "height"]));

    builder.tag_attributes(tag_attrs);

    builder.generic_attribute_prefixes(["data-", "aria-"].into_iter().collect());

    builder.url_schemes(["http", "https", "mailto", "data"].into_iter().collect());

    builder.strip_comments(true);

    let result = builder.clean(input).to_string();

    let result = sanitize_styles_in_output(&result);
    let result = gate_data_uris(&result);
    normalize_void_and_boolean_attrs(&result)
}

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
    "source", "track", "wbr",
    "circle", "ellipse", "rect", "line", "path", "polygon", "polyline", "use",
];

const BOOLEAN_ATTRS: &[&str] = &[
    "hidden", "open", "checked", "disabled", "readonly", "required", "selected", "multiple",
];

/// Strips `data:` values that are not safe inline images from `src`/`href`
/// attributes. ammonia cannot express data-URI subtype gating, so this runs as
/// a post-pass over the cleaned output. The attribute is dropped entirely on a
/// failed gate (matching the canonical corpus, which expects e.g. `<img />`).
fn gate_data_uris(html: &str) -> String {
    let attr_re = Regex::new(r#"\s(src|href)="([^"]*)""#).unwrap();
    attr_re
        .replace_all(html, |caps: &regex::Captures| {
            let attr_name = &caps[1];
            let value = &caps[2];
            if is_data_uri(value) && !is_safe_data_image(value, attr_name) {
                String::new()
            } else {
                caps[0].to_string()
            }
        })
        .to_string()
}

fn is_data_uri(value: &str) -> bool {
    value.trim_start().to_ascii_lowercase().starts_with("data:")
}

fn is_safe_data_image(value: &str, attr_name: &str) -> bool {
    if attr_name != "src" {
        return false;
    }
    let trimmed = value.trim_start().to_ascii_lowercase();
    for subtype in ["png", "jpeg", "gif", "svg+xml"] {
        let prefix = format!("data:image/{}", subtype);
        if let Some(rest) = trimmed.strip_prefix(&prefix) {
            if rest.starts_with(';') || rest.starts_with(',') {
                return true;
            }
        }
    }
    false
}

/// Rewrites ammonia's HTML5 serialization to match the canonical XHTML-flavored
/// corpus: void/empty-SVG elements close with ` />`, and bare boolean
/// attributes (`hidden=""`) collapse to bare form (`hidden`).
fn normalize_void_and_boolean_attrs(html: &str) -> String {
    let collapsed = collapse_empty_svg_shapes(html);
    let tag_re =
        Regex::new(r#"<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)\s*(/?)>"#).unwrap();
    tag_re
        .replace_all(&collapsed, |caps: &regex::Captures| {
            let tag = &caps[1];
            let attrs = collapse_boolean_attrs(&caps[2]);
            let lower = tag.to_ascii_lowercase();
            let leading_space = if attrs.is_empty() { "" } else { " " };
            if VOID_ELEMENTS.contains(&lower.as_str()) {
                format!("<{}{}{} />", tag, leading_space, attrs)
            } else {
                format!("<{}{}{}>", tag, leading_space, attrs)
            }
        })
        .to_string()
}

fn collapse_boolean_attrs(attrs: &str) -> String {
    let mut result = attrs.to_string();
    for attr in BOOLEAN_ATTRS {
        let pattern = format!(r#"\b{}="""#, attr);
        let re = Regex::new(&pattern).unwrap();
        result = re.replace_all(&result, *attr).to_string();
    }
    result.trim().to_string()
}

/// Empty SVG shape elements that html5ever expands to `<circle></circle>` are
/// re-collapsed to `<circle ... />` to match the corpus.
fn collapse_empty_svg_shapes(html: &str) -> String {
    let empty_re =
        Regex::new(r"<(circle|ellipse|rect|line|path|polygon|polyline|use)((?:[^<>]*?))\s*></(?:circle|ellipse|rect|line|path|polygon|polyline|use)>").unwrap();
    empty_re
        .replace_all(html, |caps: &regex::Captures| {
            let tag = &caps[1];
            let attrs = caps[2].trim_end();
            if attrs.is_empty() {
                format!("<{} />", tag)
            } else {
                format!("<{}{} />", tag, attrs)
            }
        })
        .to_string()
}

fn sanitize_styles_in_output(html: &str) -> String {
    let style_block_re = Regex::new(r"(?s)<style>(.*?)</style>").unwrap();
    let inline_style_re = Regex::new(r#"style="([^"]*)""#).unwrap();

    let result = style_block_re.replace_all(html, |caps: &regex::Captures| {
        let css = &caps[1];
        let cleaned = sanitize_css(css);
        if cleaned.trim().is_empty() {
            String::new()
        } else {
            format!("<style>{}</style>", cleaned)
        }
    }).to_string();

    inline_style_re.replace_all(&result, |caps: &regex::Captures| {
        let style_val = &caps[1];
        let cleaned = sanitize_style_value(style_val);
        if cleaned.is_empty() {
            String::new()
        } else {
            format!("style=\"{}\"", cleaned)
        }
    }).to_string()
}

fn sanitize_css(css: &str) -> String {
    let url_re = Regex::new(r"(?i)url\s*\([^)]*\)").unwrap();
    let expression_re = Regex::new(r"(?i)expression\s*\([^)]*\)").unwrap();
    let moz_binding_re = Regex::new(r"(?i)-moz-binding\s*:[^;}\n]*").unwrap();
    let behavior_re = Regex::new(r"(?i)behavior\s*:[^;}\n]*").unwrap();

    let mut cleaned = css.to_string();
    cleaned = url_re.replace_all(&cleaned, "").to_string();
    cleaned = expression_re.replace_all(&cleaned, "").to_string();
    cleaned = moz_binding_re.replace_all(&cleaned, "").to_string();
    cleaned = behavior_re.replace_all(&cleaned, "").to_string();

    let block_re = Regex::new(r"\{([^}]*)\}").unwrap();
    cleaned = block_re.replace_all(&cleaned, |caps: &regex::Captures| {
        let block = &caps[1];
        let declarations: Vec<&str> = block
            .split(';')
            .map(|d| d.trim())
            .filter(|d| {
                if d.is_empty() { return false; }
                if let Some(colon_idx) = d.find(':') {
                    let value = d[colon_idx + 1..].trim();
                    !value.is_empty()
                } else {
                    false
                }
            })
            .collect();

        if declarations.is_empty() {
            "{}".to_string()
        } else {
            format!("{{ {}; }}", declarations.join("; "))
        }
    }).to_string();

    cleaned
}

fn sanitize_style_value(style: &str) -> String {
    let url_re = Regex::new(r"(?i)url\s*\([^)]*\)").unwrap();
    let expression_re = Regex::new(r"(?i)expression\s*\([^)]*\)").unwrap();
    let moz_binding_re = Regex::new(r"(?i)-moz-binding\s*:[^;]*").unwrap();
    let behavior_re = Regex::new(r"(?i)behavior\s*:[^;]*").unwrap();

    let mut cleaned = style.to_string();
    cleaned = url_re.replace_all(&cleaned, "").to_string();
    cleaned = expression_re.replace_all(&cleaned, "").to_string();
    cleaned = moz_binding_re.replace_all(&cleaned, "").to_string();
    cleaned = behavior_re.replace_all(&cleaned, "").to_string();
    cleaned.trim().to_string()
}

#[derive(Debug, Clone)]
pub struct FragmentResult {
    pub fragment_id: String,
    pub html: String,
    pub visibility: HashMap<String, bool>,
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
                let text = value_to_string(val);
                format!("{}{}{}", open_tag, text, close_tag)
            }
            None => caps[0].to_string(),
        }
    }).to_string();

    let html = self_closing_bind_re.replace_all(&html, |caps: &regex::Captures| {
        let before_close = &caps[1];
        let bind_name = &caps[2];

        match bindings.get(bind_name) {
            Some(val) => {
                let text = value_to_string(val);
                let value_attr = format!("value=\"{}\"", text);
                let value_re = Regex::new(r#"value="[^"]*""#).unwrap();
                if value_re.is_match(before_close) {
                    let updated = value_re.replace(before_close, value_attr.as_str());
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
        let expression = caps[1].to_string();
        let result = evaluate_condition(&expression, bindings);
        visibility.insert(expression, result);
    }

    FragmentResult {
        fragment_id: fragment_id.to_string(),
        html,
        visibility,
    }
}

fn value_to_string(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn evaluate_condition(expression: &str, bindings: &HashMap<String, serde_json::Value>) -> bool {
    let trimmed = expression.trim();

    if let Some(val) = bindings.get(trimmed) {
        return is_truthy(val);
    }

    let lt_re = Regex::new(r"^(\w+)\s*<\s*(\d+(?:\.\d+)?)$").unwrap();
    if let Some(caps) = lt_re.captures(trimmed) {
        let var_name = &caps[1];
        let threshold: f64 = caps[2].parse().unwrap_or(0.0);
        if let Some(val) = bindings.get(var_name) {
            if let Some(n) = val.as_f64() {
                return n < threshold;
            }
        }
        return false;
    }

    let gt_re = Regex::new(r"^(\w+)\s*>\s*(\d+(?:\.\d+)?)$").unwrap();
    if let Some(caps) = gt_re.captures(trimmed) {
        let var_name = &caps[1];
        let threshold: f64 = caps[2].parse().unwrap_or(0.0);
        if let Some(val) = bindings.get(var_name) {
            if let Some(n) = val.as_f64() {
                return n > threshold;
            }
        }
        return false;
    }

    let lte_re = Regex::new(r"^(\w+)\s*<=\s*(\d+(?:\.\d+)?)$").unwrap();
    if let Some(caps) = lte_re.captures(trimmed) {
        let var_name = &caps[1];
        let threshold: f64 = caps[2].parse().unwrap_or(0.0);
        if let Some(val) = bindings.get(var_name) {
            if let Some(n) = val.as_f64() {
                return n <= threshold;
            }
        }
        return false;
    }

    let gte_re = Regex::new(r"^(\w+)\s*>=\s*(\d+(?:\.\d+)?)$").unwrap();
    if let Some(caps) = gte_re.captures(trimmed) {
        let var_name = &caps[1];
        let threshold: f64 = caps[2].parse().unwrap_or(0.0);
        if let Some(val) = bindings.get(var_name) {
            if let Some(n) = val.as_f64() {
                return n >= threshold;
            }
        }
        return false;
    }

    let eq_re = Regex::new(r"^(\w+)\s*===?\s*(\d+(?:\.\d+)?)$").unwrap();
    if let Some(caps) = eq_re.captures(trimmed) {
        let var_name = &caps[1];
        let threshold: f64 = caps[2].parse().unwrap_or(0.0);
        if let Some(val) = bindings.get(var_name) {
            if let Some(n) = val.as_f64() {
                return (n - threshold).abs() < f64::EPSILON;
            }
        }
        return false;
    }

    let neq_re = Regex::new(r"^(\w+)\s*!==?\s*(\d+(?:\.\d+)?)$").unwrap();
    if let Some(caps) = neq_re.captures(trimmed) {
        let var_name = &caps[1];
        let threshold: f64 = caps[2].parse().unwrap_or(0.0);
        if let Some(val) = bindings.get(var_name) {
            if let Some(n) = val.as_f64() {
                return (n - threshold).abs() >= f64::EPSILON;
            }
        }
        return false;
    }

    false
}

fn is_truthy(val: &serde_json::Value) -> bool {
    match val {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().map_or(false, |v| v != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Array(_) => true,
        serde_json::Value::Object(_) => true,
    }
}

pub fn resolve_binding_path(data: &serde_json::Value, path: &str) -> serde_json::Value {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = data;

    for part in parts {
        match current {
            serde_json::Value::Object(map) => {
                if let Some(val) = map.get(part) {
                    current = val;
                } else {
                    return serde_json::Value::Null;
                }
            }
            _ => return serde_json::Value::Null,
        }
    }

    current.clone()
}

pub fn resolve_bindings(
    declarations: &[crate::manifest::FragmentBinding],
    data: &serde_json::Value,
) -> HashMap<String, serde_json::Value> {
    let mut resolved = HashMap::new();
    for binding in declarations {
        resolved.insert(
            binding.name.clone(),
            resolve_binding_path(data, &binding.path),
        );
    }
    resolved
}

#[derive(Debug, Clone)]
pub struct FragmentInstance {
    pub id: String,
    pub slot: String,
    pub format: String,
    pub priority: i32,
    pub declaration: FragmentDeclaration,
    pub sanitized_source: String,
}

impl FragmentInstance {
    pub fn get_content(&self, data: &serde_json::Value) -> FragmentResult {
        let bindings = if let Some(ref decls) = self.declaration.bindings {
            resolve_bindings(decls, data)
        } else {
            HashMap::new()
        };
        process_fragment(&self.id, &self.sanitized_source, &bindings)
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

pub fn create_fragment_instance(
    declaration: &FragmentDeclaration,
    source: &str,
) -> FragmentInstance {
    let sanitized = sanitize_html(source);
    FragmentInstance {
        id: declaration.id.clone(),
        slot: declaration.slot.clone(),
        format: declaration.format.clone(),
        priority: declaration.priority.unwrap_or(0),
        declaration: declaration.clone(),
        sanitized_source: sanitized,
    }
}

#[derive(Debug, Clone)]
pub struct ModInstance {
    pub id: String,
    pub name: String,
    pub version: String,
    pub fragments: Vec<FragmentInstance>,
    pub provides: Vec<crate::manifest::ProviderRole>,
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
) -> ModInstance {
    let counter = MOD_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("mod-{}-{}", counter, mod_manifest.name);
    let mut fragments = Vec::new();

    if let Some(ref decls) = mod_manifest.fragments {
        for decl in decls {
            let source = if decl.inline.unwrap_or(false) {
                decl.source.clone()
            } else {
                fragment_sources.get(&decl.source).cloned().unwrap_or_default()
            };
            fragments.push(create_fragment_instance(decl, &source));
        }
    }

    let provides = mod_manifest
        .contributions
        .as_ref()
        .map(|c| c.provides.clone())
        .unwrap_or_default();

    ModInstance {
        id,
        name: mod_manifest.name.clone(),
        version: mod_manifest.version.clone(),
        fragments,
        provides,
    }
}

/// An event/hook-slot fill resolved from a mod's `fills`: when the host fires
/// the named hook, the runtime also invokes the mod export the fill names.
#[derive(Debug, Clone)]
pub struct HookFillDecl {
    pub hook: String,
    pub handler: String,
}

const ROLE_SLOT_ACCEPT: &str = "application/x-xript-role";

/// Resolves a mod's canonical `fills` surface into the runtime's internal
/// contribution model, typed by each target slot's `accepts`: a fragment-format
/// fill becomes a fragment declaration, a role fill becomes a provider role, an
/// event/hook fill becomes an export-backed hook handler. A mod that mixes
/// `fills` with the deprecated `fragments`/`contributions` surfaces is rejected
/// rather than silently double-contributing.
pub fn normalize_mod_fills(
    mod_manifest_json: &str,
    slots: &[crate::manifest::Slot],
    granted: &std::collections::HashSet<String>,
) -> Result<(String, Vec<HookFillDecl>)> {
    let mut value: serde_json::Value =
        serde_json::from_str(mod_manifest_json).map_err(XriptError::Json)?;
    let Some(obj) = value.as_object_mut() else {
        return Ok((mod_manifest_json.to_string(), Vec::new()));
    };
    if !obj.contains_key("fills") {
        return Ok((mod_manifest_json.to_string(), Vec::new()));
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
    let mut fragments: Vec<serde_json::Value> = Vec::new();
    let mut provides: Vec<serde_json::Value> = Vec::new();
    let mut hook_fills: Vec<HookFillDecl> = Vec::new();

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
        for (index, entry) in entries.iter().enumerate() {
            let prefix = format!("/fills/{slot_id}/{index}");
            let Some(fill) = entry.as_object() else {
                issues.push(crate::error::ValidationIssue {
                    path: prefix,
                    message: "a fill must be an object".into(),
                });
                continue;
            };
            let gate_denied = slot
                .capability
                .as_ref()
                .is_some_and(|cap| !crate::cap_match::granted_satisfies(granted, cap));
            if slot.accepts.iter().any(|accept| accept == ROLE_SLOT_ACCEPT) {
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

    Ok((serde_json::to_string(&value).map_err(XriptError::Json)?, hook_fills))
}

pub fn load_mod(
    mod_manifest_json: &str,
    app_manifest: &crate::manifest::Manifest,
    granted_capabilities: &HashSet<String>,
    fragment_sources: &HashMap<String, String>,
) -> Result<ModInstance> {
    let mod_manifest: ModManifest = serde_json::from_str(mod_manifest_json)
        .map_err(XriptError::Json)?;

    crate::manifest::validate_mod_manifest(&mod_manifest)?;

    let slots = app_manifest.slots.as_deref().unwrap_or(&[]);
    let cross_issues = crate::manifest::validate_mod_against_app(
        &mod_manifest,
        slots,
        granted_capabilities,
    );

    if !cross_issues.is_empty() {
        return Err(XriptError::ManifestValidation {
            issues: cross_issues,
        });
    }

    Ok(create_mod_instance(&mod_manifest, fragment_sources))
}

#[cfg(test)]
mod sanitizer_conformance {
    use super::sanitize_html;

    const CORPUS: &str = include_str!("../../../spec/sanitizer-tests.json");

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
