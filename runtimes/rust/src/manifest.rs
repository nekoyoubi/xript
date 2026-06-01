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
    pub events: Option<Vec<FragmentEvent>>,
    pub priority: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FragmentBinding {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FragmentEvent {
    pub selector: String,
    pub on: String,
    pub handler: String,
}

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
/// child. Maps (`bindings`, `capabilities`, `hooks`, `types`) key-merge with
/// duplicate-id conflicts surfaced as errors; `slots` append (deduped by id,
/// duplicate ids error); scalar fields take the child's value. Resolution is
/// transitive with cycle detection. The returned value no longer carries an
/// `extends` field.
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

/// Merges `child` onto `base`, returning the composed value. Conflicting map ids
/// or duplicate slot ids present in both produce a `ManifestValidation` error.
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
                if base_map.contains_key(k) {
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
