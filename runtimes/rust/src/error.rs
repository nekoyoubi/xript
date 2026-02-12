use thiserror::Error;

#[derive(Debug, Error)]
pub enum XriptError {
    #[error("invalid xript manifest:\n{}", format_issues(.issues))]
    ManifestValidation { issues: Vec<ValidationIssue> },

    #[error("binding error in `{binding}`: {message}")]
    Binding { binding: String, message: String },

    #[error("`{binding}()` requires the \"{capability}\" capability, which hasn't been granted to this script")]
    CapabilityDenied { binding: String, capability: String },

    #[error("execution limit exceeded: {limit}")]
    ExecutionLimit { limit: String },

    #[error("script error: {0}")]
    Script(String),

    #[error("QuickJS error: {0}")]
    Engine(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct ValidationIssue {
    pub path: String,
    pub message: String,
}

fn format_issues(issues: &[ValidationIssue]) -> String {
    issues
        .iter()
        .map(|i| format!("  {}: {}", i.path, i.message))
        .collect::<Vec<_>>()
        .join("\n")
}

pub type Result<T> = std::result::Result<T, XriptError>;
