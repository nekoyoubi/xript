//! The built-in HTML vocabulary's rule tables and value sanitizers.
//!
//! Ported verbatim from the canonical implementation so that every runtime
//! applies the same allow-lists and the same value-level sanitization.

use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use regex::Regex;

/// The URI schemes a fragment format admits, lowercase and without the colon.
/// Ordered so diagnostics that enumerate a set read the same way on every run.
pub type SchemeSet = BTreeSet<String>;

pub static ALLOWED_ELEMENTS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "div", "span", "p",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li", "dl", "dt", "dd",
        "table", "thead", "tbody", "tfoot", "tr", "td", "th",
        "caption", "col", "colgroup",
        "figure", "figcaption", "blockquote", "pre", "code",
        "em", "strong", "b", "i", "u", "s", "small", "sub", "sup",
        "br", "hr",
        "img", "picture", "source", "audio", "video", "track",
        "details", "summary", "dialog",
        "canvas", "kbd", "slot",
        "section", "article", "aside", "nav",
        "header", "footer", "main",
        "a", "abbr", "mark", "time", "wbr",
        "style",
        "input", "textarea", "select", "option", "label",
        "button", "progress", "meter", "output", "fieldset", "legend",
        "svg", "g", "defs", "symbol", "use",
        "circle", "ellipse", "path", "rect", "line", "polygon", "polyline",
        "text", "tspan",
    ]
    .into_iter()
    .collect()
});

pub static STRIPPED_ELEMENTS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "script", "iframe", "object", "embed", "form",
        "base", "link", "meta", "title",
        "noscript", "applet", "frame", "frameset",
        "param",
        "foreignobject", "animate", "set",
    ]
    .into_iter()
    .collect()
});

/// SVG's text-content metadata elements. `title` is stripped as HTML's document
/// title, but inside an SVG it is the accessible name and tooltip primitive, and
/// `desc` is its longer description. Both are admitted only under an `<svg>`,
/// hold text alone, and carry only [`SVG_TEXT_ATTRIBUTES`].
pub const SVG_TEXT_ELEMENTS: [&str; 2] = ["title", "desc"];

/// The attributes an SVG `title`/`desc` keeps, beyond the inert `data-*` and `aria-*`.
pub const SVG_TEXT_ATTRIBUTES: [&str; 4] = ["id", "class", "lang", "dir"];

pub static UNWRAPPED_ELEMENTS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| ["html", "head", "body"].into_iter().collect());

pub static VOID_ELEMENTS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    ]
    .into_iter()
    .collect()
});

/// Elements whose content the HTML parser reads as raw text rather than markup.
/// An unclosed one genuinely does run to the end of input, so skipping to EOF is
/// correct for these and only for these.
pub static RAWTEXT_ELEMENTS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "script", "style", "title", "textarea", "noscript", "iframe", "xmp", "noembed",
        "noframes",
    ]
    .into_iter()
    .collect()
});

pub static ALLOWED_ATTRIBUTES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "class", "id", "style",
        "role", "tabindex", "hidden",
        "src", "alt", "width", "height",
        "href", "target", "rel",
        "colspan", "rowspan", "scope", "headers",
        "lang", "dir", "title",
        "part", "slot", "spellcheck", "inputmode", "autocomplete",
        "abbr", "align", "label", "loading", "decoding",
        "popover", "popovertarget",
        "type", "value", "placeholder", "name", "for",
        "checked", "disabled", "readonly", "required",
        "rows", "cols", "maxlength", "minlength",
        "min", "max", "step", "pattern",
        "open", "low", "high", "optimum",
        "cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2", "points", "d",
        "fill", "stroke", "stroke-width", "opacity", "transform",
        "rx", "ry", "dy", "dx", "focusable", "shape-rendering", "text-anchor",
        "stroke-linecap", "stroke-linejoin", "vector-effect",
        "viewbox", "preserveaspectratio", "xmlns",
    ]
    .into_iter()
    .collect()
});

/// Schemes no host may allow-list. A host that names one of these is declaring an
/// XSS sink, so the declaration is refused rather than quietly dropped from its set.
pub const PROHIBITED_URI_SCHEMES: [&str; 2] = ["javascript", "vbscript"];

pub fn is_prohibited_uri_scheme(scheme: &str) -> bool {
    PROHIBITED_URI_SCHEMES.contains(&scheme)
}

/// The scheme set a fragment format gets when it declares none. A host widens or
/// narrows it by declaring `schemes`, which replaces this list wholesale.
pub const DEFAULT_URI_SCHEMES: [&str; 4] = ["http", "https", "mailto", "data"];

static DEFAULT_URI_SCHEME_SET: LazyLock<SchemeSet> =
    LazyLock::new(|| DEFAULT_URI_SCHEMES.iter().map(|scheme| (*scheme).to_string()).collect());

pub fn default_uri_scheme_set() -> &'static SchemeSet {
    &DEFAULT_URI_SCHEME_SET
}

/// A leading scheme. Whitespace before the colon is tolerated so a value cannot
/// dodge the allow-list by padding a scheme a browser would still resolve; a value
/// that matches nothing here carries no scheme at all and is relative.
static URI_SCHEME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z][a-z0-9+.-]*)\s*:").unwrap());

static URI_SCHEME_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9+.-]*$").unwrap());

/// A well-formed scheme name: lowercase, no colon.
pub fn is_valid_uri_scheme_name(scheme: &str) -> bool {
    URI_SCHEME_NAME_PATTERN.is_match(scheme)
}

static SAFE_DATA_IMAGE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^data:image/(png|jpeg|gif|svg\+xml)[;,]").unwrap());

static DANGEROUS_STYLE_PATTERNS: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [
        Regex::new(r"(?i)url\s*\([^)]*\)").unwrap(),
        Regex::new(r"(?i)expression\s*\([^)]*\)").unwrap(),
        Regex::new(r#"(?i)-moz-binding\s*:[^;}"']*"#).unwrap(),
        Regex::new(r#"(?i)behavior\s*:[^;}"']*"#).unwrap(),
    ]
});

static ATTRIBUTE_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_.:-]*$").unwrap());

static STYLE_BLOCK_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{([^}]*)\}").unwrap());

/// A well-formed attribute/prop name. Rejects any name carrying an
/// attribute-list delimiter, which would otherwise let a crafted JSON key break
/// out of the attribute list when the tree is serialized to HTML.
pub fn is_valid_attribute_name(name: &str) -> bool {
    ATTRIBUTE_NAME_PATTERN.is_match(name)
}

/// The attribute allow-list is global rather than per-tag; the tag is accepted
/// only to mirror the canonical signature.
pub fn is_allowed_attribute(_tag: &str, name: &str) -> bool {
    if name.starts_with("data-") || name.starts_with("aria-") {
        return true;
    }
    if name.starts_with("on") {
        return false;
    }
    ALLOWED_ATTRIBUTES.contains(name)
}

/// Returns the value to keep, or `None` when the URI must be dropped entirely.
///
/// The value is normalized the way a browser normalizes a URL before resolving
/// its scheme: ASCII tab, LF, and CR are removed from anywhere in the string, then
/// leading and trailing C0-control-or-space (U+0000 through U+0020) is trimmed.
/// Matching the raw value instead would let `java&#9;script:` reassemble into a live
/// scheme after the tokenizer decodes the entity. The normalized form is what is
/// returned, so the value that ships is the one the browser will resolve, and it is
/// also the value the scheme is read from — reading the scheme from anything less
/// normalized would put the allow-list behind the same smuggling trick the
/// normalization exists to defeat.
///
/// Nothing outside that range is trimmed. A URL parser percent-encodes Unicode
/// whitespace and the byte-order mark into the path rather than stripping them, so
/// trimming them here would ship a different URL than the one that was authored.
///
/// A value carrying no scheme is relative and is never subject to the allow-list:
/// `about.html`, `/abs/path`, `//host/path`, `#anchor`, and `?q=1` all survive
/// whatever the set says.
pub fn sanitize_uri(value: &str, attr_name: &str, schemes: &SchemeSet) -> Option<String> {
    let stripped: String = value.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let trimmed = stripped.trim_matches(|c: char| c <= ' ');
    let lowered = trimmed.to_lowercase();

    let Some(captures) = URI_SCHEME_PATTERN.captures(&lowered) else {
        return Some(trimmed.to_string());
    };
    let scheme = &captures[1];

    if is_prohibited_uri_scheme(scheme) || !schemes.contains(scheme) {
        return None;
    }

    if scheme == "data" {
        if attr_name == "src" && SAFE_DATA_IMAGE_PATTERN.is_match(&lowered) {
            return Some(trimmed.to_string());
        }
        return None;
    }

    Some(trimmed.to_string())
}

pub fn sanitize_style_value(value: &str) -> String {
    let mut cleaned = value.to_string();
    for pattern in DANGEROUS_STYLE_PATTERNS.iter() {
        cleaned = pattern.replace_all(&cleaned, "").into_owned();
    }
    cleaned.trim().to_string()
}

pub fn sanitize_style_block(css: &str) -> String {
    let mut cleaned = css.to_string();
    for pattern in DANGEROUS_STYLE_PATTERNS.iter() {
        cleaned = pattern.replace_all(&cleaned, "").into_owned();
    }

    STYLE_BLOCK_PATTERN
        .replace_all(&cleaned, |caps: &regex::Captures| {
            let declarations: Vec<&str> = caps[1]
                .split(';')
                .map(str::trim)
                .filter(|decl| {
                    if decl.is_empty() {
                        return false;
                    }
                    match decl.find(':') {
                        Some(colon) => !decl[colon + 1..].trim().is_empty(),
                        None => false,
                    }
                })
                .collect();

            if declarations.is_empty() {
                "{}".to_string()
            } else {
                format!("{{ {}; }}", declarations.join("; "))
            }
        })
        .into_owned()
}

pub fn canonical_attribute_name(lower_name: &str) -> String {
    match lower_name {
        "viewbox" => "viewBox".to_string(),
        "preserveaspectratio" => "preserveAspectRatio".to_string(),
        other => other.to_string(),
    }
}

pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Escapes a value for placement inside a double-quoted attribute.
///
/// Quoting alone would make the value inert — a double-quoted attribute does not
/// terminate until an unescaped `"`, and that character is escaped here. Angle
/// brackets and the single quote are escaped anyway so the serialized attribute
/// never carries a raw `<script>` substring: downstream consumers scan output for
/// markup-shaped text, and a value that reads as a tag defeats those checks even
/// when it cannot execute.
pub fn escape_attr_value(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
