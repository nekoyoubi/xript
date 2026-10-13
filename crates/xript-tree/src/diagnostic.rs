//! Diagnostics. Advisory to a renderer in every case; an unrecognized code is an
//! opaque warning, never a reason to abandon a render.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticCode {
    UnknownNode,
    StrippedNode,
    UnknownProp,
    InvalidProp,
    UnsafeProp,
    IllegalChild,
    InvalidExpression,
    MaxDepthExceeded,
    UnsupportedOp,
    UnsupportedTarget,
    OpUnknownProp,
    OpInvalidValue,
    PropSinkConflict,
    DuplicateKey,
    InvalidKey,
    RepeatLimit,
}

impl DiagnosticCode {
    pub fn as_str(self) -> &'static str {
        match self {
            DiagnosticCode::UnknownNode => "unknown-node",
            DiagnosticCode::StrippedNode => "stripped-node",
            DiagnosticCode::UnknownProp => "unknown-prop",
            DiagnosticCode::InvalidProp => "invalid-prop",
            DiagnosticCode::UnsafeProp => "unsafe-prop",
            DiagnosticCode::IllegalChild => "illegal-child",
            DiagnosticCode::InvalidExpression => "invalid-expression",
            DiagnosticCode::MaxDepthExceeded => "max-depth-exceeded",
            DiagnosticCode::UnsupportedOp => "unsupported-op",
            DiagnosticCode::UnsupportedTarget => "unsupported-target",
            DiagnosticCode::OpUnknownProp => "op-unknown-prop",
            DiagnosticCode::OpInvalidValue => "op-invalid-value",
            DiagnosticCode::PropSinkConflict => "prop-sink-conflict",
            DiagnosticCode::DuplicateKey => "duplicate-key",
            DiagnosticCode::InvalidKey => "invalid-key",
            DiagnosticCode::RepeatLimit => "repeat-limit",
        }
    }
}

impl std::fmt::Display for DiagnosticCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

impl DiagnosticSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            DiagnosticSeverity::Error => "error",
            DiagnosticSeverity::Warning => "warning",
        }
    }
}

impl std::fmt::Display for DiagnosticSeverity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FragmentDiagnostic {
    pub code: DiagnosticCode,
    pub severity: DiagnosticSeverity,
    /// Index path into the source tree, e.g. `/0/2/1`.
    pub path: String,
    pub node: String,
    pub prop: Option<String>,
    pub message: String,
}
