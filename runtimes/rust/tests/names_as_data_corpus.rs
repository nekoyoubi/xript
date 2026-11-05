//! Conformance against the shared names-as-data corpus in `spec/`: every case
//! runs once per awkward name, in both runtime modes.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use xript_runtime::{create_runtime_from_value, HostBindings, HostFn, RuntimeMode, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/names-as-data-tests.json");
const TOKEN: &str = "$NAME";

fn place_data(value: &Value, name: &str) -> Value {
    match value {
        Value::String(text) if text == TOKEN => Value::String(name.to_string()),
        Value::Array(items) => Value::Array(items.iter().map(|item| place_data(item, name)).collect()),
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, item)| (if key == TOKEN { name.to_string() } else { key.clone() }, place_data(item, name)))
                .collect::<Map<String, Value>>(),
        ),
        other => other.clone(),
    }
}

fn place_source(source: &str, name: &str) -> String {
    source.replace(TOKEN, &serde_json::to_string(name).unwrap())
}

fn host_bindings(provide: &Value) -> HostBindings {
    let ok: HostFn = Arc::new(|_args: &[Value]| Ok(json!("ok")));
    let mut bindings = HostBindings::new();
    let mut namespaces: HashMap<String, HashMap<String, HostFn>> = HashMap::new();
    for path in provide.as_array().into_iter().flatten() {
        let segments: Vec<&str> = path.as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        match segments.as_slice() {
            [name] => {
                let ok = ok.clone();
                bindings.add_function(*name, move |args: &[Value]| ok(args));
            }
            [namespace, member] => {
                namespaces.entry(namespace.to_string()).or_default().insert(member.to_string(), ok.clone());
            }
            other => panic!("the runner provides paths of one or two segments, not {other:?}"),
        }
    }
    for (namespace, members) in namespaces {
        bindings.add_namespace(namespace, members);
    }
    bindings
}

fn run_case(case: &Value, name: &str, mode: RuntimeMode) -> Result<(), String> {
    let rt = create_runtime_from_value(
        place_data(&case["manifest"], name),
        RuntimeOptions {
            host_bindings: host_bindings(&place_data(&case["provide"], name)),
            mode,
            ..Default::default()
        },
    )
    .map_err(|e| format!("runtime: {e}"))?;
    if let Some(filler) = case.get("mod") {
        let manifest = place_data(&filler["manifest"], name);
        let script = manifest["entry"]["script"].as_str().unwrap().to_string();
        let sources = HashMap::from([(script, place_source(filler["source"].as_str().unwrap(), name))]);
        rt.load_mod(&manifest.to_string(), sources, &HashSet::new(), None)
            .map_err(|e| format!("load_mod: {e}"))?;
    }
    if let Some(setup) = case["setup"].as_str() {
        rt.execute(&place_source(setup, name)).map_err(|e| format!("setup: {e}"))?;
    }
    for raw in case["steps"].as_array().unwrap() {
        let step = place_data(raw, name);
        if let Some(source) = raw["execute"].as_str() {
            let value = rt.execute(&place_source(source, name)).map_err(|e| format!("execute: {e}"))?.value;
            if let Some(parts) = step["includes"].as_array() {
                let text = value.as_str().ok_or_else(|| format!("expected a message, got {value}"))?;
                for part in parts {
                    let part = part.as_str().unwrap();
                    if !text.contains(part) {
                        return Err(format!("{text:?} lacks {part:?}"));
                    }
                }
            } else if value != step["expected"] {
                return Err(format!("execute: expected {}, got {value}", step["expected"]));
            }
        } else if let Some(hook) = step["fire"].as_str() {
            let results = match step["phase"].as_str() {
                Some(phase) => rt.fire_hook_phase(hook, phase, Some(&step["data"])),
                None => rt.fire_hook(hook, &[step["data"].clone()]),
            }
            .map_err(|e| format!("fire: {e}"))?;
            if Value::Array(results.clone()) != step["expected"] {
                return Err(format!("fire: expected {}, got {results:?}", step["expected"]));
            }
        } else if let Some(fragment) = step["fragment"].as_str() {
            let ops = rt
                .fire_fragment_hook(fragment, step["lifecycle"].as_str().unwrap(), None)
                .map_err(|e| format!("fragment: {e}"))?;
            if Some(ops.len() as u64) != step["ops"].as_u64() {
                return Err(format!("fragment: expected {} ops, got {}", step["ops"], ops.len()));
            }
        } else if let Some(export) = step["invoke"].as_str() {
            let value = match step["mod"].as_str() {
                Some(owner) => rt.invoke_mod_export(owner, export, &[]),
                None => rt.invoke_export(export, &[]),
            }
            .map_err(|e| format!("invoke: {e}"))?;
            if value != step["expected"] {
                return Err(format!("invoke: expected {}, got {value}", step["expected"]));
            }
        } else {
            return Err(format!("unknown step {step}"));
        }
    }
    let ran = rt.execute("typeof globalThis.ran").map_err(|e| format!("sentinel: {e}"))?.value;
    if ran != json!("undefined") {
        return Err("a name ran as script".to_string());
    }
    Ok(())
}

fn run_corpus(mode: RuntimeMode) {
    let corpus: Value = serde_json::from_str(CORPUS).expect("the names-as-data corpus is well-formed JSON");
    let names = corpus["names"].as_array().unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(!names.is_empty() && !cases.is_empty());
    let mut failures = Vec::new();
    for case in cases {
        for entry in names {
            let name = entry["value"].as_str().unwrap();
            if let Err(failure) = run_case(case, name, mode) {
                failures.push(format!("{}: {}: {failure}", case["name"].as_str().unwrap(), entry["label"].as_str().unwrap()));
            }
        }
    }
    assert!(failures.is_empty(), "{mode:?} names-as-data failures:\n{}", failures.join("\n"));
}

#[test]
fn every_name_reaches_the_sandbox_as_data() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn every_name_reaches_the_sandbox_as_data_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}
