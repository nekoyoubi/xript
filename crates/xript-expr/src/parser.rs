use crate::ast::{Ast, BinaryOp, Expression, ExpressionError, ExpressionKind, LogicalOp, UnaryOp};
use crate::builtins::builtin_arity;

pub const DEFAULT_MAX_EXPRESSION_NODES: usize = 256;

/// Words the grammar refuses as identifiers. Each names a JavaScript capability XEG does
/// not have; rejecting them by name makes the error say so instead of surfacing as an
/// anonymous syntax error two tokens later.
const RESERVED_WORDS: &[&str] = &[
    "function", "return", "var", "let", "const", "new", "delete", "typeof", "void", "in",
    "instanceof", "this", "class", "import", "export", "await", "yield", "if", "else", "for",
    "while", "do", "switch", "case", "try", "catch", "throw", "undefined", "globalThis", "eval",
    "arguments",
];

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Name(String),
    Punct(&'static str),
    Eof,
}

#[derive(Debug, Clone)]
struct Token {
    tok: Tok,
    pos: usize,
}

fn fail<T>(pos: usize, message: impl Into<String>) -> Result<T, ExpressionError> {
    Err(ExpressionError { position: pos, message: message.into() })
}

const PUNCT_2: &[&str] = &["==", "!=", "<=", ">=", "&&", "||", "??"];
const PUNCT_1: &[&str] =
    &["<", ">", "+", "-", "*", "/", "%", "!", "?", ":", "(", ")", "[", "]", ",", "."];

fn tokenize(source: &str) -> Result<Vec<Token>, ExpressionError> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];

        if ch.is_whitespace() {
            i += 1;
            continue;
        }

        if ch.is_ascii_digit() || (ch == '.' && matches!(chars.get(i + 1), Some(d) if d.is_ascii_digit()))
        {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if chars.get(i) == Some(&'.') {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if matches!(chars.get(i), Some('e') | Some('E')) {
                let mut j = i + 1;
                if matches!(chars.get(j), Some('+') | Some('-')) {
                    j += 1;
                }
                if matches!(chars.get(j), Some(d) if d.is_ascii_digit()) {
                    i = j;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            let text: String = chars[start..i].iter().collect();
            match text.parse::<f64>() {
                Ok(value) => tokens.push(Token { tok: Tok::Num(value), pos: start }),
                Err(_) => return fail(start, "invalid number literal"),
            }
            continue;
        }

        if ch == '"' || ch == '\'' {
            let start = i;
            let quote = ch;
            i += 1;
            let mut out = String::new();
            loop {
                match chars.get(i) {
                    None => return fail(start, "unterminated string literal"),
                    Some(&c) if c == quote => {
                        i += 1;
                        break;
                    }
                    Some('\n') => return fail(start, "unterminated string literal"),
                    Some('\\') => {
                        i += 1;
                        match chars.get(i) {
                            None => return fail(start, "unterminated string literal"),
                            Some('n') => out.push('\n'),
                            Some('t') => out.push('\t'),
                            Some('r') => out.push('\r'),
                            Some('b') => out.push('\u{8}'),
                            Some('f') => out.push('\u{c}'),
                            Some('0') => out.push('\0'),
                            Some('u') => {
                                let hex: String = chars.get(i + 1..i + 5).unwrap_or(&[]).iter().collect();
                                if hex.len() != 4 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                                    return fail(i, "invalid unicode escape");
                                }
                                let code = u32::from_str_radix(&hex, 16).unwrap_or(0);
                                out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                                i += 4;
                            }
                            Some(&other) => out.push(other),
                        }
                        i += 1;
                    }
                    Some(&other) => {
                        out.push(other);
                        i += 1;
                    }
                }
            }
            tokens.push(Token { tok: Tok::Str(out), pos: start });
            continue;
        }

        if ch.is_ascii_alphabetic() || ch == '_' || ch == '$' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$')
            {
                i += 1;
            }
            tokens.push(Token { tok: Tok::Name(chars[start..i].iter().collect()), pos: start });
            continue;
        }

        let three: String = chars.get(i..i + 3).unwrap_or(&[]).iter().collect();
        if three == "===" {
            tokens.push(Token { tok: Tok::Punct("=="), pos: i });
            i += 3;
            continue;
        }
        if three == "!==" {
            tokens.push(Token { tok: Tok::Punct("!="), pos: i });
            i += 3;
            continue;
        }

        let two: String = chars.get(i..i + 2).unwrap_or(&[]).iter().collect();
        if let Some(found) = PUNCT_2.iter().find(|p| **p == two) {
            tokens.push(Token { tok: Tok::Punct(found), pos: i });
            i += 2;
            continue;
        }

        match two.as_str() {
            "++" | "--" => {
                return fail(i, format!("'{two}' is not part of the xript expression grammar"))
            }
            "=>" => return fail(i, "arrow functions are not part of the xript expression grammar"),
            "?." => {
                return fail(i, "optional chaining is not part of the xript expression grammar")
            }
            _ => {}
        }

        let one = ch.to_string();
        if let Some(found) = PUNCT_1.iter().find(|p| **p == one) {
            tokens.push(Token { tok: Tok::Punct(found), pos: i });
            i += 1;
            continue;
        }

        return match ch {
            '=' => fail(i, "assignment is not part of the xript expression grammar"),
            ';' => fail(i, "statements are not part of the xript expression grammar"),
            '{' | '}' => {
                fail(i, "object literals and blocks are not part of the xript expression grammar")
            }
            '&' | '|' | '^' | '~' => {
                fail(i, "bitwise operators are not part of the xript expression grammar")
            }
            '`' => fail(i, "template literals are not part of the xript expression grammar"),
            '#' => fail(
                i,
                "block helpers ('{{#if}}', '{{#each}}') do not exist — a fragment carries no control flow",
            ),
            other => fail(i, format!("unexpected character '{other}'")),
        };
    }

    tokens.push(Token { tok: Tok::Eof, pos: chars.len() });
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
    count: usize,
    max_nodes: usize,
    names: Vec<String>,
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.index.min(self.tokens.len() - 1)]
    }

    fn next(&mut self) -> Token {
        let token = self.tokens[self.index.min(self.tokens.len() - 1)].clone();
        if self.index < self.tokens.len() - 1 {
            self.index += 1;
        }
        token
    }

    fn at(&self, value: &str) -> bool {
        matches!(&self.peek().tok, Tok::Punct(p) if *p == value)
    }

    fn eat(&mut self, value: &str) -> bool {
        if self.at(value) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, value: &str) -> Result<(), ExpressionError> {
        if self.eat(value) {
            Ok(())
        } else {
            fail(self.peek().pos, format!("expected '{value}'"))
        }
    }

    fn node(&mut self, node: Ast) -> Result<Ast, ExpressionError> {
        self.count += 1;
        if self.count > self.max_nodes {
            return fail(0, format!("expression exceeds the {}-node limit", self.max_nodes));
        }
        Ok(node)
    }

    fn parse_expr(&mut self) -> Result<Ast, ExpressionError> {
        let test = self.parse_nullish()?;
        if !self.eat("?") {
            return Ok(test);
        }
        let cons = self.parse_expr()?;
        self.expect(":")?;
        let alt = self.parse_expr()?;
        self.node(Ast::Cond { test: Box::new(test), cons: Box::new(cons), alt: Box::new(alt) })
    }

    fn parse_nullish(&mut self) -> Result<Ast, ExpressionError> {
        let mut left = self.parse_or()?;
        while self.at("??") {
            self.next();
            let right = self.parse_or()?;
            left = self.node(Ast::Logical {
                op: LogicalOp::Nullish,
                left: Box::new(left),
                right: Box::new(right),
            })?;
        }
        Ok(left)
    }

    fn parse_or(&mut self) -> Result<Ast, ExpressionError> {
        let mut left = self.parse_and()?;
        while self.at("||") {
            self.next();
            let right = self.parse_and()?;
            left = self.node(Ast::Logical {
                op: LogicalOp::Or,
                left: Box::new(left),
                right: Box::new(right),
            })?;
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Ast, ExpressionError> {
        let mut left = self.parse_equality()?;
        while self.at("&&") {
            self.next();
            let right = self.parse_equality()?;
            left = self.node(Ast::Logical {
                op: LogicalOp::And,
                left: Box::new(left),
                right: Box::new(right),
            })?;
        }
        Ok(left)
    }

    fn parse_equality(&mut self) -> Result<Ast, ExpressionError> {
        let mut left = self.parse_relational()?;
        loop {
            let op = if self.at("==") {
                BinaryOp::Eq
            } else if self.at("!=") {
                BinaryOp::Ne
            } else {
                return Ok(left);
            };
            self.next();
            let right = self.parse_relational()?;
            left = self.node(Ast::Binary { op, left: Box::new(left), right: Box::new(right) })?;
        }
    }

    fn parse_relational(&mut self) -> Result<Ast, ExpressionError> {
        let mut left = self.parse_additive()?;
        loop {
            let op = if self.at("<=") {
                BinaryOp::Le
            } else if self.at(">=") {
                BinaryOp::Ge
            } else if self.at("<") {
                BinaryOp::Lt
            } else if self.at(">") {
                BinaryOp::Gt
            } else {
                return Ok(left);
            };
            self.next();
            let right = self.parse_additive()?;
            left = self.node(Ast::Binary { op, left: Box::new(left), right: Box::new(right) })?;
        }
    }

    fn parse_additive(&mut self) -> Result<Ast, ExpressionError> {
        let mut left = self.parse_multiplicative()?;
        loop {
            let op = if self.at("+") {
                BinaryOp::Add
            } else if self.at("-") {
                BinaryOp::Sub
            } else {
                return Ok(left);
            };
            self.next();
            let right = self.parse_multiplicative()?;
            left = self.node(Ast::Binary { op, left: Box::new(left), right: Box::new(right) })?;
        }
    }

    fn parse_multiplicative(&mut self) -> Result<Ast, ExpressionError> {
        let mut left = self.parse_unary()?;
        loop {
            let op = if self.at("*") {
                BinaryOp::Mul
            } else if self.at("/") {
                BinaryOp::Div
            } else if self.at("%") {
                BinaryOp::Rem
            } else {
                return Ok(left);
            };
            self.next();
            let right = self.parse_unary()?;
            left = self.node(Ast::Binary { op, left: Box::new(left), right: Box::new(right) })?;
        }
    }

    fn parse_unary(&mut self) -> Result<Ast, ExpressionError> {
        let op = if self.at("!") {
            UnaryOp::Not
        } else if self.at("-") {
            UnaryOp::Neg
        } else if self.at("+") {
            UnaryOp::Pos
        } else {
            return self.parse_postfix();
        };
        self.next();
        let arg = self.parse_unary()?;
        self.node(Ast::Unary { op, arg: Box::new(arg) })
    }

    fn parse_postfix(&mut self) -> Result<Ast, ExpressionError> {
        let mut target = self.parse_primary()?;
        loop {
            if self.eat(".") {
                let token = self.next();
                match token.tok {
                    Tok::Name(name) => {
                        target = self
                            .node(Ast::Member { obj: Box::new(target), name })?;
                    }
                    _ => return fail(token.pos, "expected a property name after '.'"),
                }
                continue;
            }
            if self.eat("[") {
                let index = self.parse_expr()?;
                self.expect("]")?;
                target =
                    self.node(Ast::Index { obj: Box::new(target), index: Box::new(index) })?;
                continue;
            }
            if self.at("(") {
                return fail(
                    self.peek().pos,
                    "only builtin functions are callable; a binding value is not",
                );
            }
            return Ok(target);
        }
    }

    fn parse_primary(&mut self) -> Result<Ast, ExpressionError> {
        let token = self.peek().clone();

        match token.tok {
            Tok::Num(value) => {
                self.next();
                self.node(Ast::Num(value))
            }
            Tok::Str(value) => {
                self.next();
                self.node(Ast::Str(value))
            }
            Tok::Name(name) => {
                self.next();
                match name.as_str() {
                    "true" => return self.node(Ast::Bool(true)),
                    "false" => return self.node(Ast::Bool(false)),
                    "null" => return self.node(Ast::Null),
                    _ => {}
                }
                if RESERVED_WORDS.contains(&name.as_str()) {
                    return fail(
                        token.pos,
                        format!("'{name}' is not part of the xript expression grammar"),
                    );
                }

                if self.at("(") {
                    let arity = match builtin_arity(&name) {
                        Some(arity) => arity,
                        None => {
                            return fail(
                                token.pos,
                                format!("unknown function '{name}' — only builtins are callable"),
                            )
                        }
                    };
                    self.next();
                    let mut args = Vec::new();
                    if !self.at(")") {
                        args.push(self.parse_expr()?);
                        while self.eat(",") {
                            args.push(self.parse_expr()?);
                        }
                    }
                    self.expect(")")?;
                    if args.len() < arity.0 || args.len() > arity.1 {
                        return fail(
                            token.pos,
                            format!(
                                "'{name}' takes {}–{} argument(s), got {}",
                                arity.0,
                                if arity.1 == usize::MAX { "n".to_string() } else { arity.1.to_string() },
                                args.len()
                            ),
                        );
                    }
                    return self.node(Ast::Call { name, args });
                }

                if !self.names.contains(&name) {
                    self.names.push(name.clone());
                }
                self.node(Ast::Name(name))
            }
            Tok::Punct("(") => {
                self.next();
                let inner = self.parse_expr()?;
                self.expect(")")?;
                Ok(inner)
            }
            Tok::Eof => fail(token.pos, "unexpected end of expression"),
            Tok::Punct(p) => fail(token.pos, format!("unexpected token '{p}'")),
        }
    }
}

/// Parses an XEG expression with the default node cap.
pub fn parse(source: &str) -> Result<Expression, ExpressionError> {
    parse_with_limit(source, DEFAULT_MAX_EXPRESSION_NODES)
}

pub fn parse_with_limit(source: &str, max_nodes: usize) -> Result<Expression, ExpressionError> {
    if source.trim().is_empty() {
        return fail(0, "empty expression");
    }

    let mut parser =
        Parser { tokens: tokenize(source)?, index: 0, count: 0, max_nodes, names: Vec::new() };
    let ast = parser.parse_expr()?;
    if !matches!(parser.peek().tok, Tok::Eof) {
        let token = parser.peek().clone();
        let text = match token.tok {
            Tok::Punct(p) => p.to_string(),
            Tok::Name(name) => name,
            Tok::Num(value) => value.to_string(),
            Tok::Str(value) => value,
            Tok::Eof => String::new(),
        };
        return fail(token.pos, format!("unexpected token '{text}'"));
    }

    let kind =
        if matches!(ast, Ast::Name(_)) { ExpressionKind::Name } else { ExpressionKind::Expression };

    Ok(Expression {
        source: source.to_string(),
        kind,
        ast,
        names: parser.names,
        node_count: parser.count,
    })
}
