use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use xript_runtime::{
    create_runtime, looks_like_markup, EntryErrorPolicy, HardLimits, ModDiagnostic, ModManifest,
    RuntimeMode, RuntimeOptions, XriptError,
};

const CORPUS: &str = include_str!("../../../spec/mod-load-tests.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("corpus parses")
}

fn policy(case: &Value) -> EntryErrorPolicy {
    match case.get("entryErrors").and_then(Value::as_str) {
        Some("report") => EntryErrorPolicy::Report,
        _ => EntryErrorPolicy::Throw,
    }
}

fn sources(case: &Value) -> HashMap<String, String> {
    case["sources"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn field_of(diagnostic: &ModDiagnostic, key: &str) -> Option<String> {
    match key {
        "code" => Some(diagnostic.code.as_str().to_string()),
        "severity" => Some(diagnostic.severity.as_str().to_string()),
        "script" => diagnostic.script.clone(),
        "fragmentId" => diagnostic.fragment_id.clone(),
        "field" => diagnostic.field.clone(),
        other => panic!("corpus names an unknown diagnostic field `{other}`"),
    }
}

fn error_matches(code: &str, error: &XriptError) -> bool {
    match code {
        "missing-entry-script" => matches!(error, XriptError::MissingEntryScript { .. }),
        "entry-failed" => matches!(error, XriptError::ModEntry { .. }),
        other => panic!("corpus names an unknown error code `{other}`"),
    }
}

#[test]
fn mod_load_corpus() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn mod_load_corpus_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}

fn run_corpus(mode: RuntimeMode) {
    let corpus = corpus();
    let host = corpus["host"].to_string();
    let mut failures = Vec::new();

    for case in corpus["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or_default();
        let seen: Arc<Mutex<Vec<ModDiagnostic>>> = Arc::default();
        let sink_seen = seen.clone();
        let rt = create_runtime(
            &host,
            RuntimeOptions {
                entry_errors: policy(case),
                mode,
                on_mod_diagnostic: Some(Arc::new(move |d: &ModDiagnostic| {
                    sink_seen.lock().unwrap().push(d.clone())
                })),
                ..Default::default()
            },
        )
        .expect("host loads");
        let mod_json = case["mod"].to_string();
        let mod_name = case["mod"]["name"].as_str().unwrap_or_default();
        let result = rt.load_mod(&mod_json, sources(case), &HashSet::new(), None);

        if let Some(code) = case.get("error").and_then(Value::as_str) {
            match result {
                Ok(_) => failures.push(format!("{name}: expected {code}, loaded")),
                Err(error) => {
                    if !error_matches(code, &error) {
                        failures.push(format!("{name}: expected {code}, got {error:?}"));
                    }
                    let message = error.to_string();
                    for needle in case["mentions"].as_array().into_iter().flatten() {
                        let needle = needle.as_str().unwrap_or_default();
                        if !message.contains(needle) {
                            failures.push(format!("{name}: `{message}` should mention `{needle}`"));
                        }
                    }
                }
            }
            continue;
        }

        let instance = match result {
            Ok(instance) => instance,
            Err(error) => {
                failures.push(format!("{name}: expected a load, got {error:?}"));
                continue;
            }
        };
        let expected = case["diagnostics"].as_array().expect("diagnostics");
        if instance.diagnostics.len() != expected.len() {
            failures.push(format!(
                "{name}: expected {} diagnostics, got {:?}",
                expected.len(),
                instance.diagnostics
            ));
            continue;
        }
        for (index, (want, got)) in expected.iter().zip(&instance.diagnostics).enumerate() {
            if got.mod_name != mod_name {
                failures.push(format!("{name}: diagnostic {index} names mod `{}`", got.mod_name));
            }
            for (key, value) in want.as_object().expect("diagnostic object") {
                let actual = field_of(got, key);
                if actual.as_deref() != value.as_str() {
                    failures.push(format!("{name}: diagnostic {index} `{key}` is {actual:?}, want {value}"));
                }
            }
        }
        if *seen.lock().unwrap() != instance.diagnostics {
            failures.push(format!("{name}: the sink saw a different set than the instance carries"));
        }

        if let Some(check) = case.get("bindingField") {
            let fragment = instance
                .fragments
                .iter()
                .find(|f| f.id == check["fragmentId"].as_str().unwrap_or_default())
                .expect("fragment");
            let binding = fragment
                .declaration
                .bindings
                .as_ref()
                .and_then(|b| b.iter().find(|b| b.name == check["binding"].as_str().unwrap_or_default()))
                .expect("binding");
            let field = check["field"].as_str().unwrap_or_default();
            if binding.extensions.get(field) != Some(&check["value"]) {
                failures.push(format!("{name}: binding field `{field}` was not carried through"));
            }
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn host() -> String {
    corpus()["host"].to_string()
}

#[test]
fn an_explicit_entry_source_stands_for_the_whole_entry() {
    let rt = create_runtime(&host(), RuntimeOptions::default()).unwrap();
    let mod_json = r#"{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": "main.js" }"#;
    let instance = rt
        .load_mod(mod_json, HashMap::new(), &HashSet::new(), Some("var ok = 1;"))
        .unwrap();
    assert!(instance.diagnostics.is_empty());
}

#[test]
fn a_missing_script_stops_every_entry_script_from_running() {
    let rt = create_runtime(
        &host(),
        RuntimeOptions { entry_errors: EntryErrorPolicy::Report, ..Default::default() },
    )
    .unwrap();
    let mod_json = r#"{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": ["a.js", "b.js"] }"#;
    let sources = HashMap::from([("a.js".to_string(), "globalThis.ranA = true;".to_string())]);
    rt.load_mod(mod_json, sources, &HashSet::new(), None).unwrap();
    assert_eq!(rt.execute("typeof globalThis.ranA").unwrap().value, "undefined");
}

#[test]
fn a_report_policy_mod_still_fills_its_slot() {
    let rt = create_runtime(
        &host(),
        RuntimeOptions { entry_errors: EntryErrorPolicy::Report, ..Default::default() },
    )
    .unwrap();
    let mod_json = r#"{
        "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": "main.js",
        "fills": { "panel": [{ "format": "text/html", "source": "<p>still here</p>", "inline": true }] }
    }"#;
    let sources = HashMap::from([("main.js".to_string(), "throw new Error('boom');".to_string())]);
    let instance = rt.load_mod(mod_json, sources, &HashSet::new(), None).unwrap();
    assert_eq!(instance.diagnostics.len(), 1);
    assert_eq!(rt.resolve_slot("panel").len(), 1);
}

#[test]
fn a_panicking_sink_does_not_change_the_outcome() {
    let rt = create_runtime(
        &host(),
        RuntimeOptions {
            on_mod_diagnostic: Some(Arc::new(|_: &ModDiagnostic| panic!("sink broke"))),
            ..Default::default()
        },
    )
    .unwrap();
    let mod_json = r#"{
        "xript": "0.9", "name": "mod-a", "version": "1.0.0",
        "fills": { "panel": [{ "format": "text/html", "source": "<p>x</p>" }] }
    }"#;
    let instance = rt.load_mod(mod_json, HashMap::new(), &HashSet::new(), None).unwrap();
    assert_eq!(instance.diagnostics.len(), 1);
}

#[test]
fn a_throwing_module_entry_under_the_report_policy_is_a_diagnostic() {
    let rt = create_runtime(
        &host(),
        RuntimeOptions { entry_errors: EntryErrorPolicy::Report, ..Default::default() },
    )
    .unwrap();
    let mod_json = r#"{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": { "script": "main.js", "format": "module" } }"#;
    let sources = HashMap::from([(
        "main.js".to_string(),
        "throw new Error('boom'); export function f() {}".to_string(),
    )]);
    let instance = rt.load_mod(mod_json, sources, &HashSet::new(), None).unwrap();
    assert_eq!(instance.diagnostics.len(), 1);
    assert_eq!(instance.diagnostics[0].code.as_str(), "entry-failed");
    assert!(instance.diagnostics[0].message.contains("boom"));
}

#[test]
fn an_entry_script_that_never_ends_is_held_to_the_timeout() {
    let rt = create_runtime(
        &host(),
        RuntimeOptions {
            hard_limits: Some(HardLimits { timeout_ms: Some(50), ..Default::default() }),
            ..Default::default()
        },
    )
    .unwrap();
    let mod_json = r#"{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": "main.js" }"#;
    let sources = HashMap::from([("main.js".to_string(), "while (true) {}".to_string())]);
    let error = rt.load_mod(mod_json, sources, &HashSet::new(), None).unwrap_err();
    assert!(matches!(error, XriptError::ExecutionLimit { .. }), "got {error:?}");
}

#[test]
fn entries_that_never_end_are_held_to_the_timeout_in_async_mode() {
    let rt = create_runtime(
        &host(),
        RuntimeOptions {
            hard_limits: Some(HardLimits { timeout_ms: Some(50), ..Default::default() }),
            mode: RuntimeMode::Async,
            ..Default::default()
        },
    )
    .unwrap();
    let classic = r#"{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": "main.js" }"#;
    let sources = HashMap::from([("main.js".to_string(), "while (true) {}".to_string())]);
    let error = rt.load_mod(classic, sources, &HashSet::new(), None).unwrap_err();
    assert!(matches!(error, XriptError::ExecutionLimit { .. }), "got {error:?}");

    let module = r#"{ "xript": "0.9", "name": "mod-b", "version": "1.0.0", "entry": { "script": "main.js", "format": "module" } }"#;
    let sources = HashMap::from([(
        "main.js".to_string(),
        "await new Promise(() => {}); export function f() {}".to_string(),
    )]);
    let error = rt.load_mod(module, sources, &HashSet::new(), None).unwrap_err();
    assert!(matches!(error, XriptError::ExecutionLimit { .. }), "got {error:?}");
}

#[test]
fn entry_rule_helpers_read_every_form() {
    let parse = |entry: &str| -> ModManifest {
        serde_json::from_str(&format!(
            r#"{{ "xript": "0.9", "name": "m", "version": "1.0.0", "entry": {entry} }}"#
        ))
        .unwrap()
    };
    assert_eq!(parse(r#""main.js""#).entry_scripts(), vec!["main.js"]);
    assert_eq!(parse(r#"["a.js", "b.js"]"#).entry_scripts(), vec!["a.js", "b.js"]);
    assert_eq!(parse(r#"{ "script": "m.js", "format": "module" }"#).entry_scripts(), vec!["m.js"]);
    assert_eq!(parse(r#""main.js""#).entry_format(), "script");
    assert_eq!(parse(r#"{ "script": "m.js", "format": "module" }"#).entry_format(), "module");
    assert!(parse(r#""main.js""#).entry_exports().is_empty());
    let exports = parse(r#"{ "script": "m.js", "exports": { "go": { "capability": "x" } } }"#).entry_exports();
    assert_eq!(exports["go"].capability.as_deref(), Some("x"));
}

#[test]
fn looks_like_markup_separates_content_from_file_names() {
    assert!(looks_like_markup("<p>x</p>"));
    assert!(looks_like_markup("  [\"p\", {}]"));
    assert!(!looks_like_markup("panel.html"));
    assert!(!looks_like_markup("[not json"));
}
