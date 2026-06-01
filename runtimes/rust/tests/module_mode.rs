use std::collections::{HashMap, HashSet};

use xript_runtime::{
    create_runtime, ConsoleHandler, HostBindings, RuntimeOptions, XriptError,
};

fn opts() -> RuntimeOptions {
    RuntimeOptions {
        host_bindings: HostBindings::new(),
        capabilities: vec![],
        console: ConsoleHandler::default(),
        cancellation: None,
        audit: None,
        hard_limits: None,
        role_preferences: HashMap::new(),
        debug: None,
    }
}

fn app_manifest() -> &'static str {
    r#"{
        "xript": "0.3",
        "name": "test-app",
        "slots": [
            { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true }
        ]
    }"#
}

fn mod_with_entry(format: &str, exports: &str) -> String {
    format!(
        r#"{{
            "xript": "0.3",
            "name": "mod-mode-test",
            "version": "1.0.0",
            "entry": {{ "script": "src/mod.ts", "format": "{format}", "exports": {exports} }},
            "fragments": [
                {{ "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }}
            ]
        }}"#
    )
}

#[test]
fn module_top_level_export_is_invokable() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", r#"{ "greet": { "description": "g" } }"#);

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("export function greet(name) { return 'hi ' + name; }"),
    )
    .unwrap();

    let result = rt
        .invoke_export("greet", &[serde_json::json!("world")])
        .unwrap();
    assert_eq!(result, serde_json::json!("hi world"));
}

#[test]
fn module_const_function_export_is_invokable() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("const add = (a, b) => a + b; export { add };"),
    )
    .unwrap();

    let result = rt
        .invoke_export("add", &[serde_json::json!(2), serde_json::json!(3)])
        .unwrap();
    assert_eq!(result, serde_json::json!(5));
}

#[test]
fn module_non_function_export_is_ignored_not_errored() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("export const VERSION = '1.0'; export function go() { return 1; }"),
    )
    .unwrap();

    let go = rt.invoke_export("go", &[]).unwrap();
    assert_eq!(go, serde_json::json!(1));

    let version = rt.invoke_export("VERSION", &[]);
    assert!(version.is_err());
}

#[test]
fn module_default_export_is_not_harvested() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("export default function() { return 42; }"),
    )
    .unwrap();

    let result = rt.invoke_export("default", &[]);
    assert!(result.is_err());
}

#[test]
fn module_register_wins_on_name_collision() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some(
            "export function pick() { return 'export'; } xript.exports.register('pick', function() { return 'register'; });",
        ),
    )
    .unwrap();

    let result = rt.invoke_export("pick", &[]).unwrap();
    assert_eq!(result, serde_json::json!("register"));
}

#[test]
fn module_side_effecting_register_still_works() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("xript.exports.register('sideEffect', function() { return 'ok'; });"),
    )
    .unwrap();

    let result = rt.invoke_export("sideEffect", &[]).unwrap();
    assert_eq!(result, serde_json::json!("ok"));
}

#[test]
fn module_top_level_await_settles() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("const v = await Promise.resolve(7); export function getV() { return v; }"),
    )
    .unwrap();

    let result = rt.invoke_export("getV", &[]).unwrap();
    assert_eq!(result, serde_json::json!(7));
}

#[test]
fn module_top_level_throw_is_mod_entry_error() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("throw new Error('module boom'); export function x() {}"),
    );
    let err = result.expect_err("top-level throw should fail load");
    assert!(matches!(err, XriptError::ModEntry { .. }));
    assert!(err.to_string().contains("module boom"));
}

#[test]
fn module_syntax_error_is_mod_entry_error() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("export function broken( {"),
    );
    assert!(matches!(result, Err(XriptError::ModEntry { .. })));
}

#[test]
fn module_bare_import_is_denied() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("import fs from 'fs'; export function x() {}"),
    );
    let err = result.expect_err("bare import should be denied");
    match err {
        XriptError::ImportDenied { specifier, .. } => assert_eq!(specifier, "fs"),
        other => panic!("expected ImportDenied, got {other:?}"),
    }
}

#[test]
fn module_relative_import_is_denied() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("import { helper } from './util.js'; export function x() {}"),
    );
    match result {
        Err(XriptError::ImportDenied { specifier, .. }) => assert_eq!(specifier, "./util.js"),
        other => panic!("expected ImportDenied, got {other:?}"),
    }
}

#[test]
fn module_named_import_with_from_is_denied() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("import { map } from 'lodash'; export function x() {}"),
    );
    match result {
        Err(XriptError::ImportDenied { specifier, .. }) => assert_eq!(specifier, "lodash"),
        other => panic!("expected ImportDenied, got {other:?}"),
    }
}

#[test]
fn module_dynamic_import_is_denied() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("export async function x() { return await import('os'); }"),
    );
    match result {
        Err(XriptError::ImportDenied { specifier, .. }) => assert_eq!(specifier, "os"),
        other => panic!("expected ImportDenied, got {other:?}"),
    }
}

#[test]
fn import_string_in_quotes_is_not_a_false_positive() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("export function describe() { return \"use import x from 'y' carefully\"; }"),
    )
    .unwrap();

    let result = rt.invoke_export("describe", &[]).unwrap();
    assert_eq!(result, serde_json::json!("use import x from 'y' carefully"));
}

#[test]
fn commonjs_require_is_detected_in_module_mode() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("module", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("const fs = require('fs'); export function x() {}"),
    );
    match result {
        Err(XriptError::CommonJsDetected { artifact, .. }) => assert_eq!(artifact, "require()"),
        other => panic!("expected CommonJsDetected, got {other:?}"),
    }
}

#[test]
fn commonjs_module_exports_is_detected_in_script_mode() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("script", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("module.exports = { greet: function() {} };"),
    );
    match result {
        Err(XriptError::CommonJsDetected { artifact, .. }) => assert_eq!(artifact, "module.exports"),
        other => panic!("expected CommonJsDetected, got {other:?}"),
    }
}

#[test]
fn commonjs_exports_assignment_is_detected() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("script", "{}");

    let result = rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("exports.greet = function() { return 1; };"),
    );
    match result {
        Err(XriptError::CommonJsDetected { artifact, .. }) => assert_eq!(artifact, "exports.x"),
        other => panic!("expected CommonJsDetected, got {other:?}"),
    }
}

#[test]
fn commonjs_inside_string_is_not_a_false_positive() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("script", "{}");

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("xript.exports.register('say', function() { return 'use require() please'; });"),
    )
    .unwrap();

    let result = rt.invoke_export("say", &[]).unwrap();
    assert_eq!(result, serde_json::json!("use require() please"));
}

#[test]
fn script_mode_register_still_works_unchanged() {
    let rt = create_runtime(app_manifest(), opts()).unwrap();
    let mod_json = mod_with_entry("script", r#"{ "calc": { "description": "c" } }"#);

    rt.load_mod(
        &mod_json,
        HashMap::new(),
        &HashSet::new(),
        Some("xript.exports.register('calc', function(x) { return x * 2; });"),
    )
    .unwrap();

    let result = rt.invoke_export("calc", &[serde_json::json!(21)]).unwrap();
    assert_eq!(result, serde_json::json!(42));
}

#[test]
fn module_export_capability_gating_is_enforced() {
    let manifest = r#"{
        "xript": "0.3",
        "name": "test-app",
        "capabilities": { "danger": { "description": "d" } },
        "slots": [
            { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true }
        ]
    }"#;

    let mod_json = r#"{
        "xript": "0.3",
        "name": "gated-mod",
        "version": "1.0.0",
        "capabilities": ["danger"],
        "entry": {
            "script": "src/mod.ts",
            "format": "module",
            "exports": { "risky": { "description": "r", "capability": "danger" } }
        },
        "fragments": [
            { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
        ]
    }"#;

    let rt = create_runtime(manifest, opts()).unwrap();
    let mut granted = HashSet::new();
    granted.insert("danger".to_string());

    rt.load_mod(
        mod_json,
        HashMap::new(),
        &granted,
        Some("export function risky() { return 'boom'; }"),
    )
    .unwrap();

    let result = rt.invoke_export("risky", &[]);
    assert!(matches!(result, Err(XriptError::CapabilityDenied { .. })));
}
