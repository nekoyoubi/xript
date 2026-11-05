//! Conformance against the shared host events corpus in `spec/`: under
//! `host_events`, a host-declared top-level `events` binding is the `events`
//! mods see, sealed like every other binding, and the built-in bus's host API
//! is refused; without it nothing changes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, Deprecation, HostBindings, HostFn, RuntimeMode, RuntimeOptions, XriptError, XriptRuntime};

const CORPUS: &str = include_str!("../../../spec/host-events-tests.json");

fn answer(prefix: String) -> HostFn {
    Arc::new(move |args: &[Value]| Ok(json!(format!("{prefix}:{}", args.first().and_then(Value::as_str).unwrap_or_default()))))
}

fn host_bindings_for(manifest: &Value) -> HostBindings {
    let mut bindings = HostBindings::new();
    for (name, binding) in manifest["bindings"].as_object().into_iter().flatten() {
        match binding["members"].as_object() {
            Some(members) => {
                let members = members.keys().map(|member| (member.clone(), answer(member.clone()))).collect();
                bindings.add_namespace(name, members);
            }
            None => {
                let prefix = name.clone();
                bindings.add_function(name, move |args: &[Value]| {
                    Ok(json!(format!("{prefix}:{}", args.first().and_then(Value::as_str).unwrap_or_default())))
                });
            }
        }
    }
    bindings
}

fn options_for(manifest: &Value, host_events: bool, mode: RuntimeMode, codes: &Arc<Mutex<Vec<String>>>) -> RuntimeOptions {
    let sink = codes.clone();
    RuntimeOptions {
        host_bindings: host_bindings_for(manifest),
        host_events,
        mode,
        on_deprecation: Some(Arc::new(move |notice: &Deprecation| sink.lock().unwrap().push(notice.code.to_string()))),
        ..Default::default()
    }
}

fn host_call(rt: &XriptRuntime, api: &str, args: &[Value]) -> Result<Value, XriptError> {
    match api {
        "emit" => rt.emit(args[0].as_str().unwrap(), &args[1..]).map(Value::Array),
        "declareEvent" => rt.declare_event(args[0].clone()),
        "cancelOwned" => rt.cancel_owned(args[0].as_str()).map(|n| json!(n)),
        other => panic!("unknown host API {other}"),
    }
}

fn run_case(corpus: &Value, case: &Value, mode: RuntimeMode) -> Result<(), String> {
    let manifest = &corpus["hosts"][case["host"].as_str().unwrap()];
    let host_events = case["hostEvents"].as_bool().unwrap();
    let codes: Arc<Mutex<Vec<String>>> = Arc::default();
    let built = create_runtime_from_value(manifest.clone(), options_for(manifest, host_events, mode, &codes));

    if let Some(expected) = case["error"].as_str() {
        return match built {
            Err(XriptError::HostEvents { message }) if message.contains(expected) => Ok(()),
            Err(other) => Err(format!("wrong error: {other:?}")),
            Ok(_) => Err("construction succeeded".to_string()),
        };
    }

    let rt = built.map_err(|e| format!("runtime: {e}"))?;
    let got = json!(*codes.lock().unwrap());
    if got != case["deprecations"] {
        return Err(format!("deprecations: got {got}"));
    }
    if let Some(tamper) = case["tamper"].as_str() {
        let script = corpus["mod"]["entry"]["script"].as_str().unwrap().to_string();
        let _ = rt.load_mod(&corpus["mod"].to_string(), HashMap::from([(script, tamper.to_string())]), &HashSet::new(), None);
    }
    for step in case["steps"].as_array().unwrap() {
        if let Some(source) = step["execute"].as_str() {
            let value = rt.execute(source).map_err(|e| format!("{step}: {e}"))?.value;
            if value != step["expected"] {
                return Err(format!("{step}: got {value}"));
            }
        } else if let Some(api) = step["host"].as_str() {
            let outcome = host_call(&rt, api, step["args"].as_array().unwrap());
            match (step["throws"].as_str(), outcome) {
                (Some(expected), Err(XriptError::HostEvents { message })) if message.contains(expected) => {}
                (Some(_), other) => return Err(format!("{step}: expected a refusal, got {other:?}")),
                (None, Ok(value)) if value == step["expected"] => {}
                (None, other) => return Err(format!("{step}: got {other:?}")),
            }
        } else {
            return Err(format!("unknown step {step}"));
        }
    }
    Ok(())
}

fn run_corpus(mode: RuntimeMode) {
    let corpus: Value = serde_json::from_str(CORPUS).expect("the host events corpus is well-formed JSON");
    let mut failures = Vec::new();
    for case in corpus["cases"].as_array().unwrap() {
        if let Err(failure) = run_case(&corpus, case, mode) {
            failures.push(format!("{}: {failure}", case["name"].as_str().unwrap()));
        }
    }
    assert!(failures.is_empty(), "{mode:?} host events failures:\n{}", failures.join("\n"));
}

#[test]
fn host_events_corpus() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn host_events_corpus_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}

#[cfg(feature = "threads")]
mod threaded {
    use super::*;
    use xript_runtime::{PoolConfig, XriptHandle, XriptPool};

    fn namespace_host() -> Value {
        let corpus: Value = serde_json::from_str(CORPUS).unwrap();
        corpus["hosts"]["namespace"].clone()
    }

    fn refused<T: std::fmt::Debug>(outcome: Result<T, XriptError>, api: &str) {
        match outcome {
            Err(XriptError::HostEvents { message }) => {
                assert!(message.contains("is not available in host events mode"), "{message}");
                assert!(message.contains(&format!("`{api}`")), "{message}");
            }
            other => panic!("expected a host events refusal for {api}, got {other:?}"),
        }
    }

    #[test]
    fn a_handle_refuses_the_built_in_bus_api() {
        let manifest = namespace_host();
        let codes = Arc::default();
        let (handle, ready) = XriptHandle::spawn(manifest.to_string(), options_for(&manifest, true, RuntimeMode::Sync, &codes));
        ready.wait().unwrap();
        refused(handle.emit("tick", &[]).wait(), "emit");
        refused(handle.emit_tagged("tick", &[]).wait(), "emit");
        refused(handle.cancel_owned(None).wait(), "cancel_owned");
        refused(handle.declare_event(json!({ "id": "later", "description": "Declared at runtime." })).wait(), "declare_event");
        assert_eq!(handle.execute("events.on('tick')").wait().unwrap().value, json!("on:tick"));
    }

    #[test]
    fn a_pool_refuses_the_built_in_bus_api() {
        let manifest = namespace_host();
        let config = PoolConfig { workers: 2, interactive: 1, ..PoolConfig::default() };
        let factory_manifest = manifest.clone();
        let (pool, ready) = XriptPool::spawn(
            manifest.to_string(),
            move |_| options_for(&factory_manifest, true, RuntimeMode::Sync, &Arc::default()),
            config,
        );
        ready.wait().unwrap();
        refused(pool.emit("tick", &[]).wait(), "emit");
        refused(pool.cancel_owned(None).wait(), "cancel_owned");
        refused(pool.declare_event(json!({ "id": "later", "description": "Declared at runtime." })).wait(), "declare_event");
    }

    #[test]
    fn a_pool_refuses_construction_without_an_events_binding() {
        let manifest = json!({ "xript": "0.10", "name": "no-events", "bindings": { "log": { "description": "Logs." } } });
        let factory_manifest = manifest.clone();
        let (_pool, ready) = XriptPool::spawn(
            manifest.to_string(),
            move |_| options_for(&factory_manifest, true, RuntimeMode::Sync, &Arc::default()),
            PoolConfig { workers: 1, interactive: 1, ..PoolConfig::default() },
        );
        assert!(matches!(ready.wait(), Err(XriptError::HostEvents { .. })));
    }
}

#[test]
fn async_emit_is_refused_too() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let manifest = &corpus["hosts"]["namespace"];
    let rt = create_runtime_from_value(manifest.clone(), options_for(manifest, true, RuntimeMode::Async, &Arc::default())).unwrap();
    let outcome = pollster::block_on(rt.emit_async("tick", &[]));
    assert!(matches!(outcome, Err(XriptError::HostEvents { .. })), "{outcome:?}");
    let tagged = rt.emit_tagged("tick", &[]);
    assert!(matches!(tagged, Err(XriptError::HostEvents { .. })), "{tagged:?}");
}
