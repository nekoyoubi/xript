use crate::value::{format_fixed, js_string_to_number, round_half_up};
use crate::xvalue::{
    contains_units, js_trim_units, key_string, map_case, relative_index, render_units, strict_equal,
    truthy, unit_at, units, X,
};

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

fn numeric(value: &X, op: fn(f64) -> f64) -> X {
    value.as_number().map(|x| X::num(op(x))).unwrap_or(X::Null)
}

pub(crate) fn call(name: &str, args: &[X]) -> X {
    match name {
        "abs" => numeric(&args[0], f64::abs),
        "round" => numeric(&args[0], round_half_up),
        "floor" => numeric(&args[0], f64::floor),
        "ceil" => numeric(&args[0], f64::ceil),
        "min" | "max" => {
            let mut nums = Vec::with_capacity(args.len());
            for arg in args {
                match arg.as_number() {
                    Some(value) => nums.push(value),
                    None => return X::Null,
                }
            }
            let result = if name == "min" {
                nums.iter().copied().fold(f64::INFINITY, f64::min)
            } else {
                nums.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            };
            X::num(result)
        }
        "clamp" => match (args[0].as_number(), args[1].as_number(), args[2].as_number()) {
            (Some(x), Some(lo), Some(hi)) if lo <= hi => X::num(x.max(lo).min(hi)),
            _ => X::Null,
        },
        "fixed" => match (args[0].as_number(), args[1].as_number()) {
            (Some(x), Some(n)) if n.fract() == 0.0 && (0.0..=20.0).contains(&n) => {
                X::str(&format_fixed(x, n as usize))
            }
            _ => X::Null,
        },
        "upper" => match &args[0] {
            X::Str(s) => X::Str(map_case(s, str::to_uppercase)),
            _ => X::Null,
        },
        "lower" => match &args[0] {
            X::Str(s) => X::Str(map_case(s, str::to_lowercase)),
            _ => X::Null,
        },
        "trim" => match &args[0] {
            X::Str(s) => X::Str(js_trim_units(s).to_vec()),
            _ => X::Null,
        },
        "pad" => {
            let text = match &args[0] {
                X::Str(s) => s,
                _ => return X::Null,
            };
            let width = match args[1].as_number() {
                Some(n) if n.fract() == 0.0 && (0.0..=4096.0).contains(&n) => n as usize,
                _ => return X::Null,
            };
            let fill = match args.get(2) {
                None => units(" "),
                Some(X::Str(s)) if !s.is_empty() => s.clone(),
                _ => return X::Null,
            };
            if text.len() >= width {
                return X::Str(text.clone());
            }
            let mut out: Vec<u16> = fill.iter().copied().cycle().take(width - text.len()).collect();
            out.extend_from_slice(text);
            X::Str(out)
        }
        "slice" => {
            let text = match &args[0] {
                X::Str(s) => s,
                _ => return X::Null,
            };
            let start = match args[1].as_number() {
                Some(n) => relative_index(n, text.len()),
                None => return X::Null,
            };
            let end = match args.get(2) {
                None => text.len(),
                Some(value) => match value.as_number() {
                    Some(n) => relative_index(n, text.len()),
                    None => return X::Null,
                },
            };
            X::Str(if start < end { text[start..end].to_vec() } else { Vec::new() })
        }
        "len" => match &args[0] {
            X::Str(s) => X::num(s.len() as f64),
            X::Arr(a) => X::num(a.len() as f64),
            X::Obj(o) => X::num(o.len() as f64),
            _ => X::Null,
        },
        "has" => match (&args[0], &args[1]) {
            (X::Str(s), X::Str(needle)) => X::Bool(contains_units(s, needle)),
            (X::Str(_), _) => X::Bool(false),
            (X::Arr(a), key) => X::Bool(a.iter().any(|item| strict_equal(&X::from_json(item), key))),
            (X::Obj(o), X::Str(key)) => {
                X::Bool(key_string(key).is_some_and(|key| o.contains_key(key.as_str())))
            }
            (X::Obj(_), _) => X::Bool(false),
            _ => X::Null,
        },
        "join" => {
            let array = match &args[0] {
                X::Arr(a) => a,
                _ => return X::Null,
            };
            let sep = match args.get(1) {
                None => units(","),
                Some(X::Str(s)) => s.clone(),
                Some(_) => return X::Null,
            };
            let mut out = Vec::new();
            for (i, item) in array.iter().enumerate() {
                if i > 0 {
                    out.extend_from_slice(&sep);
                }
                out.extend(render_units(&X::from_json(item)));
            }
            X::Str(out)
        }
        "at" => {
            let index = match args[1].as_number() {
                Some(n) if n.fract() == 0.0 => n as i64,
                _ => return X::Null,
            };
            match &args[0] {
                X::Str(s) => unit_at(s, index),
                X::Arr(a) => {
                    let resolved = if index < 0 { a.len() as i64 + index } else { index };
                    if resolved < 0 || resolved as usize >= a.len() {
                        X::Null
                    } else {
                        X::from_json(&a[resolved as usize])
                    }
                }
                _ => X::Null,
            }
        }
        "str" => X::Str(render_units(&args[0])),
        "num" => match &args[0] {
            X::Num(_) => args[0].as_number().map(X::num).unwrap_or(X::Null),
            X::Bool(b) => X::num(if *b { 1.0 } else { 0.0 }),
            X::Str(s) => js_string_to_number(&String::from_utf16_lossy(s)).map(X::num).unwrap_or(X::Null),
            _ => X::Null,
        },
        "bool" => X::Bool(truthy(&args[0])),
        _ => X::Null,
    }
}
