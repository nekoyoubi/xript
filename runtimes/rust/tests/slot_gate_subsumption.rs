use std::collections::{HashMap, HashSet};

use xript_runtime::{create_runtime, RuntimeOptions};

/// The fragment/slot gate is where a mod's *contribution* is admitted, and it is the gate the
/// capability hierarchy has to reach for a dotted scope to mean anything on a fill.
const HOST: &str = r#"{
    "xript": "0.8",
    "name": "slot-gate-app",
    "capabilities": {
        "ui": { "description": "UI surface." },
        "ui.sidebar": { "description": "The sidebar." }
    },
    "slots": [
        { "id": "sidebar", "accepts": ["text/html"], "description": "Sidebar.", "capability": "write:ui.sidebar" }
    ]
}"#;

const MOD: &str = r#"{
    "xript": "0.8", "name": "panel-mod", "version": "1.0.0",
    "capabilities": ["write:ui.sidebar"],
    "fills": { "sidebar": [{ "id": "panel", "format": "text/html", "source": "panel.html" }] }
}"#;

fn admits(granted: &[&str]) -> bool {
    let rt = create_runtime(
        HOST,
        RuntimeOptions {
            capabilities: granted.iter().map(|c| c.to_string()).collect(),
            ..RuntimeOptions::default()
        },
    )
    .unwrap();

    let mut sources = HashMap::new();
    sources.insert("panel.html".to_string(), "<p>hi</p>".to_string());
    let grants: HashSet<String> = granted.iter().map(|c| c.to_string()).collect();

    rt.load_mod(MOD, sources, &grants, None).is_ok()
}

#[test]
fn a_parent_scope_grant_subsumes_the_slots_gate() {
    assert!(admits(&["write:ui"]));
}

#[test]
fn an_exact_scope_grant_is_admitted() {
    assert!(admits(&["write:ui.sidebar"]));
}

#[test]
fn a_read_grant_is_refused_against_a_write_gate() {
    assert!(!admits(&["read:ui"]));
}

#[test]
fn a_scope_sharing_only_a_character_prefix_is_refused() {
    assert!(!admits(&["write:uiother"]));
}
