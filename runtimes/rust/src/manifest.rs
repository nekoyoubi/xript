use serde::Deserialize;
use std::collections::HashMap;

use crate::error::{ValidationIssue, XriptError};

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub xript: String,
    pub name: String,
    pub version: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub bindings: Option<HashMap<String, Binding>>,
    pub hooks: Option<HashMap<String, HookDef>>,
    pub capabilities: Option<HashMap<String, Capability>>,
    pub limits: Option<Limits>,
    pub slots: Option<Vec<Slot>>,
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
    pub capabilities: Option<Vec<String>>,
    pub entry: Option<serde_json::Value>,
    pub fragments: Option<Vec<FragmentDeclaration>>,
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

    if issues.is_empty() {
        Ok(())
    } else {
        Err(XriptError::ManifestValidation { issues })
    }
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
