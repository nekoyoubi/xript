//! Conformance against the shared isolation corpus in `spec/`: a second mod's
//! tampering leaves the first mod's handlers, exports, bindings and console
//! exactly as they were, in both runtime modes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, ConsoleHandler, DebugOptions, HostBindings, HostFn, RuntimeMode, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/isolation-tests.json");

type Lines = Arc<Mutex<Vec<String>>>;

fn host_bindings() -> HostBindings {
    let mut bindings = HostBindings::new();
    bindings.add_function("log", |args: &[Value]| Ok(json!(format!("log:{}", args[0].as_str().unwrap_or_default()))));
    let get: HostFn = Arc::new(|args: &[Value]| Ok(json!(format!("get:{}", args[0].as_str().unwrap_or_default()))));
    bindings.add_namespace("ns", HashMap::from([("get".to_string(), get)]));
    bindings
}

fn recording(lines: &Lines) -> ConsoleHandler {
    let sink = lines.clone();
    ConsoleHandler {
        on: Some(Box::new(move |_severity, message| sink.lock().unwrap().push(message.to_string()))),
        ..ConsoleHandler::default()
    }
}

fn run_case(corpus: &Value, case: &Value, mode: RuntimeMode, debug: bool) -> Result<(), String> {
    let lines: Lines = Arc::default();
    let rt = create_runtime_from_value(
        corpus["host"].clone(),
        RuntimeOptions {
            host_bindings: host_bindings(),
            console: recording(&lines),
            mode,
            debug: debug.then(DebugOptions::default),
            ..Default::default()
        },
    )
    .map_err(|e| format!("runtime: {e}"))?;
    let a = &corpus["a"];
    let a_script = a["manifest"]["entry"]["script"].as_str().unwrap().to_string();
    rt.load_mod(
        &a["manifest"].to_string(),
        HashMap::from([(a_script, a["source"].as_str().unwrap().to_string())]),
        &HashSet::new(),
        None,
    )
    .map_err(|e| format!("load a: {e}"))?;
    let read = |source: &Value| rt.execute(source.as_str().unwrap()).map(|r| r.value).map_err(|e| format!("{e}"));
    let probes = if debug { Some(read(&corpus["debugCase"]["probes"])?) } else { None };
    if !debug {
        let internals = read(&corpus["internals"])?;
        if internals != json!([]) {
            return Err(format!("internals visible to scripts: {internals}"));
        }
    }
    let b_script = corpus["b"]["entry"]["script"].as_str().unwrap().to_string();
    let _ = rt.load_mod(
        &corpus["b"].to_string(),
        HashMap::from([(b_script, case["tamper"].as_str().unwrap().to_string())]),
        &HashSet::new(),
        None,
    );
    rt.invoke_mod_export("a", "setup", &[]).map_err(|e| format!("setup: {e}"))?;
    lines.lock().unwrap().clear();
    for step in corpus["steps"].as_array().unwrap() {
        if let Some(hook) = step["fire"].as_str() {
            let results = match step["phase"].as_str() {
                Some(phase) => rt.fire_hook_phase(hook, phase, Some(&step["data"])),
                None => rt.fire_hook(hook, &[step["data"].clone()]),
            }
            .map_err(|e| format!("{step}: {e}"))?;
            if Value::Array(results.clone()) != step["expected"] {
                return Err(format!("{step}: got {results:?}"));
            }
        } else if let Some(fragment) = step["fragment"].as_str() {
            let ops = rt
                .fire_fragment_hook(fragment, step["lifecycle"].as_str().unwrap(), None)
                .map_err(|e| format!("{step}: {e}"))?;
            if Some(ops.len() as u64) != step["ops"].as_u64() {
                return Err(format!("{step}: got {} ops", ops.len()));
            }
        } else if let Some(export) = step["invoke"].as_str() {
            let value = rt
                .invoke_mod_export(step["mod"].as_str().unwrap(), export, &[])
                .map_err(|e| format!("{step}: {e}"))?;
            if let Some(expected) = step.get("logs") {
                let got = lines.lock().unwrap().clone();
                if json!(got) != *expected {
                    return Err(format!("{step}: got logs {got:?}"));
                }
            } else if value != step["expected"] {
                return Err(format!("{step}: got {value}"));
            }
        } else if let Some(event) = step["emit"].as_str() {
            let results = rt.emit(event, &[step["payload"].clone()]).map_err(|e| format!("{step}: {e}"))?;
            if Value::Array(results.clone()) != step["expected"] {
                return Err(format!("{step}: got {results:?}"));
            }
        } else if let Some(source) = step["execute"].as_str() {
            let value = rt.execute(source).map_err(|e| format!("{step}: {e}"))?.value;
            if value != step["expected"] {
                return Err(format!("{step}: got {value}"));
            }
        } else {
            return Err(format!("unknown step {step}"));
        }
    }
    if let Some(before) = probes {
        if before.as_array().is_none_or(Vec::is_empty) {
            return Err("a debug session installs probes".to_string());
        }
        let after = read(&corpus["debugCase"]["probes"])?;
        if after != before {
            return Err(format!("a probe was deleted: {before} became {after}"));
        }
        let open = read(&corpus["debugCase"]["locked"])?;
        if open != json!([]) {
            return Err(format!("probes left writable or configurable: {open}"));
        }
    }
    Ok(())
}

fn run_corpus(mode: RuntimeMode) {
    let corpus: Value = serde_json::from_str(CORPUS).expect("the isolation corpus is well-formed JSON");
    let mut failures = Vec::new();
    for case in corpus["cases"].as_array().unwrap() {
        if let Err(failure) = run_case(&corpus, case, mode, false) {
            failures.push(format!("{}: {failure}", case["name"].as_str().unwrap()));
        }
    }
    if let Err(failure) = run_case(&corpus, &corpus["debugCase"], mode, true) {
        failures.push(format!("{}: {failure}", corpus["debugCase"]["name"].as_str().unwrap()));
    }
    assert!(failures.is_empty(), "{mode:?} isolation failures:\n{}", failures.join("\n"));
}

#[test]
fn a_second_mod_cannot_tamper_with_the_first() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn a_second_mod_cannot_tamper_with_the_first_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}
