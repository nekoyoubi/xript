use std::collections::{HashMap, HashSet};

use xript_runtime::{create_runtime, RuntimeOptions, XriptError};

const DOC_LIB: &str = r#"export function shout(s){ return s.toUpperCase() + "!"; }
export const NAME = "doc-lib";"#;

fn host_manifest() -> &'static str {
    r#"{
        "xript": "0.7",
        "name": "library-host",
        "capabilities": {
            "lib": { "description": "shared libraries" }
        },
        "libraries": {
            "@example/doc": { "description": "doc helpers", "capability": "lib.doc", "version": "^1.0.0" },
            "open-lib": { "description": "ungated helpers" }
        }
    }"#
}

fn mod_manifest() -> &'static str {
    r#"{
        "xript": "0.7",
        "name": "lib-consumer",
        "version": "1.0.0",
        "entry": { "script": "mod.js", "format": "module", "exports": { "use": { "description": "uses the lib" } } }
    }"#
}

fn opts(capabilities: Vec<String>, libraries: HashMap<String, String>) -> RuntimeOptions {
    RuntimeOptions {
        capabilities,
        libraries,
        ..Default::default()
    }
}

fn doc_libraries() -> HashMap<String, String> {
    HashMap::from([("@example/doc".to_string(), DOC_LIB.to_string())])
}

#[test]
fn links_an_approved_library_with_full_fidelity_calls() {
    let rt = create_runtime(host_manifest(), opts(vec!["lib.doc".into()], doc_libraries())).unwrap();
    rt.load_mod(
        mod_manifest(),
        HashMap::new(),
        &HashSet::new(),
        Some(r#"import { shout, NAME } from "@example/doc"; export function use(s){ return NAME + ": " + shout(s); }"#),
    )
    .unwrap();
    let result = rt.invoke_export("use", &[serde_json::json!("hi")]).unwrap();
    assert_eq!(result, serde_json::json!("doc-lib: HI!"));
}

#[test]
fn satisfies_the_gate_through_capability_subsumption() {
    let rt = create_runtime(host_manifest(), opts(vec!["lib".into()], doc_libraries())).unwrap();
    rt.load_mod(
        mod_manifest(),
        HashMap::new(),
        &HashSet::new(),
        Some(r#"import { shout } from "@example/doc"; export function use(s){ return shout(s); }"#),
    )
    .unwrap();
    let result = rt.invoke_export("use", &[serde_json::json!("ok")]).unwrap();
    assert_eq!(result, serde_json::json!("OK!"));
}

#[test]
fn denies_an_undeclared_specifier() {
    let rt = create_runtime(host_manifest(), opts(vec!["lib".into()], doc_libraries())).unwrap();
    let err = rt
        .load_mod(
            mod_manifest(),
            HashMap::new(),
            &HashSet::new(),
            Some(r#"import _ from "lodash"; export function use(){ return 1; }"#),
        )
        .unwrap_err();
    assert!(matches!(err, XriptError::ImportDenied { ref specifier, .. } if specifier == "lodash"));
}

#[test]
fn denies_an_ungranted_library() {
    let rt = create_runtime(host_manifest(), opts(vec![], doc_libraries())).unwrap();
    let err = rt
        .load_mod(
            mod_manifest(),
            HashMap::new(),
            &HashSet::new(),
            Some(r#"import { shout } from "@example/doc"; export function use(){ return 1; }"#),
        )
        .unwrap_err();
    assert!(matches!(err, XriptError::CapabilityDenied { ref capability, .. } if capability == "lib.doc"));
}

#[test]
fn allows_an_ungated_library_with_no_grants() {
    let libs = HashMap::from([("open-lib".to_string(), "export function id(x){ return x; }".to_string())]);
    let rt = create_runtime(host_manifest(), opts(vec![], libs)).unwrap();
    rt.load_mod(
        mod_manifest(),
        HashMap::new(),
        &HashSet::new(),
        Some(r#"import { id } from "open-lib"; export function use(x){ return id(x); }"#),
    )
    .unwrap();
    let result = rt.invoke_export("use", &[serde_json::json!(9)]).unwrap();
    assert_eq!(result, serde_json::json!(9));
}

#[test]
fn names_the_host_bug_when_declared_but_unregistered() {
    let rt = create_runtime(host_manifest(), opts(vec!["lib".into()], HashMap::new())).unwrap();
    let err = rt
        .load_mod(
            mod_manifest(),
            HashMap::new(),
            &HashSet::new(),
            Some(r#"import { shout } from "@example/doc"; export function use(){ return 1; }"#),
        )
        .unwrap_err();
    assert!(matches!(err, XriptError::LibraryUnavailable { ref specifier } if specifier == "@example/doc"));
}

#[test]
fn rejects_registering_an_undeclared_specifier() {
    let libs = HashMap::from([("rogue".to_string(), "export const x = 1;".to_string())]);
    let err = create_runtime(host_manifest(), opts(vec![], libs)).unwrap_err();
    assert!(matches!(err, XriptError::LibraryRegistration { ref specifier, .. } if specifier == "rogue"));
}

#[test]
fn rejects_a_library_that_is_not_import_clean() {
    let libs = HashMap::from([(
        "@example/doc".to_string(),
        r#"import _ from "lodash"; export function shout(){}"#.to_string(),
    )]);
    let err = create_runtime(host_manifest(), opts(vec![], libs)).unwrap_err();
    assert!(
        matches!(err, XriptError::LibraryRegistration { ref reason, .. } if reason.contains("import-clean"))
    );
}

#[test]
fn rejects_a_library_carrying_commonjs() {
    let libs = HashMap::from([(
        "@example/doc".to_string(),
        r#"const _ = require("lodash"); module.exports = {};"#.to_string(),
    )]);
    let err = create_runtime(host_manifest(), opts(vec![], libs)).unwrap_err();
    assert!(
        matches!(err, XriptError::LibraryRegistration { ref reason, .. } if reason.contains("CommonJS"))
    );
}

#[test]
fn still_denies_dynamic_import_of_an_approved_specifier() {
    let rt = create_runtime(host_manifest(), opts(vec!["lib".into()], doc_libraries())).unwrap();
    let err = rt
        .load_mod(
            mod_manifest(),
            HashMap::new(),
            &HashSet::new(),
            Some(r#"export async function use(){ const m = await import("@example/doc"); return m.NAME; }"#),
        )
        .unwrap_err();
    assert!(matches!(err, XriptError::ImportDenied { ref specifier, .. } if specifier == "@example/doc"));
}

#[test]
fn shares_one_library_instance_across_imports() {
    let libs = HashMap::from([(
        "open-lib".to_string(),
        "export const bag = []; export function push(x){ bag.push(x); return bag.length; }".to_string(),
    )]);
    let rt = create_runtime(host_manifest(), opts(vec![], libs)).unwrap();
    rt.load_mod(
        mod_manifest(),
        HashMap::new(),
        &HashSet::new(),
        Some(r#"import { push } from "open-lib"; export function use(x){ return push(x); }"#),
    )
    .unwrap();
    assert_eq!(rt.invoke_export("use", &[serde_json::json!("a")]).unwrap(), serde_json::json!(1));
    assert_eq!(rt.invoke_export("use", &[serde_json::json!("b")]).unwrap(), serde_json::json!(2));
}
