//! The node shape: what a renderer walks.
//!
//! Prop values are [`serde_json::Value`], so a prop keeps its JSON type all the
//! way to the renderer: strings, numbers, booleans, null, arrays, and objects all
//! survive. Props are held in an order-preserving list rather than a map because
//! prop order is observable in the HTML projection.

use serde_json::Value;

use xript_expr::TextSegment;

/// Prop names that would corrupt the prototype chain of the object a tree is
/// assembled into on a JavaScript host. Rust has no prototype chain, but the
/// names are rejected here too so every runtime produces the same tree and the
/// same diagnostics for the same source.
pub const FORBIDDEN_PROP_NAMES: [&str; 3] = ["__proto__", "constructor", "prototype"];

pub fn is_forbidden_prop_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    FORBIDDEN_PROP_NAMES.contains(&lower.as_str())
}

/// An insertion-ordered prop bag. A repeated name overwrites in place, keeping
/// the position of its first appearance.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Props(Vec<(String, Value)>);

impl Props {
    pub fn new() -> Self {
        Props(Vec::new())
    }

    pub fn set(&mut self, key: impl Into<String>, value: Value) {
        let key = key.into();
        match self.0.iter_mut().find(|(existing, _)| existing == &key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(existing, _)| existing == key).map(|(_, value)| value)
    }

    /// The string reading of a prop, for the props a vocabulary types as text.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    /// The numeric reading of a prop. A bound numeric prop arrives as a JSON
    /// number under `xript-tree/1`; a string that parses is accepted too, so a
    /// hand-authored `"0.5"` still draws.
    pub fn get_f64(&self, key: &str) -> Option<f64> {
        match self.get(key)? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter().map(|(key, value)| (key, value))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

impl FromIterator<(String, Value)> for Props {
    fn from_iter<T: IntoIterator<Item = (String, Value)>>(iter: T) -> Self {
        let mut props = Props::new();
        for (key, value) in iter {
            props.set(key, value);
        }
        props
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FragmentElement {
    /// The node name, case preserved exactly as authored.
    pub name: String,
    pub props: Props,
    pub children: Vec<FragmentNode>,
    /// Serialization hint: the source closed this node with `/>` even though it
    /// is not a void element. Carries no semantics; it exists so the HTML
    /// projection can reproduce the source's syntax.
    pub self_closing: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FragmentNode {
    Text {
        /// The authored source, escapes intact. When `segments` is present this
        /// string is a serialization artifact, not a rendering: consumers render
        /// `segments`. In a bound tree `segments` is always `None` and this
        /// string is final, literal text.
        value: String,
        /// Present iff the node opened at least one interpolation site under an
        /// `interpolate` fill. `None` — never an empty vector — otherwise, so a
        /// non-interpolating fragment produces a tree identical to one parsed
        /// without the mode.
        segments: Option<Vec<TextSegment>>,
    },
    Element(FragmentElement),
}

pub type FragmentTree = Vec<FragmentNode>;

impl FragmentNode {
    /// A plain text node with no interpolation sites.
    pub fn text(value: impl Into<String>) -> Self {
        FragmentNode::Text { value: value.into(), segments: None }
    }

    /// The text a node carries, or `None` for an element.
    pub fn text_value(&self) -> Option<&str> {
        match self {
            FragmentNode::Text { value, .. } => Some(value),
            FragmentNode::Element(_) => None,
        }
    }

    pub fn element(name: impl Into<String>) -> Self {
        FragmentNode::Element(FragmentElement {
            name: name.into(),
            props: Props::new(),
            children: Vec::new(),
            self_closing: false,
        })
    }

    pub fn as_element(&self) -> Option<&FragmentElement> {
        match self {
            FragmentNode::Element(element) => Some(element),
            FragmentNode::Text { .. } => None,
        }
    }
}

/// JavaScript `String(value)` semantics, so an HTML projection of a typed prop
/// renders the same bytes on every runtime.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n
            .as_f64()
            .map(js_number_to_string)
            .unwrap_or_else(|| n.to_string()),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

pub fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    if n.abs() >= 1e21 {
        let rendered = format!("{:e}", n);
        return match rendered.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{}e+{}", mantissa, exponent)
            }
            _ => rendered,
        };
    }
    format!("{}", n)
}

pub fn matches_json_type(value: &Value, types: &[String]) -> bool {
    types.iter().any(|candidate| match candidate.as_str() {
        "string" => matches!(value, Value::String(_)),
        "number" => matches!(value, Value::Number(_)),
        "integer" => matches!(value, Value::Number(n)
            if n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0 && f.is_finite())),
        "boolean" => matches!(value, Value::Bool(_)),
        "null" => matches!(value, Value::Null),
        "array" => matches!(value, Value::Array(_)),
        "object" => matches!(value, Value::Object(_)),
        _ => true,
    })
}
