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
    ].into_iter().collect();

    let stripped_tags: HashSet<&str> = [
        "script", "iframe", "object", "embed", "form",
        "base", "link", "meta", "title",
        "noscript", "applet", "frame", "frameset",
        "param",
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

    builder.tag_attributes(tag_attrs);

    builder.generic_attribute_prefixes(["data-", "aria-"].into_iter().collect());

    builder.url_schemes(["http", "https", "mailto", "data"].into_iter().collect());

    builder.strip_comments(true);

    let result = builder.clean(input).to_string();

    sanitize_styles_in_output(&result)
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

    pub fn get_events(&self) -> Vec<crate::manifest::FragmentEvent> {
        self.declaration.events.clone().unwrap_or_default()
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

#[derive(Debug)]
pub struct ModInstance {
    pub id: String,
    pub name: String,
    pub version: String,
    pub fragments: Vec<FragmentInstance>,
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

    ModInstance {
        id,
        name: mod_manifest.name.clone(),
        version: mod_manifest.version.clone(),
        fragments,
    }
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
