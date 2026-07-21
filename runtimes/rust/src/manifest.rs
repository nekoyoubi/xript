use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};

use crate::error::{ValidationIssue, XriptError};

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub xript: String,
    pub name: String,
    pub version: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub extends: Option<Extends>,
    pub bindings: Option<HashMap<String, Binding>>,
    pub hooks: Option<HashMap<String, HookDef>>,
    pub capabilities: Option<HashMap<String, Capability>>,
    pub limits: Option<Limits>,
    pub slots: Option<Vec<Slot>>,
    pub types: Option<HashMap<String, TypeDefinition>>,
    pub events: Option<Vec<EventDefinition>>,
    pub libraries: Option<HashMap<String, LibraryDef>>,
    /// Host-declared fragment formats, keyed by media type. Held as raw JSON
    /// because a node's props are JSON Schema bodies the runtime only reads two
    /// keywords out of; `xript validate` owns the rest.
    pub formats: Option<serde_json::Value>,
    /// Host-declared node vocabularies, keyed by vocabulary id. A vocabulary
    /// declares nodes and their props and nothing about how they are authored,
    /// so any number of formats may bring the same one into scope.
    pub vocabularies: Option<serde_json::Value>,
    /// The manifest-wide default every unannotated surface inherits.
    pub execution: Option<ExecutionIntent>,
}

/// How long a host should expect a surface to take. Totally ordered; `widen`
/// takes the maximum.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default, Hash)]
#[serde(rename_all = "lowercase")]
pub enum IntentDuration {
    /// Microseconds, no I/O. Safe anywhere, including a render pass.
    Instant,
    /// Completes within the ambient `limits` budget.
    #[default]
    Brief,
    /// May legitimately exceed the ambient budget; route it off the
    /// interactive lane.
    Long,
    /// Networked, streaming, or user-gated; no meaningful upper bound.
    Unbounded,
}

impl IntentDuration {
    pub fn as_str(self) -> &'static str {
        match self {
            IntentDuration::Instant => "instant",
            IntentDuration::Brief => "brief",
            IntentDuration::Long => "long",
            IntentDuration::Unbounded => "unbounded",
        }
    }
}

/// Where a surface may run. Totally ordered by restrictiveness; `widen` takes
/// the maximum.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default, Hash)]
#[serde(rename_all = "lowercase")]
pub enum IntentAffinity {
    /// Stateless with respect to the sandbox; any runtime may serve it.
    #[default]
    Any,
    /// Must land on the runtime where the calling mod's state lives.
    Pinned,
    /// Wants a runtime nobody else is using.
    Isolated,
}

impl IntentAffinity {
    pub fn as_str(self) -> &'static str {
        match self {
            IntentAffinity::Any => "any",
            IntentAffinity::Pinned => "pinned",
            IntentAffinity::Isolated => "isolated",
        }
    }
}

/// A declared execution intent, as written in a manifest. Both axes are
/// optional so an omitted axis can fall to the schema default rather than to
/// the manifest-wide one — inheritance is per-surface, not per-axis.
///
/// Advisory throughout: nothing is enforced, no capability is consulted, and a
/// `duration: instant` binding that takes ten seconds is a manifest bug rather
/// than a security failure. Enforcement lives in `limits`, and `limits` only
/// bounds script execution — see `spec/execution.md`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default, Hash)]
#[serde(deny_unknown_fields)]
pub struct ExecutionIntent {
    pub duration: Option<IntentDuration>,
    pub affinity: Option<IntentAffinity>,
}

impl ExecutionIntent {
    pub fn new(duration: IntentDuration, affinity: IntentAffinity) -> Self {
        Self {
            duration: Some(duration),
            affinity: Some(affinity),
        }
    }

    /// Fills both axes from the schema defaults.
    pub fn resolved(&self) -> ResolvedIntent {
        ResolvedIntent {
            duration: self.duration.unwrap_or_default(),
            affinity: self.affinity.unwrap_or_default(),
        }
    }

    /// Per-axis refinement, base then child, as `extends` resolves it. A child
    /// may move an axis in either direction and never errors: this is a
    /// routing hint, not a type.
    pub fn refine(base: Option<Self>, child: Option<Self>) -> Option<Self> {
        match (base, child) {
            (None, c) => c,
            (b, None) => b,
            (Some(b), Some(c)) => Some(Self {
                duration: c.duration.or(b.duration),
                affinity: c.affinity.or(b.affinity),
            }),
        }
    }
}

/// An intent with both axes settled. What a router actually reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct ResolvedIntent {
    pub duration: IntentDuration,
    pub affinity: IntentAffinity,
}

impl ResolvedIntent {
    /// The pairwise maximum on each lattice. Neither party can weaken the
    /// other: under-routing a long call freezes a UI, over-routing a brief one
    /// costs a thread hop.
    pub fn widen(a: Self, b: Self) -> Self {
        Self {
            duration: a.duration.max(b.duration),
            affinity: a.affinity.max(b.affinity),
        }
    }
}

impl From<ExecutionIntent> for ResolvedIntent {
    fn from(value: ExecutionIntent) -> Self {
        value.resolved()
    }
}

/// An approved importable library: the host vouches that the registered
/// pre-bundled ES module is sandbox-safe shared code. `capability` gates which
/// mods may import it; `version` documents the contract mod authors compile
/// against.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LibraryDef {
    pub description: Option<String>,
    pub capability: Option<String>,
    pub version: Option<String>,
    pub deprecated: Option<String>,
}

/// A host-declared broadcast event. The host emits it by id; sandbox mods
/// subscribe through `events.on(id, handler)`. `payload` is a codegen/docs hint;
/// `capability` gates subscription at registration time through the same gate
/// model hooks use.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct EventDefinition {
    pub id: String,
    pub description: Option<String>,
    pub payload: Option<serde_json::Value>,
    pub capability: Option<String>,
}

/// A custom type definition in `manifest.types`. An object type carries `fields`
/// (record field schemas); an enum-like type carries `values`. Both forms are
/// codegen/docs source-of-truth only — no runtime reads them for behavior.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TypeDefinition {
    pub description: Option<String>,
    pub fields: Option<HashMap<String, FieldDefinition>>,
    pub values: Option<Vec<serde_json::Value>>,
}

/// A single record field's shape. `optional` is the established absence flag
/// (never `required` — that key belongs to `parameter`). `default` and `enum`
/// are codegen/docs hints only; xript applies neither at runtime.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FieldDefinition {
    pub r#type: serde_json::Value,
    pub description: Option<String>,
    #[serde(default)]
    pub optional: bool,
    pub default: Option<serde_json::Value>,
    pub r#enum: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Extends {
    Single(String),
    Multiple(Vec<String>),
}

impl Extends {
    pub fn paths(&self) -> Vec<String> {
        match self {
            Extends::Single(s) => vec![s.clone()],
            Extends::Multiple(v) => v.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Slot {
    pub id: String,
    pub accepts: Vec<String>,
    pub description: Option<String>,
    pub capability: Option<String>,
    pub multiple: Option<bool>,
    pub style: Option<String>,
    /// The cost a host should assume when driving fills of this slot.
    pub execution: Option<ExecutionIntent>,
    /// Enforced limits for calls into this slot's fills, overriding the
    /// manifest's `limits` field by field. The counterpart to `execution`:
    /// that one is advisory routing, this one is enforcement.
    pub limits: Option<SlotLimits>,
}

/// Per-slot execution limits. Carries only `timeout_ms` on purpose: memory and
/// stack ceilings are fixed when a runtime is created, so a per-slot value for
/// either could not be enforced without standing up a separate runtime. That
/// path is `execution.affinity` plus a pool worker with its own limits.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct SlotLimits {
    pub timeout_ms: Option<u64>,
}

/// The accept type that marks a slot as a provider-role slot.
pub const ROLE_SLOT_ACCEPT: &str = "application/x-xript-role";

/// The accept type that marks a slot as an event-typed hook slot.
pub const HOOK_SLOT_ACCEPT: &str = "application/x-xript-hook";

/// The accept type that marks a slot as a command slot: its fills are named,
/// invocable actions backed by mod exports.
pub const COMMAND_SLOT_ACCEPT: &str = "application/x-xript-command";

impl Slot {
    /// Whether this slot is a provider-role slot.
    pub fn is_role_slot(&self) -> bool {
        self.accepts.iter().any(|a| a == ROLE_SLOT_ACCEPT)
    }

    /// Whether this slot is an event-typed hook slot the host fires.
    pub fn is_hook_slot(&self) -> bool {
        self.accepts.iter().any(|a| a == HOOK_SLOT_ACCEPT)
    }

    /// Whether this slot is a command slot the host invokes by name.
    pub fn is_command_slot(&self) -> bool {
        self.accepts.iter().any(|a| a == COMMAND_SLOT_ACCEPT)
    }
}

impl Manifest {
    /// The resolved execution intent of one surface, addressed as
    /// `bindings/<dotted.name>`, `hooks/<id>` or `slots/<id>`.
    ///
    /// Resolution is the surface's own `execution`, else the manifest-wide
    /// default, else the schema defaults. A surface that declares one axis
    /// takes the *schema* default on the other, never the manifest-wide one:
    /// declaring is a statement about this surface, not a partial inheritance.
    /// An unknown path falls to the manifest default rather than failing.
    pub fn execution_of(&self, path: &str) -> ResolvedIntent {
        let declared = self.declared_execution(path);
        match declared {
            Some(intent) => intent.resolved(),
            None => self.execution.unwrap_or_default().resolved(),
        }
    }

    /// The `execution` written at `path`, without any inheritance applied.
    pub fn declared_execution(&self, path: &str) -> Option<ExecutionIntent> {
        let (kind, id) = path.split_once('/')?;
        match kind {
            "bindings" => self.binding_at(id).and_then(|b| match b {
                Binding::Function(f) => f.execution,
                Binding::Namespace(_) => None,
            }),
            "hooks" => self.hooks.as_ref()?.get(id).and_then(|h| h.execution),
            "slots" => self
                .slots
                .as_ref()?
                .iter()
                .find(|s| s.id == id)
                .and_then(|s| s.execution),
            _ => None,
        }
    }

    /// Walks a dotted binding name through nested namespaces.
    fn binding_at(&self, dotted: &str) -> Option<&Binding> {
        let mut segments = dotted.split('.');
        let mut current = self.bindings.as_ref()?.get(segments.next()?)?;
        for segment in segments {
            match current {
                Binding::Namespace(ns) => current = ns.members.get(segment)?,
                Binding::Function(_) => return None,
            }
        }
        Some(current)
    }

    /// The timeout that governs a call into a fill of `slot_id`: the slot's own
    /// `limits.timeout_ms` when it declares one, otherwise `None` to mean "use
    /// the manifest-wide budget". A slot may raise the budget as well as lower
    /// it; the host declares both, so neither direction is an escalation. The
    /// embedder's hard limits clamp the result downstream either way.
    pub fn slot_timeout_ms(&self, slot_id: &str) -> Option<u64> {
        self.slots
            .as_ref()?
            .iter()
            .find(|slot| slot.id == slot_id)?
            .limits
            .as_ref()?
            .timeout_ms
    }

    /// The deadline that governs a call into a fill of `slot_id`: the slot's own
    /// `limits.timeout_ms` where it declares one, the manifest's otherwise, the
    /// schema default of 5000ms where neither does, clamped by the embedder's
    /// ceiling. Held to `spec/slot-limit-tests.json` by every runtime.
    pub fn effective_slot_timeout_ms(&self, slot_id: &str, hard_timeout_ms: Option<u64>) -> u64 {
        let base = self
            .limits
            .as_ref()
            .and_then(|limits| limits.timeout_ms)
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        let requested = self.slot_timeout_ms(slot_id).unwrap_or(base);
        match hard_timeout_ms {
            Some(hard) => requested.min(hard),
            None => requested,
        }
    }

    /// The effective hook map the runtime dispatches: the explicit `hooks`
    /// section plus a synthesized phaseless `HookDef` for every event-typed
    /// slot. An explicit `hooks` entry wins over a same-id slot — slots never
    /// clobber a declared hook.
    pub fn effective_hooks(&self) -> HashMap<String, HookDef> {
        let mut hooks = self.hooks.clone().unwrap_or_default();
        if let Some(ref slots) = self.slots {
            for slot in slots {
                if !slot.is_hook_slot() || hooks.contains_key(&slot.id) {
                    continue;
                }
                hooks.insert(
                    slot.id.clone(),
                    HookDef {
                        description: slot.description.clone().unwrap_or_default(),
                        phases: None,
                        params: None,
                        capability: slot.capability.clone(),
                        r#async: None,
                        deprecated: None,
                        execution: slot.execution,
                    },
                );
            }
        }
        hooks
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModManifest {
    pub xript: String,
    pub name: String,
    pub version: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub family: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub entry: Option<serde_json::Value>,
    pub fragments: Option<Vec<FragmentDeclaration>>,
    pub contributions: Option<Contributions>,
    /// The mod-wide default every unannotated export inherits.
    pub execution: Option<ExecutionIntent>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Contributions {
    #[serde(default)]
    pub provides: Vec<ProviderRole>,
}

/// A single logical role a mod declares it provides. `role` is a
/// lowercase-hyphen identifier; `fns` maps a logical method name to the concrete
/// export/global fn name the mod registered. Declaring a role grants no
/// capability — the named fns are gated by their own capabilities.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProviderRole {
    pub role: String,
    pub fns: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EntryBlock {
    pub script: Option<String>,
    #[serde(default = "default_entry_format")]
    pub format: String,
    #[serde(default)]
    pub exports: HashMap<String, ExportDecl>,
}

fn default_entry_format() -> String {
    "script".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportDecl {
    pub description: Option<String>,
    pub params: Option<Vec<Parameter>>,
    pub returns: Option<serde_json::Value>,
    pub capability: Option<String>,
    #[serde(default)]
    pub streaming: Option<bool>,
    /// The cost of invoking this export, as the mod's author claims it.
    pub execution: Option<ExecutionIntent>,
}

impl ModManifest {
    /// The resolved execution intent of one export, addressed as
    /// `exports/<name>`. Same rule as the host side: the export's own claim,
    /// else the mod-wide default, else the schema defaults.
    pub fn execution_of(&self, path: &str) -> ResolvedIntent {
        match self.declared_execution(path) {
            Some(intent) => intent.resolved(),
            None => self.execution.unwrap_or_default().resolved(),
        }
    }

    /// The `execution` written at `path`, without any inheritance applied.
    pub fn declared_execution(&self, path: &str) -> Option<ExecutionIntent> {
        let (kind, name) = path.split_once('/')?;
        if kind != "exports" {
            return None;
        }
        self.entry_block()?.exports.get(name)?.execution
    }

    /// The widen over every declared export and the mod-wide default: what the
    /// pool places a mod's home worker on.
    pub fn aggregate_execution(&self) -> ResolvedIntent {
        let mut aggregate = self.execution.unwrap_or_default().resolved();
        if let Some(entry) = self.entry_block() {
            for name in entry.exports.keys() {
                aggregate =
                    ResolvedIntent::widen(aggregate, self.execution_of(&format!("exports/{name}")));
            }
        }
        aggregate
    }

    /// Parses the `entry` field into a normalized `EntryBlock` whether it is a
    /// bare script string, an array of scripts, or the richer object form with
    /// declared exports. Returns `None` when no entry is declared.
    pub fn entry_block(&self) -> Option<EntryBlock> {
        match &self.entry {
            None => None,
            Some(serde_json::Value::String(s)) => Some(EntryBlock {
                script: Some(s.clone()),
                format: default_entry_format(),
                exports: HashMap::new(),
            }),
            Some(serde_json::Value::Array(arr)) => {
                let script = arr.first().and_then(|v| v.as_str()).map(|s| s.to_string());
                Some(EntryBlock {
                    script,
                    format: default_entry_format(),
                    exports: HashMap::new(),
                })
            }
            Some(obj @ serde_json::Value::Object(_)) => {
                serde_json::from_value(obj.clone()).ok()
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FragmentDeclaration {
    pub id: String,
    pub slot: String,
    pub format: String,
    pub source: String,
    pub inline: Option<bool>,
    pub bindings: Option<Vec<FragmentBinding>>,
    pub handlers: Option<Vec<FragmentHandler>>,
    /// Deprecated alias for `handlers`. Accepted on deserialize for
    /// back-compat; `handlers` wins when both are present.
    pub events: Option<Vec<FragmentHandler>>,
    pub priority: Option<i32>,
    /// Turns on `{{ expr }}` interpolation for this fill's text nodes. Off by default:
    /// a fragment published before the mode existed may carry `{{` in prose or a code
    /// sample, and its meaning must not change.
    pub interpolate: Option<bool>,
}

impl FragmentDeclaration {
    /// Resolves the fragment's DOM-event handlers, preferring `handlers` and
    /// falling back to the deprecated `events` alias.
    pub fn resolved_handlers(&self) -> Option<&Vec<FragmentHandler>> {
        self.handlers.as_ref().or(self.events.as_ref())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FragmentBinding {
    pub name: String,
    pub path: String,
    /// Optional value type, so tooling can type-check the expressions that read this
    /// binding. Not consulted at runtime.
    #[serde(default)]
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FragmentHandler {
    pub selector: String,
    pub on: String,
    pub handler: String,
}

pub type FragmentEvent = FragmentHandler;

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Binding {
    Namespace(NamespaceBinding),
    Function(FunctionBinding),
}

#[derive(Debug, Clone, Deserialize)]
pub struct FunctionBinding {
    pub description: String,
    pub params: Option<Vec<Parameter>>,
    pub returns: Option<serde_json::Value>,
    pub r#async: Option<bool>,
    pub capability: Option<String>,
    pub deprecated: Option<String>,
    /// The cost of calling this host function.
    pub execution: Option<ExecutionIntent>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NamespaceBinding {
    pub description: String,
    pub members: HashMap<String, Binding>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Parameter {
    pub name: String,
    pub r#type: serde_json::Value,
    pub description: Option<String>,
    pub default: Option<serde_json::Value>,
    pub required: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HookDef {
    pub description: String,
    pub phases: Option<Vec<String>>,
    pub params: Option<Vec<Parameter>>,
    pub capability: Option<String>,
    pub r#async: Option<bool>,
    pub deprecated: Option<String>,
    /// The cost of firing this hook, handler fan-out included.
    pub execution: Option<ExecutionIntent>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Capability {
    pub description: String,
    pub risk: Option<String>,
}

/// The schema default deadline, applied where neither a slot nor the manifest
/// declares one. Pinned by `spec/slot-limit-tests.json`.
pub const DEFAULT_TIMEOUT_MS: u64 = 5000;

#[derive(Debug, Clone, Deserialize)]
pub struct Limits {
    pub timeout_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub max_stack_depth: Option<usize>,
}

impl Binding {
    pub fn is_namespace(&self) -> bool {
        matches!(self, Binding::Namespace(_))
    }
}

pub fn validate_structure(manifest: &Manifest) -> crate::error::Result<()> {
    let mut issues = Vec::new();

    if manifest.xript.is_empty() {
        issues.push(ValidationIssue {
            path: "/xript".into(),
            message: "required field 'xript' must be a non-empty string".into(),
        });
    }

    if manifest.name.is_empty() {
        issues.push(ValidationIssue {
            path: "/name".into(),
            message: "required field 'name' must be a non-empty string".into(),
        });
    }

    if let Some(ref limits) = manifest.limits {
        if let Some(timeout) = limits.timeout_ms {
            if timeout == 0 {
                issues.push(ValidationIssue {
                    path: "/limits/timeout_ms".into(),
                    message: "'timeout_ms' must be a positive number".into(),
                });
            }
        }
        if let Some(memory) = limits.memory_mb {
            if memory == 0 {
                issues.push(ValidationIssue {
                    path: "/limits/memory_mb".into(),
                    message: "'memory_mb' must be a positive number".into(),
                });
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(XriptError::ManifestValidation { issues })
    }
}

pub fn validate_mod_manifest(manifest: &ModManifest) -> crate::error::Result<()> {
    let mut issues = Vec::new();

    if manifest.xript.is_empty() {
        issues.push(ValidationIssue {
            path: "/xript".into(),
            message: "required field 'xript' must be a non-empty string".into(),
        });
    }

    if manifest.name.is_empty() {
        issues.push(ValidationIssue {
            path: "/name".into(),
            message: "required field 'name' must be a non-empty string".into(),
        });
    }

    if manifest.version.is_empty() {
        issues.push(ValidationIssue {
            path: "/version".into(),
            message: "required field 'version' must be a non-empty string".into(),
        });
    }

    if let Some(ref fragments) = manifest.fragments {
        for (i, frag) in fragments.iter().enumerate() {
            let prefix = format!("/fragments/{}", i);
            if frag.id.is_empty() {
                issues.push(ValidationIssue {
                    path: format!("{}/id", prefix),
                    message: "'id' must be a non-empty string".into(),
                });
            }
            if frag.slot.is_empty() {
                issues.push(ValidationIssue {
                    path: format!("{}/slot", prefix),
                    message: "'slot' must be a non-empty string".into(),
                });
            }
            if frag.format.is_empty() {
                issues.push(ValidationIssue {
                    path: format!("{}/format", prefix),
                    message: "'format' must be a non-empty string".into(),
                });
            }
        }
    }

    if let Some(ref contributions) = manifest.contributions {
        let mut seen_roles: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (i, provided) in contributions.provides.iter().enumerate() {
            let prefix = format!("/contributions/provides/{}", i);
            if !is_role_identifier(&provided.role) {
                issues.push(ValidationIssue {
                    path: format!("{}/role", prefix),
                    message: format!(
                        "role '{}' must match ^[a-z][a-z0-9-]*$ and be at most 64 chars",
                        provided.role
                    ),
                });
            }
            if provided.fns.is_empty() {
                issues.push(ValidationIssue {
                    path: format!("{}/fns", prefix),
                    message: "'fns' must declare at least one logical->concrete mapping".into(),
                });
            }
            if !seen_roles.insert(provided.role.as_str()) {
                issues.push(ValidationIssue {
                    path: format!("{}/role", prefix),
                    message: format!("duplicate role '{}' within this mod's provides", provided.role),
                });
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(XriptError::ManifestValidation { issues })
    }
}

/// Validates a logical-role identifier: `^[a-z][a-z0-9-]*$`, at most 64 chars.
/// Shared by the provider-role cluster and the discovery-result shape.
pub fn is_role_identifier(role: &str) -> bool {
    if role.is_empty() || role.len() > 64 {
        return false;
    }
    let mut chars = role.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn validate_mod_against_app(
    mod_manifest: &ModManifest,
    slots: &[Slot],
    granted_capabilities: &std::collections::HashSet<String>,
    formats: Option<&serde_json::Value>,
    vocabularies: Option<&serde_json::Value>,
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let slot_map: HashMap<&str, &Slot> = slots.iter().map(|s| (s.id.as_str(), s)).collect();

    if let Some(ref fragments) = mod_manifest.fragments {
        for (i, frag) in fragments.iter().enumerate() {
            let prefix = format!("/fragments/{}", i);

            match slot_map.get(frag.slot.as_str()) {
                None => {
                    issues.push(ValidationIssue {
                        path: format!("{}/slot", prefix),
                        message: format!("slot '{}' does not exist in the app manifest", frag.slot),
                    });
                }
                Some(slot) => {
                    if !slot.accepts.contains(&frag.format) {
                        issues.push(ValidationIssue {
                            path: format!("{}/format", prefix),
                            message: format!(
                                "slot '{}' does not accept format '{}'",
                                frag.slot, frag.format
                            ),
                        });
                    } else {
                        match crate::fragment::profiles::resolve_format_profile(
                            &frag.format,
                            formats,
                            vocabularies,
                        ) {
                            Err(err) => issues.push(ValidationIssue {
                                path: format!("{}/format", prefix),
                                message: err.message,
                            }),
                            Ok(None) => issues.push(ValidationIssue {
                                path: format!("{}/format", prefix),
                                message: format!(
                                    "unknown fragment format '{}' — declare it in the host manifest's 'formats' block",
                                    frag.format
                                ),
                            }),
                            Ok(Some(_)) => {}
                        }
                    }

                    if let Some(ref cap) = slot.capability {
                        if !crate::cap_match::granted_satisfies(granted_capabilities, cap) {
                            issues.push(ValidationIssue {
                                path: format!("{}/slot", prefix),
                                message: format!(
                                    "slot '{}' requires capability '{}'",
                                    frag.slot, cap
                                ),
                            });
                        }
                    }
                }
            }
        }
    }

    issues
}

const MERGE_MAPS: &[&str] = &["bindings", "capabilities", "hooks", "types"];
const SCALAR_FIELDS: &[&str] = &["name", "version", "title", "description", "xript"];

/// Resolves a manifest's `extends` field into a flat, composed manifest by
/// loading base manifests relative to `base_dir` and deep-merging them under the
/// child. Maps (`bindings`, `capabilities`, `hooks`, `types`) key-merge.
/// `bindings`, `capabilities`, and `hooks` treat duplicate ids as errors. For
/// `types`, a child redeclaring an abstract base type fills it (the concrete
/// child replaces the abstract stub), and a child redeclaring a concrete base
/// type with `refines: true` deep-merges onto it; any other duplicate id is an
/// error. `slots` append (deduped by id), with a child slot allowed to refine a
/// base slot id via `refines: true` and other duplicates erroring. `formats`
/// key-merge at three levels: a format id, a node inside a refining format, and a
/// prop inside a refining node (which replaces its base wholesale); a duplicate
/// without `refines: true` is an error at each level. Scalar fields take the
/// child's value. Resolution is transitive with cycle detection. The returned
/// value no longer carries an `extends` field.
pub fn resolve_extends(
    manifest: &serde_json::Value,
    base_dir: &std::path::Path,
) -> crate::error::Result<serde_json::Value> {
    let mut visiting = std::collections::HashSet::new();
    resolve_extends_inner(manifest, base_dir, &mut visiting)
}

fn resolve_extends_inner(
    manifest: &serde_json::Value,
    base_dir: &std::path::Path,
    visiting: &mut std::collections::HashSet<String>,
) -> crate::error::Result<serde_json::Value> {
    let extends_paths: Vec<String> = match manifest.get("extends") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        Some(_) => {
            return Err(XriptError::ManifestValidation {
                issues: vec![ValidationIssue {
                    path: "/extends".into(),
                    message: "'extends' must be a string or array of strings".into(),
                }],
            });
        }
    };

    let mut child = manifest.clone();
    if let Some(obj) = child.as_object_mut() {
        obj.remove("extends");
    }

    if extends_paths.is_empty() {
        return Ok(child);
    }

    let mut composed = serde_json::Value::Object(serde_json::Map::new());
    for rel in &extends_paths {
        let base_path = base_dir.join(rel);
        let canonical = base_path
            .canonicalize()
            .unwrap_or_else(|_| base_path.clone())
            .to_string_lossy()
            .to_string();

        if visiting.contains(&canonical) {
            return Err(XriptError::ManifestValidation {
                issues: vec![ValidationIssue {
                    path: "/extends".into(),
                    message: format!("circular extends detected at '{}'", rel),
                }],
            });
        }

        let content = std::fs::read_to_string(&base_path)?;
        let base_json: serde_json::Value = serde_json::from_str(&content)?;

        visiting.insert(canonical.clone());
        let base_dir_next = base_path.parent().unwrap_or(base_dir);
        let resolved_base = resolve_extends_inner(&base_json, base_dir_next, visiting)?;
        visiting.remove(&canonical);

        composed = merge_manifests(&composed, &resolved_base)?;
    }

    merge_manifests(&composed, &child)
}

/// Merges `child` onto `base`, returning the composed value. An un-opted
/// concrete-name collision in a map or a duplicate slot id without `refines`
/// produces a `ManifestValidation` error; abstract-type fills and `refines`
/// deep-merges are resolved in place.
pub fn merge_manifests(
    base: &serde_json::Value,
    child: &serde_json::Value,
) -> crate::error::Result<serde_json::Value> {
    let base_obj = base.as_object().cloned().unwrap_or_default();
    let child_obj = child.as_object().cloned().unwrap_or_default();
    let mut out = base_obj.clone();

    for field in MERGE_MAPS {
        let merged = merge_id_maps(
            base_obj.get(*field),
            child_obj.get(*field),
            field,
        )?;
        if let Some(m) = merged {
            out.insert(field.to_string(), m);
        }
    }

    if let Some(merged_slots) = merge_slots(base_obj.get("slots"), child_obj.get("slots"))? {
        out.insert("slots".to_string(), merged_slots);
    }

    if let Some(merged_formats) = merge_formats(base_obj.get("formats"), child_obj.get("formats"))? {
        out.insert("formats".to_string(), merged_formats);
    }

    if let Some(merged_vocabularies) =
        merge_vocabularies(base_obj.get("vocabularies"), child_obj.get("vocabularies"))?
    {
        out.insert("vocabularies".to_string(), merged_vocabularies);
    }

    for field in SCALAR_FIELDS {
        if let Some(v) = child_obj.get(*field) {
            out.insert(field.to_string(), v.clone());
        }
    }

    for (k, v) in &child_obj {
        if MERGE_MAPS.contains(&k.as_str())
            || SCALAR_FIELDS.contains(&k.as_str())
            || k == "slots"
            || k == "formats"
            || k == "vocabularies"
            || k == "extends"
        {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }

    Ok(serde_json::Value::Object(out))
}

/// A `typeDefinition` carrying `"abstract": true` is a declared-but-unpopulated
/// contract hole an extending manifest is expected to fill.
fn is_abstract_type(v: &serde_json::Value) -> bool {
    v.get("abstract").and_then(|x| x.as_bool()).unwrap_or(false)
}

/// A child surface carrying `"refines": true` opts into deep-merging onto a
/// concrete base surface of the same name.
fn is_refining(v: &serde_json::Value) -> bool {
    v.get("refines").and_then(|x| x.as_bool()).unwrap_or(false)
}

/// Deep-merges a refining `child` definition onto a concrete `base` definition.
/// Per-field, the child field replaces the base field of the same key; base
/// fields the child omits are retained. Nested object values merge recursively;
/// arrays and other scalars replace wholesale. The `refines` marker is consumed.
fn deep_merge(base: &serde_json::Value, child: &serde_json::Value) -> serde_json::Value {
    match (base, child) {
        (serde_json::Value::Object(base_obj), serde_json::Value::Object(child_obj)) => {
            let mut out = base_obj.clone();
            for (k, v) in child_obj {
                if k == "refines" {
                    continue;
                }
                match out.get(k) {
                    Some(existing) if existing.is_object() && v.is_object() => {
                        out.insert(k.clone(), deep_merge(existing, v));
                    }
                    _ => {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
            serde_json::Value::Object(out)
        }
        _ => child.clone(),
    }
}

fn merge_id_maps(
    base: Option<&serde_json::Value>,
    child: Option<&serde_json::Value>,
    field: &str,
) -> crate::error::Result<Option<serde_json::Value>> {
    match (base, child) {
        (None, None) => Ok(None),
        (Some(b), None) => Ok(Some(b.clone())),
        (None, Some(c)) => Ok(Some(c.clone())),
        (Some(b), Some(c)) => {
            let base_map = b.as_object().cloned().unwrap_or_default();
            let child_map = c.as_object().cloned().unwrap_or_default();
            let mut out = base_map.clone();
            for (k, v) in &child_map {
                if let Some(base_entry) = base_map.get(k) {
                    if field == "types" {
                        if is_abstract_type(base_entry) {
                            out.insert(k.clone(), v.clone());
                            continue;
                        }
                        if is_refining(v) {
                            out.insert(k.clone(), deep_merge(base_entry, v));
                            continue;
                        }
                    }
                    let singular = field.trim_end_matches('s');
                    return Err(XriptError::ManifestValidation {
                        issues: vec![ValidationIssue {
                            path: format!("/{}/{}", field, k),
                            message: format!(
                                "{} id {} conflicts with extended base",
                                singular, k
                            ),
                        }],
                    });
                }
                out.insert(k.clone(), v.clone());
            }
            Ok(Some(serde_json::Value::Object(out)))
        }
    }
}

fn without_refines(value: &serde_json::Value) -> serde_json::Value {
    match value.as_object() {
        Some(obj) => {
            let mut out = obj.clone();
            out.remove("refines");
            serde_json::Value::Object(out)
        }
        None => value.clone(),
    }
}

/// Merges a child node's props onto a base node's. A same-named prop is REPLACED wholesale
/// rather than deep-merged: a child widening a prop's type would otherwise silently inherit
/// the base's `sink` onto a value the sink can no longer handle.
fn merge_node(base: &serde_json::Value, child: &serde_json::Value) -> serde_json::Value {
    let base_obj = base.as_object().cloned().unwrap_or_default();
    let child_obj = child.as_object().cloned().unwrap_or_default();
    let mut out = base_obj.clone();

    for (k, v) in &child_obj {
        if k == "refines" || k == "props" {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }

    if base_obj.contains_key("props") || child_obj.contains_key("props") {
        let mut props = base_obj
            .get("props")
            .and_then(|p| p.as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(child_props) = child_obj.get("props").and_then(|p| p.as_object()) {
            for (k, v) in child_props {
                props.insert(k.clone(), v.clone());
            }
        }
        out.insert("props".to_string(), serde_json::Value::Object(props));
    }

    out.remove("refines");
    serde_json::Value::Object(out)
}

/// Merges a `nodes` block for whichever surface owns it. `owner_label` names that
/// surface in the collision message and `owner_pointer` locates it, so a format's
/// inline nodes and a named vocabulary's nodes go through one merge rather than two.
fn merge_nodes(
    base: Option<&serde_json::Value>,
    child: Option<&serde_json::Value>,
    owner_label: &str,
    owner_pointer: &str,
) -> crate::error::Result<serde_json::Value> {
    let base_map = base.and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let child_map = child.and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut out = serde_json::Map::new();

    for (name, node) in &base_map {
        out.insert(name.clone(), without_refines(node));
    }

    for (name, node) in &child_map {
        match base_map.get(name) {
            None => {
                out.insert(name.clone(), without_refines(node));
            }
            Some(base_node) => {
                if !is_refining(node) {
                    return Err(XriptError::ManifestValidation {
                        issues: vec![ValidationIssue {
                            path: format!("{}/nodes/{}", owner_pointer, name),
                            message: format!(
                                "{} node \"{}\" conflicts with extended base",
                                owner_label, name
                            ),
                        }],
                    });
                }
                out.insert(name.clone(), merge_node(base_node, node));
            }
        }
    }

    Ok(serde_json::Value::Object(out))
}

fn merge_format(
    base: &serde_json::Value,
    child: &serde_json::Value,
    format_id: &str,
) -> crate::error::Result<serde_json::Value> {
    let base_obj = base.as_object().cloned().unwrap_or_default();
    let child_obj = child.as_object().cloned().unwrap_or_default();
    let mut out = base_obj.clone();

    for (k, v) in &child_obj {
        if k == "refines" || k == "nodes" {
            continue;
        }
        // `vocabularies` and `schemes` are both absent-inherits,
        // present-replaces-wholesale, with `[]` meaning deliberate closure. A union
        // could re-inject `html` into a scope a child deliberately closed, and it
        // would make a scheme set impossible to narrow: a child could only ever
        // widen its base's URI surface. Both fall through to the same wholesale
        // insert every other key gets; the asymmetry is with `nodes`, which
        // key-merges below.
        if k == "vocabularies" || k == "schemes" {
            out.insert(k.clone(), v.clone());
            continue;
        }
        out.insert(k.clone(), v.clone());
    }

    if base_obj.contains_key("nodes") || child_obj.contains_key("nodes") {
        let nodes = merge_nodes(
            base_obj.get("nodes"),
            child_obj.get("nodes"),
            "format",
            &format!("/formats/{}", format_id),
        )?;
        out.insert("nodes".to_string(), nodes);
    }

    out.remove("refines");
    Ok(serde_json::Value::Object(out))
}

/// Merges a refining child vocabulary onto a base one: `description` is child-wins
/// and `nodes` key-merges, with an un-opted node collision erroring.
fn merge_vocabulary(
    base: &serde_json::Value,
    child: &serde_json::Value,
    vocabulary_id: &str,
) -> crate::error::Result<serde_json::Value> {
    let base_obj = base.as_object().cloned().unwrap_or_default();
    let child_obj = child.as_object().cloned().unwrap_or_default();
    let mut out = base_obj.clone();

    for (k, v) in &child_obj {
        if k == "refines" || k == "nodes" {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }

    if base_obj.contains_key("nodes") || child_obj.contains_key("nodes") {
        let nodes = merge_nodes(
            base_obj.get("nodes"),
            child_obj.get("nodes"),
            "vocabulary",
            &format!("/vocabularies/{}", vocabulary_id),
        )?;
        out.insert("nodes".to_string(), nodes);
    }

    out.remove("refines");
    Ok(serde_json::Value::Object(out))
}

/// Merges the `vocabularies` block across an `extends` chain. Three levels, each
/// collision-as-error unless the child marks itself `refines`: a vocabulary id, a
/// node inside a refining vocabulary, and a prop inside a refining node. Identical
/// in shape to `merge_formats`, because a vocabulary is the same kind of surface.
fn merge_vocabularies(
    base: Option<&serde_json::Value>,
    child: Option<&serde_json::Value>,
) -> crate::error::Result<Option<serde_json::Value>> {
    if base.is_none() && child.is_none() {
        return Ok(None);
    }

    let base_map = base.and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let child_map = child.and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut out = serde_json::Map::new();

    let empty = serde_json::Value::Object(serde_json::Map::new());
    for (id, vocabulary) in &base_map {
        out.insert(id.clone(), merge_vocabulary(&empty, vocabulary, id)?);
    }

    for (id, vocabulary) in &child_map {
        match base_map.get(id) {
            None => {
                out.insert(id.clone(), merge_vocabulary(&empty, vocabulary, id)?);
            }
            Some(base_vocabulary) => {
                if !is_refining(vocabulary) {
                    return Err(XriptError::ManifestValidation {
                        issues: vec![ValidationIssue {
                            path: format!("/vocabularies/{}", id),
                            message: format!("vocabulary {} conflicts with extended base", id),
                        }],
                    });
                }
                out.insert(id.clone(), merge_vocabulary(base_vocabulary, vocabulary, id)?);
            }
        }
    }

    Ok(Some(serde_json::Value::Object(out)))
}

/// Merges the `formats` block across an `extends` chain. Three levels, each collision-as-error
/// unless the child marks itself `refines`: a format id, a node inside a refining format, and a
/// prop inside a refining node. Without this arm a child's `formats` would fall into the
/// catch-all and silently replace the base's entire vocabulary.
fn merge_formats(
    base: Option<&serde_json::Value>,
    child: Option<&serde_json::Value>,
) -> crate::error::Result<Option<serde_json::Value>> {
    if base.is_none() && child.is_none() {
        return Ok(None);
    }

    let base_map = base.and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let child_map = child.and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut out = serde_json::Map::new();

    let empty = serde_json::Value::Object(serde_json::Map::new());
    for (id, format) in &base_map {
        out.insert(id.clone(), merge_format(&empty, format, id)?);
    }

    for (id, format) in &child_map {
        match base_map.get(id) {
            None => {
                out.insert(id.clone(), merge_format(&empty, format, id)?);
            }
            Some(base_format) => {
                if !is_refining(format) {
                    return Err(XriptError::ManifestValidation {
                        issues: vec![ValidationIssue {
                            path: format!("/formats/{}", id),
                            message: format!("format {} conflicts with extended base", id),
                        }],
                    });
                }
                out.insert(id.clone(), merge_format(base_format, format, id)?);
            }
        }
    }

    Ok(Some(serde_json::Value::Object(out)))
}

fn merge_slots(
    base: Option<&serde_json::Value>,
    child: Option<&serde_json::Value>,
) -> crate::error::Result<Option<serde_json::Value>> {
    let base_arr = base.and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let child_arr = child.and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if base.is_none() && child.is_none() {
        return Ok(None);
    }

    let mut out = base_arr.clone();
    let mut seen: std::collections::HashSet<String> = base_arr
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    for slot in &child_arr {
        if let Some(id) = slot.get("id").and_then(|v| v.as_str()) {
            if seen.contains(id) {
                if is_refining(slot) {
                    if let Some(idx) = out.iter().position(|s| s.get("id").and_then(|v| v.as_str()) == Some(id)) {
                        out[idx] = deep_merge(&out[idx], slot);
                    }
                    continue;
                }
                return Err(XriptError::ManifestValidation {
                    issues: vec![ValidationIssue {
                        path: format!("/slots/{}", id),
                        message: format!("slot id {} conflicts with extended base", id),
                    }],
                });
            }
            seen.insert(id.to_string());
        }
        out.push(slot.clone());
    }

    Ok(Some(serde_json::Value::Array(out)))
}

#[cfg(test)]
mod extends_conformance {
    use super::resolve_extends;

    const CORPUS: &str = include_str!("../../../spec/extends-tests.json");

    #[derive(serde::Deserialize)]
    struct Case {
        description: String,
        base: serde_json::Value,
        extender: serde_json::Value,
        #[serde(default)]
        resolved: Option<serde_json::Value>,
        #[serde(default)]
        error: bool,
    }

    #[test]
    fn matches_canonical_extends_corpus() {
        let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("corpus parses");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp_dir = std::env::temp_dir()
            .join(format!("xript-extends-{}-{}", std::process::id(), nonce));
        std::fs::create_dir_all(&tmp_dir).expect("create temp dir");

        let mut failures = Vec::new();
        for (i, case) in cases.iter().enumerate() {
            let base_path = tmp_dir.join(format!("base-{}.json", i));
            std::fs::write(&base_path, serde_json::to_string(&case.base).unwrap())
                .expect("write base");

            let mut child = case.extender.clone();
            child.as_object_mut().unwrap().insert(
                "extends".into(),
                serde_json::Value::String(base_path.to_string_lossy().to_string()),
            );

            let outcome = resolve_extends(&child, &tmp_dir);

            if case.error {
                if outcome.is_ok() {
                    failures.push(format!(
                        "case '{}': expected resolution to error, but it succeeded with {:?}",
                        case.description,
                        outcome.unwrap()
                    ));
                }
            } else {
                let expected = case
                    .resolved
                    .as_ref()
                    .expect("success case has 'resolved'");
                match outcome {
                    Ok(got) => {
                        if &got != expected {
                            failures.push(format!(
                                "case '{}'\n  expected: {}\n  got:      {}",
                                case.description,
                                serde_json::to_string(expected).unwrap(),
                                serde_json::to_string(&got).unwrap()
                            ));
                        }
                    }
                    Err(e) => failures.push(format!(
                        "case '{}': expected success, got error {:?}",
                        case.description, e
                    )),
                }
            }
        }

        let _ = std::fs::remove_dir_all(&tmp_dir);

        assert!(
            failures.is_empty(),
            "{} of {} extends corpus cases failed:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }
}
