use serde_json::{Number, Value};

/// Wraps a float back into a JSON number, collapsing every non-finite result to `null`.
///
/// Division by zero, overflow, and `NaN` all land here. XEG has no infinity and no NaN:
/// a computation that leaves the reals leaves the value domain, and `null` is what the
/// grammar says that looks like.
pub fn finite(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    match Number::from_f64(value) {
        Some(number) => Value::Number(number),
        None => Value::Null,
    }
}

pub fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()),
        _ => None,
    }
}

pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `str()` — the one stringification every runtime shares. `null` renders as empty, which
/// is what makes an absent value disappear from prose rather than spelling out "null".
pub fn render(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() => format_number(f),
            _ => String::new(),
        },
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(render).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JavaScript's `String(number)` for the range fragments actually carry: integers print
/// without a decimal point, everything else prints its shortest round-tripping form.
pub fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{}", value as i64);
    }
    let text = format!("{value}");
    text
}

pub fn is_primitive(value: &Value) -> bool {
    !matches!(value, Value::Array(_) | Value::Object(_))
}

/// Strict equality over the value domain.
///
/// Two arrays or two objects are never equal, even to themselves. XEG has no identity —
/// there is no reference to compare — and structural equality over an unbounded value
/// would make the cost of an expression depend on the data rather than on the AST.
pub fn strict_equal(left: &Value, right: &Value) -> bool {
    if !is_primitive(left) || !is_primitive(right) {
        return false;
    }
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
        _ => left == right,
    }
}

/// Ordering comparisons. Mixed types yield `false` rather than a coercion cascade, so a
/// comparison never quietly succeeds against a value of the wrong shape.
pub fn compare(op: crate::ast::BinaryOp, left: &Value, right: &Value) -> bool {
    use crate::ast::BinaryOp::*;
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) if !x.is_nan() && !y.is_nan() => match op {
                Lt => x < y,
                Le => x <= y,
                Gt => x > y,
                Ge => x >= y,
                _ => false,
            },
            _ => false,
        },
        (Value::String(a), Value::String(b)) => match op {
            Lt => a < b,
            Le => a <= b,
            Gt => a > b,
            Ge => a >= b,
            _ => false,
        },
        _ => false,
    }
}

/// Reads a member. Every miss — a member of `null`, a key an object does not own, an index
/// past the end — yields `null` rather than throwing, so an expression over partial data
/// still renders.
pub fn read_member(target: &Value, key: &MemberKey) -> Value {
    match target {
        Value::Object(map) => match key {
            MemberKey::Name(name) => map.get(name.as_str()).cloned().unwrap_or(Value::Null),
            MemberKey::Index(index) => {
                map.get(&format_number(*index as f64)).cloned().unwrap_or(Value::Null)
            }
        },
        Value::Array(items) => match key {
            MemberKey::Name(name) if name == "length" => finite(items.len() as f64),
            MemberKey::Name(name) => match name.parse::<i64>() {
                Ok(index) => index_array(items, index),
                Err(_) => Value::Null,
            },
            MemberKey::Index(index) => index_array(items, *index),
        },
        Value::String(text) => match key {
            MemberKey::Name(name) if name == "length" => finite(text.chars().count() as f64),
            MemberKey::Name(_) => Value::Null,
            MemberKey::Index(index) => {
                let chars: Vec<char> = text.chars().collect();
                let resolved = if *index < 0 { chars.len() as i64 + index } else { *index };
                if resolved < 0 || resolved as usize >= chars.len() {
                    Value::Null
                } else {
                    Value::String(chars[resolved as usize].to_string())
                }
            }
        },
        _ => Value::Null,
    }
}

fn index_array(items: &[Value], index: i64) -> Value {
    let resolved = if index < 0 { items.len() as i64 + index } else { index };
    if resolved < 0 || resolved as usize >= items.len() {
        Value::Null
    } else {
        items[resolved as usize].clone()
    }
}

pub enum MemberKey {
    Name(String),
    Index(i64),
}
