//! XEG — the xript Expression Grammar.
//!
//! One total, pure expression language shared by `data-if`, `data-bind`, and inline
//! `{{ … }}` interpolation. Identifiers resolve only against a fill's declared bindings and
//! calls resolve only against the closed builtin table, so no production names a host
//! global and no evaluation reaches a value's methods. There is no code generation
//! anywhere: the parser produces an AST and the evaluator walks it.
//!
//! Semantics are pinned by `spec/expression-tests.json`, not by "whatever JavaScript does".

mod ast;
mod builtins;
mod eval;
mod interpolate;
mod parser;
mod value;

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::Value;

pub use ast::{
    Ast, BinaryOp, Expression, ExpressionError, ExpressionKind, LogicalOp, UnaryOp,
};
pub use builtins::{builtin_arity, BUILTIN_NAMES};
pub use eval::{evaluate_ast, Bindings};
pub use interpolate::{
    contains_interpolation, resolve_segments, segment_text, segments_to_source, SegmentIssue,
    SegmentResult, TextSegment,
};
pub use parser::{parse, parse_with_limit, DEFAULT_MAX_EXPRESSION_NODES};
pub use value::{format_number, is_truthy, render};

thread_local! {
    /// Parsed expressions, keyed by source. Fragments re-render far more often than they
    /// load, and the parse is the expensive half.
    static PARSE_CACHE: RefCell<HashMap<String, Result<Expression, ExpressionError>>> =
        RefCell::new(HashMap::new());
}

/// Parses through the shared per-thread cache.
pub fn parse_cached(source: &str) -> Result<Expression, ExpressionError> {
    PARSE_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(hit) = cache.get(source) {
            return hit.clone();
        }
        if cache.len() > 512 {
            cache.clear();
        }
        let result = parse(source);
        cache.insert(source.to_string(), result.clone());
        result
    })
}

/// Evaluates a source string. An unparseable source is `null`, never an error: a fragment
/// with one bad expression still renders the rest of itself.
pub fn evaluate(source: &str, bindings: &Bindings) -> Value {
    match parse_cached(source) {
        Ok(expression) => evaluate_ast(&expression.ast, bindings),
        Err(_) => Value::Null,
    }
}

/// `data-if`: the expression's truth. An unparseable or failing expression is `false`.
pub fn evaluate_condition(source: &str, bindings: &Bindings) -> bool {
    is_truthy(&evaluate(source, bindings))
}

/// Classifies a `data-bind` body. A bare identifier is an lvalue and keeps two-way
/// write-back; anything else computes a value with no inverse and is read-only.
pub fn expression_kind(source: &str) -> Option<ExpressionKind> {
    parse_cached(source).ok().map(|expression| expression.kind)
}
