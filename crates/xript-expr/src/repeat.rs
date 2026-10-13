//! `data-each` headers: `item in expr` and `(item, index) in expr`.
//!
//! The right side of `in` is an XEG expression. Everything here is total: a header that
//! does not parse, an expression that fails, and a value that is not an array all repeat
//! zero times.

use serde_json::Value;

use crate::ast::Expression;
use crate::eval::{evaluate_ast, Bindings};

/// The implicit index name, in scope inside every copy.
pub const REPEAT_INDEX_NAME: &str = "$index";

/// The most copies one render may produce across every `data-each` in a fragment.
/// Nested repeats multiply, so without a ceiling a template's render cost would grow with
/// the host's data raised to the nesting depth.
pub const MAX_REPEAT_COPIES: usize = 10_000;

const RESERVED_BINDER_NAMES: [&str; 4] = ["true", "false", "null", "in"];

/// A parsed `data-each` header.
#[derive(Debug, Clone, PartialEq)]
pub struct RepeatHeader {
    /// The name each element binds to inside a copy.
    pub item: String,
    /// The optional explicit index name. `$index` is bound regardless.
    pub index: Option<String>,
    /// The XEG source on the right of `in`.
    pub source: String,
    pub expression: Expression,
}

fn is_whitespace(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0C' | '\x0B')
}

fn is_ident_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ch == '$'
}

fn is_ident_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

struct Scanner {
    chars: Vec<char>,
    i: usize,
}

impl Scanner {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }

    fn skip(&mut self) {
        while self.peek().is_some_and(is_whitespace) {
            self.i += 1;
        }
    }

    fn ident(&mut self) -> Option<String> {
        if !self.peek().is_some_and(is_ident_start) {
            return None;
        }
        let start = self.i;
        self.i += 1;
        while self.peek().is_some_and(is_ident_part) {
            self.i += 1;
        }
        Some(self.chars[start..self.i].iter().collect())
    }
}

/// Parses a `data-each` header. The binder names follow XEG's identifier rule, `in` must
/// be followed by whitespace, and everything after it must be a member of the grammar.
pub fn parse_repeat_header(source: &str) -> Result<RepeatHeader, String> {
    let mut s = Scanner { chars: source.chars().collect(), i: 0 };
    s.skip();

    let item;
    let mut index = None;
    if s.peek() == Some('(') {
        s.i += 1;
        s.skip();
        item = s.ident().ok_or("expected an item name after '('")?;
        s.skip();
        if s.peek() == Some(',') {
            s.i += 1;
            s.skip();
            index = Some(s.ident().ok_or("expected an index name after ','")?);
            s.skip();
        }
        if s.peek() != Some(')') {
            return Err("expected ')' to close the binder list".into());
        }
        s.i += 1;
        s.skip();
    } else {
        item = s
            .ident()
            .ok_or("expected 'item in expression' or '(item, index) in expression'")?;
        if !s.peek().is_some_and(is_whitespace) {
            return Err("expected whitespace before 'in'".into());
        }
        s.skip();
    }

    let after_in = s.chars.get(s.i + 2).copied();
    if s.chars.get(s.i) != Some(&'i')
        || s.chars.get(s.i + 1) != Some(&'n')
        || !after_in.is_some_and(is_whitespace)
    {
        return Err("expected 'in' followed by an expression".into());
    }
    s.i += 2;

    for name in std::iter::once(&item).chain(index.iter()) {
        if RESERVED_BINDER_NAMES.contains(&name.as_str()) {
            return Err(format!("'{name}' cannot name a repeat binding"));
        }
    }
    if index.as_deref() == Some(item.as_str()) {
        return Err(format!("the item and index cannot share the name '{item}'"));
    }

    let mut end = s.chars.len();
    while end > s.i && is_whitespace(s.chars[end - 1]) {
        end -= 1;
    }
    s.skip();
    if s.i >= end {
        return Err("expected an expression after 'in'".into());
    }
    let rest: String = s.chars[s.i..end].iter().collect();
    let expression = crate::parse_cached(&rest).map_err(|error| error.message)?;
    Ok(RepeatHeader { item, index, source: rest, expression })
}

/// The elements a header repeats over. A failing expression and a non-array value are
/// both empty: a repeat renders zero copies rather than aborting the render.
pub fn evaluate_repeat_items(header: &RepeatHeader, bindings: &Bindings) -> Vec<Value> {
    match evaluate_ast(&header.expression.ast, bindings) {
        Value::Array(items) => items,
        _ => Vec::new(),
    }
}

/// The bindings a copy evaluates against: the enclosing scope, with `$index`, the item
/// name, and the index name layered on top. Inner names shadow outer ones.
pub fn repeat_scope(bindings: &Bindings, header: &RepeatHeader, item: Value, index: usize) -> Bindings {
    let mut scope = bindings.clone();
    scope.insert(REPEAT_INDEX_NAME.to_string(), Value::from(index));
    scope.insert(header.item.clone(), item);
    if let Some(name) = &header.index {
        scope.insert(name.clone(), Value::from(index));
    }
    scope
}
