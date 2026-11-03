use std::collections::HashMap;

use serde_json::Value;

use crate::ast::{Ast, BinaryOp, LogicalOp, UnaryOp};
use crate::builtins;
use crate::value::{format_number, js_number};
use crate::xvalue::{compare, key_string, render_into, strict_equal, truthy, unit_at, units, X};

pub type Bindings = HashMap<String, Value>;

/// Evaluates a parsed expression.
///
/// Total by construction: there is no operation that can fail out of band, so every
/// pathological input lands on `null` rather than aborting a render.
pub fn evaluate_ast(ast: &Ast, bindings: &Bindings) -> Value {
    eval(ast, bindings).into_json()
}

/// The element at an already-resolved position, or `null` when it is not a whole number
/// inside the array.
fn element(items: &[Value], position: f64) -> X {
    if position.fract() != 0.0 || position < 0.0 || position >= items.len() as f64 {
        X::Null
    } else {
        X::from_json(&items[position as usize])
    }
}

/// Reads a named member: an object's own key, `length` of a string or an array, or an
/// array element whose name reads as a number the way JavaScript's `Number` reads it.
fn read_name(target: &X, name: &[u16]) -> X {
    match target {
        X::Obj(map) => key_string(name)
            .and_then(|key| map.get(key.as_str()).map(X::from_json))
            .unwrap_or(X::Null),
        X::Arr(items) if name == units("length").as_slice() => X::num(items.len() as f64),
        X::Arr(items) => element(items, js_number(&String::from_utf16_lossy(name))),
        X::Str(text) if name == units("length").as_slice() => X::num(text.len() as f64),
        _ => X::Null,
    }
}

/// Reads a numeric index: an array element or a string's code unit (a whole number,
/// counting from the end when negative), or the object key that `str` of the number spells.
fn read_index(target: &X, index: f64) -> X {
    match target {
        X::Obj(map) => map.get(&format_number(index)).map(X::from_json).unwrap_or(X::Null),
        X::Arr(items) => element(items, if index < 0.0 { items.len() as f64 + index } else { index }),
        X::Str(text) if index.fract() == 0.0 => unit_at(text, index as i64),
        _ => X::Null,
    }
}

pub(crate) fn eval(ast: &Ast, bindings: &Bindings) -> X {
    match ast {
        Ast::Num(value) => X::num(*value),
        Ast::Str(value) => X::Str(value.clone()),
        Ast::Bool(value) => X::Bool(*value),
        Ast::Null => X::Null,
        Ast::Name(name) => bindings.get(name).map(X::from_json).unwrap_or(X::Null),
        Ast::Member { obj, name } => read_name(&eval(obj, bindings), &units(name)),
        Ast::Index { obj, index } => {
            let target = eval(obj, bindings);
            match eval(index, bindings) {
                key @ X::Num(_) => match key.as_number() {
                    Some(value) => read_index(&target, value),
                    None => X::Null,
                },
                X::Str(key) => read_name(&target, &key),
                _ => X::Null,
            }
        }
        Ast::Unary { op, arg } => {
            let value = eval(arg, bindings);
            match op {
                UnaryOp::Not => X::Bool(!truthy(&value)),
                UnaryOp::Neg => value.as_number().map(|n| X::num(-n)).unwrap_or(X::Null),
                UnaryOp::Pos => value.as_number().map(X::num).unwrap_or(X::Null),
            }
        }
        Ast::Logical { op, left, right } => {
            let lhs = eval(left, bindings);
            match op {
                LogicalOp::And => {
                    if truthy(&lhs) {
                        eval(right, bindings)
                    } else {
                        lhs
                    }
                }
                LogicalOp::Or => {
                    if truthy(&lhs) {
                        lhs
                    } else {
                        eval(right, bindings)
                    }
                }
                LogicalOp::Nullish => {
                    if matches!(lhs, X::Null) {
                        eval(right, bindings)
                    } else {
                        lhs
                    }
                }
            }
        }
        Ast::Cond { test, cons, alt } => {
            if truthy(&eval(test, bindings)) {
                eval(cons, bindings)
            } else {
                eval(alt, bindings)
            }
        }
        Ast::Call { name, args } => {
            let evaluated: Vec<X> = args.iter().map(|arg| eval(arg, bindings)).collect();
            builtins::call(name, &evaluated)
        }
        Ast::Binary { op, left, right } => {
            let lhs = eval(left, bindings);
            let rhs = eval(right, bindings);
            match op {
                BinaryOp::Eq => X::Bool(strict_equal(&lhs, &rhs)),
                BinaryOp::Ne => X::Bool(!strict_equal(&lhs, &rhs)),
                BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
                    X::Bool(compare(*op, &lhs, &rhs))
                }
                BinaryOp::Add => {
                    if matches!(lhs, X::Str(_)) || matches!(rhs, X::Str(_)) {
                        if !lhs.is_primitive() || !rhs.is_primitive() {
                            return X::Null;
                        }
                        let mut out = Vec::new();
                        render_into(&lhs, &mut out);
                        render_into(&rhs, &mut out);
                        return X::Str(out);
                    }
                    match (lhs.as_number(), rhs.as_number()) {
                        (Some(a), Some(b)) => X::num(a + b),
                        _ => X::Null,
                    }
                }
                BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Rem => {
                    let (a, b) = match (lhs.as_number(), rhs.as_number()) {
                        (Some(a), Some(b)) => (a, b),
                        _ => return X::Null,
                    };
                    match op {
                        BinaryOp::Sub => X::num(a - b),
                        BinaryOp::Mul => X::num(a * b),
                        _ if b == 0.0 => X::Null,
                        BinaryOp::Div => X::num(a / b),
                        _ => X::num(a % b),
                    }
                }
            }
        }
    }
}
