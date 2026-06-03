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
    pub capability: Option<String>,
    pub multiple: Option<bool>,
    pub style: Option<String>,
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
}

impl ModManifest {
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
}

#[derive(Debug, Clone, Deserialize)]
pub struct Capability {
    pub description: String,
    pub risk: Option<String>,
}

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
                    }

                    if let Some(ref cap) = slot.capability {
                        if !granted_capabilities.contains(cap) {
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
/// base slot id via `refines: true` and other duplicates erroring. Scalar fields
/// take the child's value. Resolution is transitive with cycle detection. The
/// returned value no longer carries an `extends` field.
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

    for field in SCALAR_FIELDS {
        if let Some(v) = child_obj.get(*field) {
            out.insert(field.to_string(), v.clone());
        }
    }

    for (k, v) in &child_obj {
        if MERGE_MAPS.contains(&k.as_str())
            || SCALAR_FIELDS.contains(&k.as_str())
            || k == "slots"
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
                    // FILL and REFINE apply to the `types` surface only.
                    if field == "types" {
                        // FILL: an abstract base type is replaced by the
                        // concrete child definition; abstractness is the opt-in.
                        if is_abstract_type(base_entry) {
                            out.insert(k.clone(), v.clone());
                            continue;
                        }
                        // REFINE: a concrete base type with `refines: true` on
                        // the child deep-merges, child fields winning per key.
                        if is_refining(v) {
                            out.insert(k.clone(), deep_merge(base_entry, v));
                            continue;
                        }
                    }
                    // Un-opted concrete-name collision: the accident guard.
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
                // REFINE: a child slot with `refines: true` deep-merges onto the
                // base slot of the same id (including payload member types).
                if is_refining(slot) {
                    if let Some(idx) = out
                        .iter()
                        .position(|s| s.get("id").and_then(|v| v.as_str()) == Some(id))
                    {
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
