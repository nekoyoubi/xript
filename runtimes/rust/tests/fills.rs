use std::collections::{HashMap, HashSet};

use xript_runtime::{create_runtime, RuntimeOptions, XriptError};

fn host_manifest() -> &'static str {
    r#"{
        "xript": "0.7",
        "name": "fills-host",
        "capabilities": {
            "ui": { "description": "UI access" }
        },
        "slots": [
            { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true, "description": "left panel" },
            { "id": "gated.panel", "accepts": ["text/html"], "capability": "ui", "description": "gated panel" },
            { "id": "transcriber", "accepts": ["application/x-xript-role"], "description": "transcription provider" },
            { "id": "on-save", "accepts": ["application/x-xript-hook"], "description": "save event" }
        ]
    }"#
}

fn opts(capabilities: Vec<String>) -> RuntimeOptions {
    RuntimeOptions {
        capabilities,
        ..Default::default()
    }
}

const PANEL: &str = r#"<div><p data-bind="status">…</p></div>"#;

#[test]
fn loads_a_fragment_format_fill_and_resolves_the_slot() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let mod_json = r#"{
        "xript": "0.7", "name": "panel-mod", "version": "1.0.0",
        "fills": { "sidebar.left": [ { "id": "info-panel", "format": "text/html", "source": "fragments/panel.html", "bindings": [{ "name": "status", "path": "app.status" }] } ] }
    }"#;
    let sources = HashMap::from([("fragments/panel.html".to_string(), PANEL.to_string())]);
    let instance = rt.load_mod(mod_json, sources, &HashSet::new(), None).unwrap();
    assert_eq!(instance.fragments.len(), 1);
    assert_eq!(instance.fragments[0].id, "info-panel");
    let contributions = rt.resolve_slot("sidebar.left");
    assert_eq!(contributions.len(), 1);
    assert_eq!(contributions[0].fragment_id, "info-panel");
}

#[test]
fn synthesizes_a_stable_id_for_an_idless_fill() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let mod_json = r#"{
        "xript": "0.7", "name": "anon-mod", "version": "1.0.0",
        "fills": { "sidebar.left": [ { "format": "text/html", "source": "p.html" } ] }
    }"#;
    let sources = HashMap::from([("p.html".to_string(), PANEL.to_string())]);
    let instance = rt.load_mod(mod_json, sources, &HashSet::new(), None).unwrap();
    assert_eq!(instance.fragments[0].id, "sidebar.left-fill-0");
}

#[test]
fn loads_a_role_fill_and_resolves_the_provider() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let mod_json = r#"{
        "xript": "0.7", "name": "whisper-mod", "version": "1.0.0",
        "fills": { "transcriber": [ { "fns": { "transcribe": "doTranscribe" } } ] }
    }"#;
    rt.load_mod(mod_json, HashMap::new(), &HashSet::new(), None).unwrap();
    let resolution = rt.resolve_role("transcriber").unwrap();
    assert_eq!(resolution.addon, "whisper-mod");
    assert_eq!(resolution.fns.get("transcribe").map(String::as_str), Some("doTranscribe"));
}

#[test]
fn fires_an_event_hook_fills_handler_export() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let mod_json = r#"{
        "xript": "0.7", "name": "hook-mod", "version": "1.0.0",
        "entry": { "script": "mod.js", "exports": { "onSave": { "description": "save handler" } } },
        "fills": { "on-save": [ { "handler": "onSave" } ] }
    }"#;
    rt.load_mod(
        mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some(r#"xript.exports.register("onSave", function(path) { return "saved " + path; });"#),
    )
    .unwrap();
    let results = rt.fire_hook("on-save", &[serde_json::json!("/tmp/x")]).unwrap();
    assert_eq!(results, vec![serde_json::json!("saved /tmp/x")]);
}

#[test]
fn rejects_a_fill_targeting_an_undeclared_slot() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let mod_json = r#"{
        "xript": "0.7", "name": "m", "version": "1.0.0",
        "fills": { "ghost": [ { "format": "text/html", "source": "p.html" } ] }
    }"#;
    let err = rt.load_mod(mod_json, HashMap::new(), &HashSet::new(), None).unwrap_err();
    assert!(matches!(err, XriptError::ManifestValidation { ref issues } if issues[0].message.contains("does not exist")));
}

#[test]
fn gates_a_fill_on_the_slots_capability() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let mod_json = r#"{
        "xript": "0.7", "name": "m", "version": "1.0.0",
        "fills": { "gated.panel": [ { "format": "text/html", "source": "p.html" } ] }
    }"#;
    let sources = HashMap::from([("p.html".to_string(), PANEL.to_string())]);
    let err = rt.load_mod(mod_json, sources.clone(), &HashSet::new(), None).unwrap_err();
    assert!(matches!(err, XriptError::ManifestValidation { ref issues } if issues[0].message.contains("requires capability 'ui'")));

    let granted = create_runtime(host_manifest(), opts(vec!["ui".into()])).unwrap();
    let instance = granted
        .load_mod(mod_json, sources, &HashSet::from(["ui".to_string()]), None)
        .unwrap();
    assert_eq!(instance.fragments.len(), 1);
}

#[test]
fn rejects_mixing_fills_with_the_deprecated_surfaces() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let mod_json = r#"{
        "xript": "0.7", "name": "m", "version": "1.0.0",
        "fills": { "sidebar.left": [ { "format": "text/html", "source": "p.html" } ] },
        "fragments": [ { "id": "x", "slot": "sidebar.left", "format": "text/html", "source": "p.html" } ]
    }"#;
    let err = rt.load_mod(mod_json, HashMap::new(), &HashSet::new(), None).unwrap_err();
    assert!(matches!(err, XriptError::ManifestValidation { ref issues } if issues[0].message.contains("'fills' alone")));
}
