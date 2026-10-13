use thiserror::Error;

#[derive(Debug, Error)]
pub enum XriptError {
    #[error("invalid xript manifest:\n{}", format_issues(.issues))]
    ManifestValidation { issues: Vec<ValidationIssue> },

    /// Raised at runtime construction under `strict_bindings` when the manifest
    /// declares bindings the host did not supply.
    #[error("the manifest declares {} binding(s) the host did not supply: {}. Supply them, remove them from the manifest, or construct the runtime without `strict_bindings` to install them as stubs that throw when called.", .missing.len(), .missing.join(", "))]
    MissingBindings { missing: Vec<String> },

    #[error("binding error in `{binding}`: {message}")]
    Binding { binding: String, message: String },

    #[error("`{binding}()` requires the \"{capability}\" capability, which hasn't been granted to this script")]
    CapabilityDenied { binding: String, capability: String },

    #[error("execution limit exceeded: {limit}")]
    ExecutionLimit { limit: String },

    #[error("execution cancelled by host")]
    Cancelled,

    /// The caller stopped waiting. Never that the call stopped: xript's limits
    /// bound script execution, not host-binding execution, so a call sitting
    /// inside a blocking host binding keeps running after this is returned.
    #[error("{}", if *still_running {
        "stopped waiting for the result; the call is still running (xript cannot interrupt a host binding)"
    } else {
        "stopped waiting for the result"
    })]
    Timeout { still_running: bool },

    /// The runtime thread failed to build. Every command sent to a handle whose
    /// construction failed reports this rather than hanging.
    #[error("the runtime failed to initialize: {message}")]
    InitFailed { message: String },

    /// A route the host's own router chose cannot serve the call it was
    /// chosen for. Loud rather than clamped, because it is an explicit choice.
    #[error("route {route} is execute-only; {kind}({target}) must run on the mod's home worker (worker {home})")]
    RouteUnsupported {
        kind: &'static str,
        route: &'static str,
        target: String,
        home: String,
    },

    /// The worker a call was routed to has an in-flight call past its
    /// threshold and a stalled heartbeat: its thread is inside host code and
    /// nothing xript owns can get it back.
    #[error("worker {worker} has been inside host binding `{}` for {stalled_ms}ms and is not responding{}. xript cannot interrupt a host binding; see spec/execution.md", .binding.as_deref().unwrap_or("<unknown>"), if .homed_mods.is_empty() { String::new() } else { format!("; mod{} {} {} homed there and cannot be reached", if .homed_mods.len() == 1 { "" } else { "s" }, .homed_mods.join(", "), if .homed_mods.len() == 1 { "is" } else { "are" }) })]
    WorkerWedged {
        worker: String,
        stalled_ms: u64,
        binding: Option<String>,
        homed_mods: Vec<String>,
    },

    /// A lane's queues are full and the configured policy is to say so.
    #[error("the {lane} lane is saturated: {depth} calls queued on worker {worker} (limit {limit})")]
    Saturated {
        lane: &'static str,
        worker: String,
        depth: usize,
        limit: usize,
    },

    /// A queued call was dropped to make room for a newer one.
    #[error("dropped from worker {worker}'s queue to admit a newer call (Saturation::ShedOldest)")]
    Shed { worker: String },

    /// A mod id the pool has never placed.
    #[error("no mod named `{mod_id}` is loaded in this pool")]
    UnknownMod { mod_id: String },

    #[error("invoke error in export `{export}`: {message}")]
    Invoke { export: String, message: String },

    #[error("export `{export}` is provided by more than one mod ({}); call invoke_mod_export(mod, \"{export}\", args) to name the owner", .mods.join(", "))]
    AmbiguousExport { export: String, mods: Vec<String> },

    #[error("script error: {0}")]
    Script(String),

    #[error("mod entry script error in `{mod_name}`: {message}")]
    ModEntry { mod_name: String, message: String },

    /// The mod's `entry` names a script the host did not supply, either as the
    /// explicit entry source or in the fragment sources.
    #[error("mod \"{mod_name}\" names entry script \"{script}\", which was not supplied (pass it as entry_source or in fragment_sources)")]
    MissingEntryScript { mod_name: String, script: String },

    #[error("import of \"{specifier}\" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)")]
    ImportDenied { mod_name: String, specifier: String },

    #[error("CommonJS artifacts detected in mod entry of `{mod_name}` (found: {artifact}). xript mods must be authored as ES modules (entry.format: \"module\", top-level export) or as classic scripts using xript.exports.register — never CommonJS. Fix your tsconfig to emit ESM (module: \"esnext\", moduleResolution: \"bundler\"/\"nodenext\") or remove the require()/module.exports usage. See https://xript.dev/guides/authoring-mods-in-typescript.")]
    CommonJsDetected { mod_name: String, artifact: String },

    #[error("library \"{specifier}\" is declared in the host manifest but no source was registered with the runtime; the host must supply it via the runtime's libraries option")]
    LibraryUnavailable { specifier: String },

    #[error("library \"{specifier}\" failed registration: {reason}")]
    LibraryRegistration { specifier: String, reason: String },

    #[error("fragment '{fragment_id}': {message}")]
    FragmentFormat {
        fragment_id: String,
        format: String,
        message: String,
    },

    #[error("fragment '{fragment_id}' could not be parsed as {format}: {message}")]
    FragmentParse {
        fragment_id: String,
        format: String,
        message: String,
    },

    #[error("fragment '{fragment_id}' violates its format's vocabulary:\n{}", format_diagnostics(.diagnostics))]
    FragmentSanitize {
        fragment_id: String,
        diagnostics: Vec<FragmentIssue>,
    },

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

/// An error-severity vocabulary diagnostic, flattened for the error type so
/// `error` does not need to depend on the fragment module.
#[derive(Debug, Clone)]
pub struct FragmentIssue {
    pub path: String,
    pub message: String,
}

fn format_diagnostics(diagnostics: &[FragmentIssue]) -> String {
    diagnostics
        .iter()
        .map(|d| format!("  {} {}", d.path, d.message))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_issues(issues: &[ValidationIssue]) -> String {
    issues
        .iter()
        .map(|i| format!("  {}: {}", i.path, i.message))
        .collect::<Vec<_>>()
        .join("\n")
}

pub type Result<T> = std::result::Result<T, XriptError>;
