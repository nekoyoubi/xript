use serde_json::{Map, Number, Value};

use crate::value::{finite, format_number, is_js_whitespace};

/// A value while an expression evaluates.
///
/// Strings are UTF-16 code units, exactly as JavaScript holds them, so `len`, `slice`, `at`,
/// `[i]`, `pad`, and ordering count and cut the same units the web runtimes do, and a string
/// that `slice` splits mid-pair is rejoined intact by `+`. A lone surrogate can only exist
/// here: when a value leaves the evaluator as JSON it becomes U+FFFD, because a Rust string
/// cannot hold one. Arrays and objects only ever come from bindings, so they stay JSON.
#[derive(Debug, Clone)]
pub(crate) enum X {
    Null,
    Bool(bool),
    Num(Number),
    Str(Vec<u16>),
    Arr(Vec<Value>),
    Obj(Map<String, Value>),
}

/// Object keys a binding value never carries into an expression. The TypeScript evaluator
/// drops them while normalizing a host value, because assigning them would reach a
/// prototype; every implementation drops them so an expression sees the same object.
const DROPPED_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

fn scrub_map(map: &Map<String, Value>) -> Map<String, Value> {
    map.iter()
        .filter(|(key, _)| !DROPPED_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), scrub(value)))
        .collect()
}

fn scrub(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(scrub).collect()),
        Value::Object(map) => Value::Object(scrub_map(map)),
        other => other.clone(),
    }
}

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

impl X {
    pub fn from_json(value: &Value) -> X {
        match value {
            Value::Null => X::Null,
            Value::Bool(b) => X::Bool(*b),
            Value::Number(n) => match n.as_f64() {
                Some(f) if f.is_finite() => X::Num(n.clone()),
                _ => X::Null,
            },
            Value::String(s) => X::Str(units(s)),
            Value::Array(items) => X::Arr(items.iter().map(scrub).collect()),
            Value::Object(map) => X::Obj(scrub_map(map)),
        }
    }

    pub fn str(text: &str) -> X {
        X::Str(units(text))
    }

    /// A computed number. Every non-finite result is `null`.
    pub fn num(value: f64) -> X {
        match finite(value) {
            Value::Number(n) => X::Num(n),
            _ => X::Null,
        }
    }

    pub fn into_json(self) -> Value {
        match self {
            X::Null => Value::Null,
            X::Bool(b) => Value::Bool(b),
            X::Num(n) => Value::Number(n),
            X::Str(s) => Value::String(String::from_utf16_lossy(&s)),
            X::Arr(items) => Value::Array(items),
            X::Obj(map) => Value::Object(map),
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            X::Num(n) => n.as_f64().filter(|f| f.is_finite()),
            _ => None,
        }
    }

    pub fn is_primitive(&self) -> bool {
        !matches!(self, X::Arr(_) | X::Obj(_))
    }
}

pub(crate) fn truthy(value: &X) -> bool {
    match value {
        X::Null => false,
        X::Bool(b) => *b,
        X::Num(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        X::Str(s) => !s.is_empty(),
        X::Arr(_) | X::Obj(_) => true,
    }
}

/// `str()` into a UTF-16 buffer. `null` renders as empty.
pub(crate) fn render_into(value: &X, out: &mut Vec<u16>) {
    match value {
        X::Null => {}
        X::Bool(b) => out.extend(units(if *b { "true" } else { "false" })),
        X::Num(n) => {
            if let Some(f) = n.as_f64().filter(|f| f.is_finite()) {
                out.extend(units(&format_number(f)));
            }
        }
        X::Str(s) => out.extend_from_slice(s),
        X::Arr(items) => {
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(u16::from(b','));
                }
                render_into(&X::from_json(item), out);
            }
        }
        X::Obj(_) => out.extend(units("[object Object]")),
    }
}

pub(crate) fn render_units(value: &X) -> Vec<u16> {
    let mut out = Vec::new();
    render_into(value, &mut out);
    out
}

/// Strict equality. Two arrays or two objects are never equal, even to themselves.
pub(crate) fn strict_equal(left: &X, right: &X) -> bool {
    match (left, right) {
        (X::Null, X::Null) => true,
        (X::Bool(a), X::Bool(b)) => a == b,
        (X::Num(_), X::Num(_)) => left.as_number() == right.as_number() && left.as_number().is_some(),
        (X::Str(a), X::Str(b)) => a == b,
        _ => false,
    }
}

/// Ordering comparisons: two numbers, or two strings by UTF-16 code unit as JavaScript's `<`
/// orders them. Mixed types are `false`.
pub(crate) fn compare(op: crate::ast::BinaryOp, left: &X, right: &X) -> bool {
    use crate::ast::BinaryOp::*;
    use std::cmp::Ordering;
    let order = match (left, right) {
        (X::Num(_), X::Num(_)) => match (left.as_number(), right.as_number()) {
            (Some(x), Some(y)) => x.partial_cmp(&y),
            _ => None,
        },
        (X::Str(a), X::Str(b)) => Some(a.as_slice().cmp(b.as_slice())),
        _ => None,
    };
    match order {
        Some(order) => match op {
            Lt => order == Ordering::Less,
            Le => order != Ordering::Greater,
            Gt => order == Ordering::Greater,
            Ge => order != Ordering::Less,
            _ => false,
        },
        None => false,
    }
}

/// The code unit of `text` at an integer `index`, counting from the end when negative.
pub(crate) fn unit_at(text: &[u16], index: i64) -> X {
    let resolved = if index < 0 { text.len() as i64 + index } else { index };
    if resolved < 0 || resolved as usize >= text.len() {
        X::Null
    } else {
        X::Str(vec![text[resolved as usize]])
    }
}

pub(crate) fn js_trim_units(text: &[u16]) -> &[u16] {
    let is_ws = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(is_js_whitespace);
    let start = text.iter().position(|u| !is_ws(u)).unwrap_or(text.len());
    let end = text.iter().rposition(|u| !is_ws(u)).map(|i| i + 1).unwrap_or(start);
    &text[start..end.max(start)]
}

/// Applies a case mapping to each run of well-formed UTF-16, passing lone surrogates through
/// untouched as JavaScript's `toUpperCase` and `toLowerCase` do.
pub(crate) fn map_case(text: &[u16], map: fn(&str) -> String) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut run = String::new();
    for decoded in char::decode_utf16(text.iter().copied()) {
        match decoded {
            Ok(c) => run.push(c),
            Err(error) => {
                out.extend(units(&map(&run)));
                run.clear();
                out.push(error.unpaired_surrogate());
            }
        }
    }
    out.extend(units(&map(&run)));
    out
}

/// JavaScript's relative index for `String.prototype.slice`: truncated toward zero, counted
/// from the end when negative, and clamped to `0..=len`. Computed in floating point, so an
/// index of any magnitude clamps rather than wrapping.
pub(crate) fn relative_index(index: f64, len: usize) -> usize {
    let index = index.trunc();
    let len = len as f64;
    let resolved = if index < 0.0 { (len + index).max(0.0) } else { index.min(len) };
    resolved as usize
}

pub(crate) fn contains_units(haystack: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|window| window == needle)
}

/// A member key as Rust can look it up: `None` when the key holds a lone surrogate, which no
/// binding's key can.
pub(crate) fn key_string(key: &[u16]) -> Option<String> {
    String::from_utf16(key).ok()
}
