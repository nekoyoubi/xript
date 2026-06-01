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

    #[error("execution cancelled by host")]
    Cancelled,

    #[error("invoke error in export `{export}`: {message}")]
    Invoke { export: String, message: String },

    #[error("script error: {0}")]
    Script(String),

    #[error("mod entry script error in `{mod_name}`: {message}")]
    ModEntry { mod_name: String, message: String },

    #[error("import of \"{specifier}\" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)")]
    ImportDenied { mod_name: String, specifier: String },

    #[error("CommonJS artifacts detected in mod entry of `{mod_name}` (found: {artifact}). xript mods must be authored as ES modules (entry.format: \"module\", top-level export) or as classic scripts using xript.exports.register — never CommonJS. Fix your tsconfig to emit ESM (module: \"esnext\", moduleResolution: \"bundler\"/\"nodenext\") or remove the require()/module.exports usage. See https://xript.dev/guides/authoring-mods-in-typescript.")]
    CommonJsDetected { mod_name: String, artifact: String },

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
