use std::collections::HashMap;

use serde_json::Value;

use crate::ast::{Ast, BinaryOp, LogicalOp, UnaryOp};
use crate::builtins;
use crate::value::{
    as_number, compare, finite, is_primitive, is_truthy, read_member, render, strict_equal,
    MemberKey,
};

pub type Bindings = HashMap<String, Value>;

/// Evaluates a parsed expression.
///
/// Total by construction: there is no operation that can fail out of band, so every
/// pathological input lands on `null` rather than aborting a render.
pub fn evaluate_ast(ast: &Ast, bindings: &Bindings) -> Value {
    match ast {
        Ast::Num(value) => finite(*value),
        Ast::Str(value) => Value::String(value.clone()),
        Ast::Bool(value) => Value::Bool(*value),
        Ast::Null => Value::Null,
        Ast::Name(name) => bindings.get(name).cloned().unwrap_or(Value::Null),
        Ast::Member { obj, name } => {
            read_member(&evaluate_ast(obj, bindings), &MemberKey::Name(name.clone()))
        }
        Ast::Index { obj, index } => {
            let target = evaluate_ast(obj, bindings);
            match evaluate_ast(index, bindings) {
                Value::Number(number) => match number.as_f64() {
                    Some(value) => read_member(&target, &MemberKey::Index(value as i64)),
                    None => Value::Null,
                },
                Value::String(key) => read_member(&target, &MemberKey::Name(key)),
                _ => Value::Null,
            }
        }
        Ast::Unary { op, arg } => {
            let value = evaluate_ast(arg, bindings);
            match op {
                UnaryOp::Not => Value::Bool(!is_truthy(&value)),
                UnaryOp::Neg => as_number(&value).map(|n| finite(-n)).unwrap_or(Value::Null),
                UnaryOp::Pos => as_number(&value).map(finite).unwrap_or(Value::Null),
            }
        }
        Ast::Logical { op, left, right } => {
            let lhs = evaluate_ast(left, bindings);
            match op {
                LogicalOp::And => {
                    if is_truthy(&lhs) {
                        evaluate_ast(right, bindings)
                    } else {
                        lhs
                    }
                }
                LogicalOp::Or => {
                    if is_truthy(&lhs) {
                        lhs
                    } else {
                        evaluate_ast(right, bindings)
                    }
                }
                LogicalOp::Nullish => {
                    if lhs.is_null() {
                        evaluate_ast(right, bindings)
                    } else {
                        lhs
                    }
                }
            }
        }
        Ast::Cond { test, cons, alt } => {
            if is_truthy(&evaluate_ast(test, bindings)) {
                evaluate_ast(cons, bindings)
            } else {
                evaluate_ast(alt, bindings)
            }
        }
        Ast::Call { name, args } => {
            let evaluated: Vec<Value> =
                args.iter().map(|arg| evaluate_ast(arg, bindings)).collect();
            builtins::call(name, &evaluated)
        }
        Ast::Binary { op, left, right } => {
            let lhs = evaluate_ast(left, bindings);
            let rhs = evaluate_ast(right, bindings);
            match op {
                BinaryOp::Eq => Value::Bool(strict_equal(&lhs, &rhs)),
                BinaryOp::Ne => Value::Bool(!strict_equal(&lhs, &rhs)),
                BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
                    Value::Bool(compare(*op, &lhs, &rhs))
                }
                BinaryOp::Add => {
                    if matches!(lhs, Value::String(_)) || matches!(rhs, Value::String(_)) {
                        if !is_primitive(&lhs) || !is_primitive(&rhs) {
                            return Value::Null;
                        }
                        return Value::String(format!("{}{}", render(&lhs), render(&rhs)));
                    }
                    match (as_number(&lhs), as_number(&rhs)) {
                        (Some(a), Some(b)) => finite(a + b),
                        _ => Value::Null,
                    }
                }
                BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Rem => {
                    let (a, b) = match (as_number(&lhs), as_number(&rhs)) {
                        (Some(a), Some(b)) => (a, b),
                        _ => return Value::Null,
                    };
                    match op {
                        BinaryOp::Sub => finite(a - b),
                        BinaryOp::Mul => finite(a * b),
                        _ if b == 0.0 => Value::Null,
                        BinaryOp::Div => finite(a / b),
                        _ => finite(a % b),
                    }
                }
            }
        }
    }
}
