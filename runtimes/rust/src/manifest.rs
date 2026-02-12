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
