/// The parsed shape of an XEG expression.
///
/// There is no node for a parenthesised group: parentheses steer parsing and carry no
/// meaning, so `(hp)` and `hp` produce the same AST and therefore the same
/// [`ExpressionKind`].
#[derive(Debug, Clone, PartialEq)]
pub enum Ast {
    Num(f64),
    Str(String),
    Bool(bool),
    Null,
    Name(String),
    Member { obj: Box<Ast>, name: String },
    Index { obj: Box<Ast>, index: Box<Ast> },
    Unary { op: UnaryOp, arg: Box<Ast> },
    Binary { op: BinaryOp, left: Box<Ast>, right: Box<Ast> },
    Logical { op: LogicalOp, left: Box<Ast>, right: Box<Ast> },
    Cond { test: Box<Ast>, cons: Box<Ast>, alt: Box<Ast> },
    Call { name: String, args: Vec<Ast> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Neg,
    Pos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogicalOp {
    And,
    Or,
    Nullish,
}

/// Whether a `data-bind` body is writable. Only a bare name is: a computed value has no
/// inverse, so write-back has nowhere to land.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpressionKind {
    Name,
    Expression,
}

/// A parsed expression plus what static reading already knows about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Expression {
    pub source: String,
    pub kind: ExpressionKind,
    pub ast: Ast,
    /// Every identifier the expression reads, in first-appearance order.
    pub names: Vec<String>,
    pub node_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpressionError {
    pub position: usize,
    pub message: String,
}

impl std::fmt::Display for ExpressionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (at {})", self.message, self.position)
    }
}

impl std::error::Error for ExpressionError {}
