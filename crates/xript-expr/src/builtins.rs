use serde_json::Value;

use crate::value::{as_number, finite, is_truthy, render, strict_equal};

/// Builtin call arity as `(min, max)`, with `usize::MAX` marking a variadic tail.
///
/// The table is closed and extended only by spec revision. A host cannot register a
/// builtin: that would be a capability channel wearing a formatter's clothes, and
/// formatting is not where a capability boundary belongs.
pub fn builtin_arity(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "abs" | "round" | "floor" | "ceil" => (1, 1),
        "min" | "max" => (1, usize::MAX),
        "clamp" => (3, 3),
        "fixed" => (2, 2),
        "upper" | "lower" | "trim" => (1, 1),
        "pad" => (2, 3),
        "slice" => (2, 3),
        "len" => (1, 1),
        "has" => (2, 2),
        "join" => (1, 2),
        "at" => (2, 2),
        "str" | "num" | "bool" => (1, 1),
        _ => return None,
    })
}

pub const BUILTIN_NAMES: &[&str] = &[
    "abs", "round", "floor", "ceil", "min", "max", "clamp", "fixed", "upper", "lower", "trim",
    "pad", "slice", "len", "has", "join", "at", "str", "num", "bool",
];

fn num(value: f64) -> Value {
    finite(value)
}

fn char_at(text: &str, index: i64) -> Value {
    let chars: Vec<char> = text.chars().collect();
    let resolved = if index < 0 { chars.len() as i64 + index } else { index };
    if resolved < 0 || resolved as usize >= chars.len() {
        return Value::Null;
    }
    Value::String(chars[resolved as usize].to_string())
}

fn slice_str(text: &str, from: i64, to: Option<i64>) -> Value {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len() as i64;
    let clamp = |i: i64| -> usize {
        let resolved = if i < 0 { len + i } else { i };
        resolved.clamp(0, len) as usize
    };
    let start = clamp(from);
    let end = to.map(clamp).unwrap_or(len as usize);
    if start >= end {
        return Value::String(String::new());
    }
    Value::String(chars[start..end].iter().collect())
}

pub fn call(name: &str, args: &[Value]) -> Value {
    match name {
        "abs" => as_number(&args[0]).map(|x| num(x.abs())).unwrap_or(Value::Null),
        // JS `Math.round` rounds half *up*, not half away from zero and not half to even.
        // Spelling it out keeps `round(-2.5)` at -2 across every runtime.
        "round" => as_number(&args[0]).map(|x| num((x + 0.5).floor())).unwrap_or(Value::Null),
        "floor" => as_number(&args[0]).map(|x| num(x.floor())).unwrap_or(Value::Null),
        "ceil" => as_number(&args[0]).map(|x| num(x.ceil())).unwrap_or(Value::Null),
        "min" | "max" => {
            let mut nums = Vec::with_capacity(args.len());
            for arg in args {
                match as_number(arg) {
                    Some(value) => nums.push(value),
                    None => return Value::Null,
                }
            }
            let result = if name == "min" {
                nums.iter().copied().fold(f64::INFINITY, f64::min)
            } else {
                nums.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            };
            num(result)
        }
        "clamp" => {
            match (as_number(&args[0]), as_number(&args[1]), as_number(&args[2])) {
                (Some(x), Some(lo), Some(hi)) if lo <= hi => num(x.max(lo).min(hi)),
                _ => Value::Null,
            }
        }
        "fixed" => match (as_number(&args[0]), as_number(&args[1])) {
            (Some(x), Some(n)) if n.fract() == 0.0 && (0.0..=20.0).contains(&n) => {
                Value::String(format_fixed(x, n as usize))
            }
            _ => Value::Null,
        },
        "upper" => match &args[0] {
            Value::String(s) => Value::String(s.to_uppercase()),
            _ => Value::Null,
        },
        "lower" => match &args[0] {
            Value::String(s) => Value::String(s.to_lowercase()),
            _ => Value::Null,
        },
        "trim" => match &args[0] {
            Value::String(s) => Value::String(s.trim().to_string()),
            _ => Value::Null,
        },
        "pad" => {
            let text = match &args[0] {
                Value::String(s) => s,
                _ => return Value::Null,
            };
            let width = match as_number(&args[1]) {
                Some(n) if n.fract() == 0.0 && (0.0..=4096.0).contains(&n) => n as usize,
                _ => return Value::Null,
            };
            let fill = match args.get(2) {
                None => " ".to_string(),
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => return Value::Null,
            };
            let current = text.chars().count();
            if current >= width {
                return Value::String(text.clone());
            }
            let needed = width - current;
            let repeated: String =
                fill.chars().cycle().take(needed).collect();
            Value::String(format!("{repeated}{text}"))
        }
        "slice" => {
            let text = match &args[0] {
                Value::String(s) => s,
                _ => return Value::Null,
            };
            let from = match as_number(&args[1]) {
                Some(n) => n as i64,
                None => return Value::Null,
            };
            match args.get(2) {
                None => slice_str(text, from, None),
                Some(value) => match as_number(value) {
                    Some(n) => slice_str(text, from, Some(n as i64)),
                    None => Value::Null,
                },
            }
        }
        "len" => match &args[0] {
            Value::String(s) => num(s.chars().count() as f64),
            Value::Array(a) => num(a.len() as f64),
            Value::Object(o) => num(o.len() as f64),
            _ => Value::Null,
        },
        "has" => match (&args[0], &args[1]) {
            (Value::String(s), Value::String(needle)) => Value::Bool(s.contains(needle.as_str())),
            (Value::String(_), _) => Value::Bool(false),
            (Value::Array(a), key) => Value::Bool(a.iter().any(|item| strict_equal(item, key))),
            (Value::Object(o), Value::String(key)) => Value::Bool(o.contains_key(key.as_str())),
            (Value::Object(_), _) => Value::Bool(false),
            _ => Value::Null,
        },
        "join" => {
            let array = match &args[0] {
                Value::Array(a) => a,
                _ => return Value::Null,
            };
            let sep = match args.get(1) {
                None => ",".to_string(),
                Some(Value::String(s)) => s.clone(),
                Some(_) => return Value::Null,
            };
            Value::String(array.iter().map(render).collect::<Vec<_>>().join(&sep))
        }
        "at" => {
            let index = match as_number(&args[1]) {
                Some(n) if n.fract() == 0.0 => n as i64,
                _ => return Value::Null,
            };
            match &args[0] {
                Value::String(s) => char_at(s, index),
                Value::Array(a) => {
                    let resolved = if index < 0 { a.len() as i64 + index } else { index };
                    if resolved < 0 || resolved as usize >= a.len() {
                        Value::Null
                    } else {
                        a[resolved as usize].clone()
                    }
                }
                _ => Value::Null,
            }
        }
        "str" => Value::String(render(&args[0])),
        "num" => match &args[0] {
            Value::Number(_) => as_number(&args[0]).map(num).unwrap_or(Value::Null),
            Value::Bool(b) => num(if *b { 1.0 } else { 0.0 }),
            Value::String(s) => {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    Value::Null
                } else {
                    trimmed.parse::<f64>().ok().filter(|n| n.is_finite()).map(num).unwrap_or(Value::Null)
                }
            }
            _ => Value::Null,
        },
        "bool" => Value::Bool(is_truthy(&args[0])),
        _ => Value::Null,
    }
}

/// `Number.prototype.toFixed` semantics: round half away from zero, then pad.
fn format_fixed(value: f64, digits: usize) -> String {
    let factor = 10f64.powi(digits as i32);
    let scaled = value * factor;
    let rounded = if scaled < 0.0 { -(-scaled + 0.5).floor() } else { (scaled + 0.5).floor() };
    format!("{:.*}", digits, rounded / factor)
}
