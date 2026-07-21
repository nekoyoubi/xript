use std::collections::{HashMap, HashSet};

use serde_json::json;
use xript_runtime::{create_runtime, RuntimeOptions, XriptError};

fn host_manifest() -> &'static str {
    r#"{
        "xript": "0.8",
        "name": "command-host",
        "capabilities": {
            "editor": { "description": "editor surface" },
            "editor.text": { "description": "document text" },
            "editor-destructive": { "description": "irreversible edits" }
        },
        "slots": [
            {
                "id": "palette.commands",
                "accepts": ["application/x-xript-command"],
                "description": "named actions in the palette",
                "capability": "write:editor.text",
                "multiple": true
            },
            {
                "id": "single.command",
                "accepts": ["application/x-xript-command"],
                "description": "one action only"
            }
        ]
    }"#
}

fn opts(capabilities: Vec<String>) -> RuntimeOptions {
    RuntimeOptions {
        capabilities,
        ..Default::default()
    }
}

fn granted(caps: &[&str]) -> HashSet<String> {
    caps.iter().map(|c| c.to_string()).collect()
}

const QUOTE_TOOLS: &str = r#"{
    "xript": "0.8", "name": "quote-tools", "version": "1.0.0",
    "entry": { "path": "main.js", "format": "module", "exports": {
        "wrapSelection": { "description": "wrap the selection" },
        "stripFormatting": { "description": "irreversible", "capability": "write:editor-destructive" }
    }},
    "capabilities": ["write:editor.text", "write:editor-destructive"],
    "fills": {
        "palette.commands": [
            { "id": "wrap.double", "title": "Wrap in double quotes", "handler": "wrapSelection",
              "args": { "open": "\"", "close": "\"" } },
            { "id": "wrap.paren", "handler": "wrapSelection", "args": { "open": "(", "close": ")" } },
            { "id": "strip.formatting", "handler": "stripFormatting", "priority": -10 }
        ]
    }
}"#;

const QUOTE_SOURCE: &str = r#"
export function wrapSelection(args) {
    return (args.open || "") + (args.body || "") + (args.close || "");
}
export function stripFormatting() {
    return "stripped";
}
"#;

fn quote_runtime(caps: &[&str]) -> xript_runtime::XriptRuntime {
    let rt = create_runtime(
        host_manifest(),
        opts(caps.iter().map(|c| c.to_string()).collect()),
    )
    .unwrap();
    rt.load_mod(
        QUOTE_TOOLS,
        HashMap::new(),
        &granted(caps),
        Some(QUOTE_SOURCE),
    )
    .unwrap();
    rt
}

#[test]
fn resolves_commands_in_the_shared_slot_order() {
    let rt = quote_runtime(&["write:editor.text", "write:editor-destructive"]);
    let ids: Vec<String> = rt
        .resolve_commands("palette.commands")
        .into_iter()
        .map(|c| c.qualified_id)
        .collect();
    assert_eq!(
        ids,
        vec![
            "quote-tools:wrap.double",
            "quote-tools:wrap.paren",
            "quote-tools:strip.formatting",
        ]
    );
}

#[test]
fn reports_the_export_gate_as_the_command_authority() {
    let rt = quote_runtime(&["write:editor.text", "write:editor-destructive"]);
    let commands = rt.resolve_commands("palette.commands");
    let wrap = commands.iter().find(|c| c.id == "wrap.double").unwrap();
    let strip = commands.iter().find(|c| c.id == "strip.formatting").unwrap();
    assert_eq!(wrap.capability.as_deref(), Some("write:editor.text"));
    assert_eq!(strip.capability.as_deref(), Some("write:editor-destructive"));
    assert!(!wrap.collides);
}

#[test]
fn invokes_a_command_with_bound_args_merged_call_time_first() {
    let rt = quote_runtime(&["write:editor.text", "write:editor-destructive"]);
    let wrap = rt.resolve_command("wrap.double").unwrap();

    let bound_only = rt.invoke_command(&wrap, None).unwrap();
    assert_eq!(bound_only, json!("\"\""));

    let call_args = json!({ "body": "hi", "open": "[" });
    let merged = rt
        .invoke_command(&wrap, call_args.as_object())
        .unwrap();
    assert_eq!(merged, json!("[hi\""));
}

#[test]
fn a_command_handler_that_throws_propagates_rather_than_being_swallowed() {
    let manifest = r#"{
        "xript": "0.8", "name": "boom-tools", "version": "1.0.0",
        "entry": { "path": "main.js", "format": "module", "exports": { "boom": { "description": "throws" } } },
        "fills": { "palette.commands": [{ "id": "boom", "handler": "boom" }] }
    }"#;
    let rt = create_runtime(host_manifest(), opts(vec!["write:editor.text".into()])).unwrap();
    rt.load_mod(
        manifest,
        HashMap::new(),
        &granted(&["write:editor.text"]),
        Some("export function boom() { throw new Error('nope'); }"),
    )
    .unwrap();

    let command = rt.resolve_command("boom").unwrap();
    assert!(matches!(
        rt.invoke_command(&command, None),
        Err(XriptError::Invoke { .. })
    ));
}

#[test]
fn an_ungranted_export_capability_denies_the_command_at_invoke() {
    let rt = quote_runtime(&["write:editor.text"]);
    let strip = rt.resolve_command("strip.formatting").unwrap();
    assert!(matches!(
        rt.invoke_command(&strip, None),
        Err(XriptError::CapabilityDenied { .. })
    ));
    let wrap = rt.resolve_command("wrap.paren").unwrap();
    assert!(rt.invoke_command(&wrap, None).is_ok());
}

#[test]
fn a_command_runs_in_its_own_mod_namespace_when_two_mods_share_a_handler_name() {
    let rt = create_runtime(host_manifest(), opts(vec!["write:editor.text".into()])).unwrap();
    let mod_json = |name: &str, id: &str| {
        format!(
            r#"{{
                "xript": "0.8", "name": "{name}", "version": "1.0.0",
                "entry": {{ "path": "main.js", "format": "module", "exports": {{ "run": {{ "description": "run" }} }} }},
                "fills": {{ "palette.commands": [{{ "id": "{id}", "handler": "run" }}] }}
            }}"#
        )
    };
    rt.load_mod(
        &mod_json("alpha-tools", "alpha"),
        HashMap::new(),
        &granted(&["write:editor.text"]),
        Some("export function run() { return 'alpha'; }"),
    )
    .unwrap();
    rt.load_mod(
        &mod_json("zeta-tools", "zeta"),
        HashMap::new(),
        &granted(&["write:editor.text"]),
        Some("export function run() { return 'zeta'; }"),
    )
    .unwrap();

    // A bare invoke of the shared name is ambiguous; the command path is not.
    assert!(matches!(
        rt.invoke_export("run", &[]),
        Err(XriptError::AmbiguousExport { .. })
    ));
    let alpha = rt.resolve_command("alpha-tools:alpha").unwrap();
    let zeta = rt.resolve_command("zeta-tools:zeta").unwrap();
    assert_eq!(rt.invoke_command(&alpha, None).unwrap(), json!("alpha"));
    assert_eq!(rt.invoke_command(&zeta, None).unwrap(), json!("zeta"));
}

#[test]
fn a_singular_command_slot_resolves_to_exactly_one_command() {
    let manifest = r#"{
        "xript": "0.8", "name": "single-tools", "version": "1.0.0",
        "entry": { "path": "main.js", "format": "module", "exports": { "run": { "description": "run" } } },
        "fills": { "single.command": [
            { "id": "b.second", "handler": "run" },
            { "id": "a.first", "handler": "run" }
        ] }
    }"#;
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    rt.load_mod(
        manifest,
        HashMap::new(),
        &granted(&[]),
        Some("export function run() { return 1; }"),
    )
    .unwrap();

    let resolved = rt.resolve_commands("single.command");
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].id, "a.first");
    assert_eq!(rt.resolve_commands_all("single.command").len(), 2);
}

#[test]
fn a_command_fill_carrying_a_capability_is_refused_at_load() {
    let manifest = r#"{
        "xript": "0.8", "name": "bad-tools", "version": "1.0.0",
        "entry": { "path": "main.js", "format": "module", "exports": { "run": { "description": "run" } } },
        "fills": { "palette.commands": [
            { "id": "nope", "handler": "run", "capability": "write:editor-destructive" }
        ] }
    }"#;
    let rt = create_runtime(host_manifest(), opts(vec!["write:editor.text".into()])).unwrap();
    let err = rt
        .load_mod(
            manifest,
            HashMap::new(),
            &granted(&["write:editor.text"]),
            None,
        )
        .unwrap_err();
    match err {
        XriptError::ManifestValidation { issues } => {
            assert!(issues[0].message.contains("per-action authority lives on the export"));
        }
        other => panic!("expected a manifest validation error, got {other:?}"),
    }
}

#[test]
fn a_malformed_command_fill_is_a_load_time_error_not_an_opaque_object() {
    let manifest = r#"{
        "xript": "0.8", "name": "bad-tools", "version": "1.0.0",
        "entry": { "path": "main.js", "format": "module", "exports": { "run": { "description": "run" } } },
        "fills": { "palette.commands": [{ "id": "no.handler" }] }
    }"#;
    let rt = create_runtime(host_manifest(), opts(vec!["write:editor.text".into()])).unwrap();
    assert!(rt
        .load_mod(
            manifest,
            HashMap::new(),
            &granted(&["write:editor.text"]),
            None
        )
        .is_err());
}

#[test]
fn command_fills_no_longer_land_in_the_fragment_surface() {
    let rt = quote_runtime(&["write:editor.text", "write:editor-destructive"]);
    let instance = rt
        .load_mod(
            r#"{
                "xript": "0.8", "name": "probe-tools", "version": "1.0.0",
                "entry": { "path": "main.js", "format": "module", "exports": { "run": { "description": "run" } } },
                "fills": { "palette.commands": [{ "id": "probe", "handler": "run" }] }
            }"#,
            HashMap::new(),
            &granted(&["write:editor.text"]),
            Some("export function run() { return 1; }"),
        )
        .unwrap();
    assert!(instance.fragments.is_empty());
    assert!(instance.provides.is_empty());
    assert_eq!(rt.resolve_commands("palette.commands").len(), 4);
}

#[test]
fn an_ungranted_slot_gate_refuses_the_command_contribution() {
    let manifest = r#"{
        "xript": "0.8", "name": "ungranted-tools", "version": "1.0.0",
        "entry": { "path": "main.js", "format": "module", "exports": { "run": { "description": "run" } } },
        "fills": { "palette.commands": [{ "id": "wrap", "handler": "run" }] }
    }"#;
    let rt = create_runtime(host_manifest(), opts(vec![])).unwrap();
    let err = rt
        .load_mod(manifest, HashMap::new(), &granted(&[]), None)
        .unwrap_err();
    match err {
        XriptError::ManifestValidation { issues } => {
            assert!(issues[0].message.contains("requires capability"));
        }
        other => panic!("expected a manifest validation error, got {other:?}"),
    }
    assert!(rt.resolve_commands("palette.commands").is_empty());
}

#[test]
fn command_preferences_pick_the_owner_for_a_bare_id() {
    let rt = create_runtime(
        host_manifest(),
        RuntimeOptions {
            capabilities: vec!["write:editor.text".into()],
            command_preferences: [("wrap".to_string(), "zeta-tools".to_string())]
                .into_iter()
                .collect(),
            ..Default::default()
        },
    )
    .unwrap();
    let mod_json = |name: &str| {
        format!(
            r#"{{
                "xript": "0.8", "name": "{name}", "version": "1.0.0",
                "entry": {{ "path": "main.js", "format": "module", "exports": {{ "run": {{ "description": "run" }} }} }},
                "fills": {{ "palette.commands": [{{ "id": "wrap", "handler": "run" }}] }}
            }}"#
        )
    };
    for name in ["alpha-tools", "zeta-tools"] {
        rt.load_mod(
            &mod_json(name),
            HashMap::new(),
            &granted(&["write:editor.text"]),
            Some(&format!("export function run() {{ return '{name}'; }}")),
        )
        .unwrap();
    }

    let resolved = rt.resolve_command("wrap").unwrap();
    assert_eq!(resolved.qualified_id, "zeta-tools:wrap");
    assert!(resolved.collides);
    assert_eq!(rt.invoke_command(&resolved, None).unwrap(), json!("zeta-tools"));
}

#[test]
fn role_resolution_does_not_depend_on_load_order() {
    let role_host = r#"{
        "xript": "0.8",
        "name": "role-host",
        "slots": [
            { "id": "clipboard-history", "accepts": ["application/x-xript-role"], "description": "provider" }
        ]
    }"#;
    let provider = |name: &str| {
        format!(
            r#"{{
                "xript": "0.8", "name": "{name}", "version": "1.0.0",
                "fills": {{ "clipboard-history": [{{ "fns": {{ "query": "{name}_query" }} }}] }}
            }}"#
        )
    };
    let names_for = |order: [&str; 3]| -> Vec<String> {
        let rt = create_runtime(role_host, opts(vec![])).unwrap();
        for name in order {
            rt.load_mod(&provider(name), HashMap::new(), &granted(&[]), None)
                .unwrap();
        }
        rt.resolve_role_all("clipboard-history")
            .into_iter()
            .map(|r| r.addon)
            .collect()
    };

    let forward = names_for(["clip-a", "clip-b", "clip-c"]);
    let reverse = names_for(["clip-c", "clip-b", "clip-a"]);
    assert_eq!(forward, vec!["clip-a", "clip-b", "clip-c"]);
    assert_eq!(forward, reverse);

    let rt = create_runtime(role_host, opts(vec![])).unwrap();
    for name in ["clip-z", "clip-a"] {
        rt.load_mod(&provider(name), HashMap::new(), &granted(&[]), None)
            .unwrap();
    }
    assert_eq!(rt.resolve_role("clipboard-history").unwrap().addon, "clip-a");
}
