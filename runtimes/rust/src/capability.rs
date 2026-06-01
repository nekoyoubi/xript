//! Host-side capability grant wire shapes.
//!
//! These types describe a capability request, an installable mod, and an
//! addon-discovery result. They are mechanism-not-policy: a payload merely
//! DESCRIBES a request — granting still flows through
//! [`crate::RuntimeOptions::capabilities`]. The runtime never sees these shapes;
//! they live in host-side glue. `integrity` and `signature` are host-verified
//! strings — xript defines the fields and never checks them.

use serde::{Deserialize, Serialize};

use crate::error::{Result, ValidationIssue, XriptError};

/// The scope a host grant request covers. Closed enum, identical across runtimes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestedScope {
    OneRun,
    Session,
    Persistent,
}

/// The lifecycle state of a grant request. Closed enum, identical across runtimes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptState {
    FirstTime,
    PreviouslyDenied,
    RequestingElevation,
}

/// The requesting mod's identity carried on a capability prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptMod {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Everything a host needs to RENDER a first-time/elevation grant prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityPrompt {
    pub capability: String,
    pub description: String,
    pub risk: String,
    #[serde(rename = "mod")]
    pub requesting_mod: PromptMod,
    #[serde(rename = "requestedScope")]
    pub requested_scope: RequestedScope,
    pub state: PromptState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl CapabilityPrompt {
    /// Validates the payload's free-form fields. Enum members are already
    /// type-enforced by deserialization; this catches empty required strings.
    pub fn validate(&self) -> Result<()> {
        let mut issues = Vec::new();
        if self.capability.is_empty() {
            issues.push(ValidationIssue {
                path: "/capability".into(),
                message: "'capability' must be a non-empty string".into(),
            });
        }
        if !matches!(self.risk.as_str(), "low" | "medium" | "high") {
            issues.push(ValidationIssue {
                path: "/risk".into(),
                message: "'risk' must be one of low|medium|high".into(),
            });
        }
        if self.requesting_mod.name.is_empty() {
            issues.push(ValidationIssue {
                path: "/mod/name".into(),
                message: "'mod.name' must be a non-empty string".into(),
            });
        }
        finish(issues)
    }
}

/// Where an installable mod comes from. `type` is the closed enum file|url|registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallSourceType {
    File,
    Url,
    Registry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstallSource {
    #[serde(rename = "type")]
    pub source_type: InstallSourceType,
    pub location: String,
}

/// What identifies an installable mod: source, identity, integrity, capabilities.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstallDescriptor {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub source: InstallSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<serde_json::Value>,
}

impl InstallDescriptor {
    pub fn validate(&self) -> Result<()> {
        let mut issues = Vec::new();
        if !crate::manifest::is_role_identifier(&self.name) {
            issues.push(ValidationIssue {
                path: "/name".into(),
                message: "'name' must match ^[a-z][a-z0-9-]*$".into(),
            });
        }
        if self.version.is_empty() {
            issues.push(ValidationIssue {
                path: "/version".into(),
                message: "'version' must be a non-empty string".into(),
            });
        }
        if self.source.location.is_empty() {
            issues.push(ValidationIssue {
                path: "/source/location".into(),
                message: "'source.location' must be a non-empty string".into(),
            });
        }
        finish(issues)
    }
}

/// A single candidate yielded by an addon-discovery pass. `provides` carries the
/// logical roles the mod declares, tying back to the provider-role cluster.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscoveredMod {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub location: String,
    pub enabled: bool,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub provides: Vec<String>,
}

/// What an addon-discovery pass yields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscoveryResult {
    pub mods: Vec<DiscoveredMod>,
    #[serde(rename = "scannedAt")]
    pub scanned_at: f64,
}

impl DiscoveryResult {
    pub fn validate(&self) -> Result<()> {
        let mut issues = Vec::new();
        for (i, m) in self.mods.iter().enumerate() {
            if m.name.is_empty() {
                issues.push(ValidationIssue {
                    path: format!("/mods/{}/name", i),
                    message: "'name' must be a non-empty string".into(),
                });
            }
            for (j, role) in m.provides.iter().enumerate() {
                if !crate::manifest::is_role_identifier(role) {
                    issues.push(ValidationIssue {
                        path: format!("/mods/{}/provides/{}", i, j),
                        message: format!("role '{}' must match ^[a-z][a-z0-9-]*$", role),
                    });
                }
            }
        }
        finish(issues)
    }
}

fn finish(issues: Vec<ValidationIssue>) -> Result<()> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(XriptError::ManifestValidation { issues })
    }
}
