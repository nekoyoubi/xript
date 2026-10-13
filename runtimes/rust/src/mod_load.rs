//! Load-time mod diagnostics and the entry error policy.
//!
//! Held to `spec/mod-load-tests.json` by every runtime, so a diagnostic code
//! means the same thing whichever runtime raised it.

use std::collections::HashMap;
use std::sync::Arc;

use crate::manifest::FragmentDeclaration;

/// What `load_mod` does when a mod's entry cannot run: a script the host did
/// not supply, or one that throws while evaluating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EntryErrorPolicy {
    /// `load_mod` returns the error and the mod is not registered.
    #[default]
    Throw,
    /// The failure is recorded on [`crate::ModInstance::diagnostics`] and sent
    /// to the runtime's mod diagnostic sink, and the mod is registered without
    /// whatever its entry did not run. For a host that would rather boot with
    /// one broken mod than not boot at all.
    Report,
}

/// What a load-time mod diagnostic reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModDiagnosticCode {
    /// `entry` names a script the host did not supply.
    MissingEntryScript,
    /// Evaluating the entry failed.
    EntryFailed,
    /// A fragment's `source` is markup but `inline` is not `true`, so it was
    /// looked up as a file name and found nothing.
    MarkupSourceNotInline,
    /// A fragment's `source` names a file the host did not supply.
    MissingFragmentSource,
    /// A fragment declares handlers under the deprecated `events` key.
    /// Reported once per mod.
    DeprecatedEventsAlias,
}

impl ModDiagnosticCode {
    /// The code's spelling in the shared corpus and in the other runtimes.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MissingEntryScript => "missing-entry-script",
            Self::EntryFailed => "entry-failed",
            Self::MarkupSourceNotInline => "markup-source-not-inline",
            Self::MissingFragmentSource => "missing-fragment-source",
            Self::DeprecatedEventsAlias => "deprecated-events-alias",
        }
    }
}

/// `Error` for an entry that did not run; `Warning` for a mod that loaded but
/// likely not as its author meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModDiagnosticSeverity {
    Error,
    Warning,
}

impl ModDiagnosticSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

/// A finding about a mod raised while loading it.
#[derive(Debug, Clone, PartialEq)]
pub struct ModDiagnostic {
    pub code: ModDiagnosticCode,
    pub severity: ModDiagnosticSeverity,
    /// The mod's `name`.
    pub mod_name: String,
    pub message: String,
    /// The entry script, for entry diagnostics.
    pub script: Option<String>,
    /// The fragment fill, for fragment diagnostics.
    pub fragment_id: Option<String>,
    /// The fill field the finding is about, e.g. `source` or `events`.
    pub field: Option<String>,
}

/// Receives every [`ModDiagnostic`] as it is raised, whatever the entry error
/// policy. A panicking sink is contained and does not change whether a mod loads.
pub type ModDiagnosticSink = Arc<dyn Fn(&ModDiagnostic) + Send + Sync>;

/// True when a fragment `source` reads as content rather than a file name:
/// markup that opens with a tag, or a JSON document (a JSML tree is a JSON
/// array).
pub fn looks_like_markup(source: &str) -> bool {
    let trimmed = source.trim();
    if trimmed.starts_with('<') {
        return true;
    }
    if !trimmed.starts_with('[') && !trimmed.starts_with('{') {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
}

/// The load-time findings a mod's fragment declarations raise against the
/// sources the host supplied, in declaration order: a non-inline `source` that
/// resolves to nothing, and the deprecated `events` alias, once per mod.
pub fn fragment_declaration_diagnostics(
    mod_name: &str,
    fragments: &[FragmentDeclaration],
    sources: &HashMap<String, String>,
) -> Vec<ModDiagnostic> {
    let mut diagnostics = Vec::new();
    let mut reported_events_alias = false;

    for fragment in fragments {
        if !fragment.inline.unwrap_or(false) && !sources.contains_key(&fragment.source) {
            let (code, message) = if looks_like_markup(&fragment.source) {
                (
                    ModDiagnosticCode::MarkupSourceNotInline,
                    format!(
                        "fragment \"{}\" of mod \"{mod_name}\" carries markup in \"source\" without \"inline\": true, so it was looked up as a file name, found nothing, and mounts empty; set \"inline\": true",
                        fragment.id
                    ),
                )
            } else {
                (
                    ModDiagnosticCode::MissingFragmentSource,
                    format!(
                        "fragment \"{}\" of mod \"{mod_name}\" names source \"{}\", which was not supplied in fragment_sources, so it mounts empty",
                        fragment.id, fragment.source
                    ),
                )
            };
            diagnostics.push(ModDiagnostic {
                code,
                severity: ModDiagnosticSeverity::Warning,
                mod_name: mod_name.to_string(),
                message,
                script: None,
                fragment_id: Some(fragment.id.clone()),
                field: Some("source".into()),
            });
        }

        if !reported_events_alias && fragment.events.is_some() {
            reported_events_alias = true;
            diagnostics.push(ModDiagnostic {
                code: ModDiagnosticCode::DeprecatedEventsAlias,
                severity: ModDiagnosticSeverity::Warning,
                mod_name: mod_name.to_string(),
                message: format!(
                    "mod \"{mod_name}\" declares fragment handlers under the deprecated \"events\" key (first on fragment \"{}\"); rename it to \"handlers\"",
                    fragment.id
                ),
                script: None,
                fragment_id: Some(fragment.id.clone()),
                field: Some("events".into()),
            });
        }
    }

    diagnostics
}

/// Hands a diagnostic to the host's sink, containing a panic so a broken sink
/// cannot change whether a mod loads.
pub(crate) fn send(sink: Option<&ModDiagnosticSink>, diagnostic: &ModDiagnostic) {
    if let Some(sink) = sink {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(diagnostic)));
    }
}
