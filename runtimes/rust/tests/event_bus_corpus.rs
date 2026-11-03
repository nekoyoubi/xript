use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use xript_runtime::{
    create_runtime_from_value, HostBindings, HostCallInfo, HostNamespaceMember, RuntimeMode, RuntimeOptions,
    XriptRuntime,
};

const CORPUS: &str = include_str!("../../../spec/event-bus-tests.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("corpus parses")
}

fn report(info: &HostCallInfo, args: &[Value]) -> Result<Value, String> {
    Ok(json!({ "modId": info.mod_id, "binding": info.binding, "args": args }))
}

fn caller_bindings(case: &Value) -> HostBindings {
    let mut bindings = HostBindings::new();
    let mut namespaces: HashMap<String, HashMap<String, HostNamespaceMember>> = HashMap::new();
    for name in case["callerBindings"].as_array().into_iter().flatten() {
        let name = name.as_str().expect("binding name");
        match name.split_once('.') {
            None => bindings.add_function_with_caller(name, report),
            Some((namespace, member)) => {
                namespaces.entry(namespace.to_string()).or_default().insert(
                    member.to_string(),
                    HostNamespaceMember::CallerFunction(std::sync::Arc::new(report)),
                );
            }
        }
    }
    for (namespace, members) in namespaces {
        bindings.add_nested_namespace(namespace, members);
    }
    bindings
}

fn grants(case: &Value) -> Vec<String> {
    case["grants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g.as_str().map(str::to_string))
        .collect()
}

fn runtime_for(corpus: &Value, case: &Value, mode: RuntimeMode) -> XriptRuntime {
    let mut manifest = corpus["base"].clone();
    for (key, value) in case["host"].as_object().into_iter().flatten() {
        manifest[key] = value.clone();
    }
    create_runtime_from_value(
        manifest,
        RuntimeOptions {
            host_bindings: caller_bindings(case),
            capabilities: grants(case),
            mode,
            ..Default::default()
        },
    )
    .expect("host manifest loads")
}

fn run_case(corpus: &Value, case: &Value, mode: RuntimeMode) -> Vec<String> {
    let name = case["name"].as_str().unwrap_or_default();
    let rt = runtime_for(corpus, case, mode);
    let mut failures = Vec::new();

    rt.execute(corpus["prelude"].as_str().unwrap()).expect("prelude runs");
    rt.execute(case["script"].as_str().unwrap()).expect("script runs");
    let granted: HashSet<String> = grants(case).into_iter().collect();
    for module in case["mods"].as_array().into_iter().flatten() {
        let mod_name = module["name"].as_str().unwrap();
        let manifest = json!({ "xript": "0.10", "name": mod_name, "version": "1.0.0", "entry": "main.js" });
        let source = format!(
            "{}{}",
            corpus["trampoline"].as_str().unwrap(),
            module["source"].as_str().unwrap_or_default()
        );
        let sources = HashMap::from([("main.js".to_string(), source)]);
        rt.load_mod(&manifest.to_string(), sources, &granted, None)
            .unwrap_or_else(|e| panic!("{name}: loading {mod_name} failed: {e}"));
    }

    for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        let label = format!("{name} / step {index}: {step}");
        if let Some(function) = step.get("call").and_then(Value::as_str) {
            let args = step.get("args").cloned().unwrap_or_else(|| json!([]));
            let actual = match step["as"].as_str() {
                None => rt.execute(&format!("{function}.apply(null, {args})")).map(|r| r.value),
                Some(mod_name) => rt.invoke_mod_export(mod_name, "call", &[json!(function), args]),
            };
            match actual {
                Ok(value) if value == step["expect"] => {}
                Ok(value) => failures.push(format!("{label}\n  got {value}")),
                Err(error) => failures.push(format!("{label}\n  failed: {error}")),
            }
        } else if let Some(event) = step.get("emit").and_then(Value::as_str) {
            let payload: Vec<Value> = step.get("payload").cloned().into_iter().collect();
            match rt.emit(event, &payload) {
                Ok(values) if Value::Array(values.clone()) == step["expect"] => {}
                Ok(values) => failures.push(format!("{label}\n  got {}", Value::Array(values))),
                Err(error) => failures.push(format!("{label}\n  failed: {error}")),
            }
        } else if let Some(owner) = step.get("cancelOwned") {
            match rt.cancel_owned(owner.as_str()) {
                Ok(count) if json!(count) == step["expect"] => {}
                Ok(count) => failures.push(format!("{label}\n  got {count}")),
                Err(error) => failures.push(format!("{label}\n  failed: {error}")),
            }
        } else if let Some(entry) = step.get("declare") {
            let result = rt.declare_event(entry.clone());
            if step["throws"].as_bool() == Some(true) {
                if let Ok(value) = result {
                    failures.push(format!("{label}\n  expected a refusal, got {value}"));
                }
            } else {
                match result {
                    Ok(value) if value == step["expect"] => {}
                    Ok(value) => failures.push(format!("{label}\n  got {value}")),
                    Err(error) => failures.push(format!("{label}\n  failed: {error}")),
                }
            }
        } else {
            failures.push(format!("{label}\n  unknown step kind"));
        }
    }
    failures
}

fn run_corpus(mode: RuntimeMode) {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    let failures: Vec<String> = cases.iter().flat_map(|case| run_case(&corpus, case, mode)).collect();
    assert!(failures.is_empty(), "{} failing step(s):\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn event_bus_corpus() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn event_bus_corpus_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}

#[test]
fn an_events_binding_survives_when_no_events_are_declared() {
    let mut bindings = HostBindings::new();
    bindings.add_function("events", |_| Ok(json!("host binding")));
    let rt = create_runtime_from_value(
        json!({ "xript": "0.10", "name": "probe", "bindings": { "events": { "description": "A host binding." } } }),
        RuntimeOptions {
            host_bindings: bindings,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rt.execute("events()").unwrap().value, json!("host binding"));
}
