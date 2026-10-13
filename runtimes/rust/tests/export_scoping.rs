use std::collections::{HashMap, HashSet};

use xript_runtime::{create_runtime, RuntimeOptions, XriptError};

fn host_manifest() -> &'static str {
    r#"{
        "xript": "0.7",
        "name": "export-scoping-host",
        "capabilities": {
            "fs.write": { "description": "write files" }
        },
        "slots": [
            { "id": "on-tick", "accepts": ["application/x-xript-hook"], "description": "tick event" },
            { "id": "transcriber", "accepts": ["application/x-xript-role"], "description": "transcription provider" }
        ]
    }"#
}

fn opts(capabilities: Vec<String>) -> RuntimeOptions {
    RuntimeOptions {
        capabilities,
        ..Default::default()
    }
}

const GATED_MOD: &str = r#"{
    "xript": "0.7", "name": "mod-a", "version": "1.0.0",
    "entry": { "script": "a.js", "format": "script", "exports": {
        "doThing": { "description": "does a gated thing", "capability": "fs.write" }
    }}
}"#;

const GATED_SOURCE: &str = "xript.exports.register('doThing', function() { return 'A-SECRET-RAN'; })";

fn granted(caps: &[&str]) -> HashSet<String> {
    caps.iter().map(|c| c.to_string()).collect()
}

#[test]
fn a_capability_less_redeclaration_does_not_strip_the_gate() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    rt.load_mod(GATED_MOD, HashMap::new(), &granted(&[]), Some(GATED_SOURCE))
        .unwrap();

    assert!(matches!(
        rt.invoke_export("doThing", &[]),
        Err(XriptError::CapabilityDenied { .. })
    ));

    let stripper = r#"{
        "xript": "0.7", "name": "mod-b", "version": "1.0.0",
        "entry": { "script": "b.js", "format": "script", "exports": {
            "doThing": { "description": "no capability at all" }
        }}
    }"#;
    rt.load_mod(stripper, HashMap::new(), &granted(&[]), Some(""))
        .unwrap();

    match rt.invoke_export("doThing", &[]) {
        Err(XriptError::AmbiguousExport { .. }) | Err(XriptError::CapabilityDenied { .. }) => {}
        other => panic!("the gate did not hold: {other:?}"),
    }
}

#[test]
fn a_later_mod_cannot_hijack_an_earlier_mod_export() {
    let rt = create_runtime(host_manifest(), opts(vec!["fs.write".into()])).unwrap();
    rt.load_mod(
        GATED_MOD,
        HashMap::new(),
        &granted(&["fs.write"]),
        Some(GATED_SOURCE),
    )
    .unwrap();

    let hijacker = r#"{
        "xript": "0.7", "name": "mod-c", "version": "1.0.0",
        "entry": { "script": "c.js", "format": "script", "exports": {
            "doThing": { "description": "hijack" }
        }}
    }"#;
    rt.load_mod(
        hijacker,
        HashMap::new(),
        &granted(&["fs.write"]),
        Some("xript.exports.register('doThing', function() { return 'C-HIJACKED'; })"),
    )
    .unwrap();

    assert_eq!(
        rt.invoke_mod_export("mod-a", "doThing", &[]).unwrap(),
        serde_json::json!("A-SECRET-RAN")
    );
    assert_eq!(
        rt.invoke_mod_export("mod-c", "doThing", &[]).unwrap(),
        serde_json::json!("C-HIJACKED")
    );

    match rt.invoke_export("doThing", &[]) {
        Err(XriptError::AmbiguousExport { export, mods }) => {
            assert_eq!(export, "doThing");
            assert_eq!(mods, vec!["mod-a".to_string(), "mod-c".to_string()]);
        }
        other => panic!("expected an ambiguity error, got {other:?}"),
    }
}

#[test]
fn a_hook_fill_cannot_reach_another_mods_gated_export() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    rt.load_mod(GATED_MOD, HashMap::new(), &granted(&[]), Some(GATED_SOURCE))
        .unwrap();

    let parasite = r#"{
        "xript": "0.7", "name": "mod-parasite", "version": "1.0.0",
        "fills": { "on-tick": [{ "handler": "doThing" }] }
    }"#;
    rt.load_mod(parasite, HashMap::new(), &granted(&[]), None)
        .unwrap();

    let results = rt.fire_hook("on-tick", &[]).unwrap();
    assert!(
        !results.contains(&serde_json::json!("A-SECRET-RAN")),
        "hook fill reached another mod's export: {results:?}"
    );
}

#[test]
fn a_mods_own_hook_fill_still_fires_under_its_own_grant() {
    let owning_mod = r#"{
        "xript": "0.7", "name": "mod-a", "version": "1.0.0",
        "entry": { "script": "a.js", "format": "script", "exports": {
            "doThing": { "description": "does a gated thing", "capability": "fs.write" }
        }},
        "fills": { "on-tick": [{ "handler": "doThing" }] }
    }"#;

    let rt = create_runtime(host_manifest(), opts(vec!["fs.write".into()])).unwrap();
    rt.load_mod(
        owning_mod,
        HashMap::new(),
        &granted(&["fs.write"]),
        Some(GATED_SOURCE),
    )
    .unwrap();
    assert_eq!(
        rt.fire_hook("on-tick", &[]).unwrap(),
        vec![serde_json::json!("A-SECRET-RAN")]
    );

    let denied = create_runtime(host_manifest(), opts(vec![])).unwrap();
    denied
        .load_mod(
            owning_mod,
            HashMap::new(),
            &granted(&[]),
            Some(GATED_SOURCE),
        )
        .unwrap();
    assert_eq!(
        denied.fire_hook("on-tick", &[]).unwrap(),
        vec![serde_json::Value::Null]
    );
}

#[test]
fn two_role_providers_coexist_on_one_export_name() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();

    let fast = r#"{
        "xript": "0.7", "name": "fast-transcriber", "version": "1.0.0",
        "entry": { "script": "fast.js", "format": "script", "exports": { "transcribe": { "description": "fast" } } },
        "fills": { "transcriber": [{ "fns": { "transcribe": "transcribe" } }] }
    }"#;
    let good = r#"{
        "xript": "0.7", "name": "good-transcriber", "version": "1.0.0",
        "entry": { "script": "good.js", "format": "script", "exports": { "transcribe": { "description": "good" } } },
        "fills": { "transcriber": [{ "fns": { "transcribe": "transcribe" } }] }
    }"#;

    rt.load_mod(
        fast,
        HashMap::new(),
        &granted(&[]),
        Some("xript.exports.register('transcribe', function() { return 'fast'; })"),
    )
    .unwrap();
    rt.load_mod(
        good,
        HashMap::new(),
        &granted(&[]),
        Some("xript.exports.register('transcribe', function() { return 'good'; })"),
    )
    .unwrap();

    let providers = rt.resolve_role_all("transcriber");
    assert_eq!(providers.len(), 2);
    let results: Vec<serde_json::Value> = providers
        .iter()
        .map(|p| {
            rt.invoke_mod_export(&p.addon, p.fns.get("transcribe").unwrap(), &[])
                .unwrap()
        })
        .collect();
    assert_eq!(
        results,
        vec![serde_json::json!("fast"), serde_json::json!("good")]
    );
}

#[test]
fn a_lone_mod_export_stays_invokable_by_bare_name() {
    let rt = create_runtime(host_manifest(), opts(vec!["fs.write".into()])).unwrap();
    rt.load_mod(
        GATED_MOD,
        HashMap::new(),
        &granted(&["fs.write"]),
        Some(GATED_SOURCE),
    )
    .unwrap();
    assert_eq!(
        rt.invoke_export("doThing", &[]).unwrap(),
        serde_json::json!("A-SECRET-RAN")
    );
}

#[test]
fn a_host_level_registration_stays_invokable_by_bare_name() {
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    rt.execute("xript.exports.register('hostSide', function(n) { return n * 2; })")
        .unwrap();
    assert_eq!(
        rt.invoke_export("hostSide", &[serde_json::json!(21)]).unwrap(),
        serde_json::json!(42)
    );
}
