//! Script functions crossing into host bindings, checked against the shared
//! callback corpus every runtime answers to.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use xript_runtime::{
    create_runtime_from_value, Callback, CallbackError, HostBindings, HostFn, RuntimeMode, RuntimeOptions,
    XriptError,
};

const CORPUS: &str = include_str!("../../../spec/callback-tests.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("the callback corpus is well-formed JSON")
}

fn resolve<'a>(payload: &'a [Value], path: &[Value]) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    let mut current = payload.get(first.as_u64()? as usize)?;
    for step in rest {
        current = match step {
            Value::String(key) => current.as_object()?.get(key)?,
            Value::Number(n) => current.as_array()?.get(n.as_u64()? as usize)?,
            _ => return None,
        };
    }
    Some(current)
}

fn callback_at(args: &[Value]) -> Result<(Callback, Vec<Value>), String> {
    let path = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let call_args = args.get(1).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let payload = &args[2.min(args.len())..];
    let target = resolve(payload, &path).ok_or("nothing at path")?;
    let callback = Callback::from_value(target).ok_or("not a callback")?;
    Ok((callback, call_args))
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[derive(Default)]
struct ProbeState {
    typed_calls: usize,
    stashed: Option<Callback>,
}

fn probe(state: Arc<Mutex<ProbeState>>) -> HostBindings {
    let mut members: HashMap<String, HostFn> = HashMap::new();
    members.insert(
        "call".into(),
        Arc::new(|args: &[Value]| {
            let (callback, call_args) = callback_at(args)?;
            Ok(callback.call(&call_args)?)
        }),
    );
    members.insert(
        "catchCall".into(),
        Arc::new(|args: &[Value]| {
            let (callback, call_args) = callback_at(args)?;
            Ok(match callback.call(&call_args) {
                Ok(value) => json!({ "kind": "returned", "value": value }),
                Err(CallbackError::Threw { message, .. }) => json!({ "kind": "threw", "message": message }),
                Err(other) => json!({ "kind": other.reason() }),
            })
        }),
    );
    members.insert(
        "kind".into(),
        Arc::new(|args: &[Value]| {
            let path = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let payload = &args[1.min(args.len())..];
            Ok(json!(match resolve(payload, &path) {
                None => "missing",
                Some(value) if Callback::from_value(value).is_some() => "callback",
                Some(value) => json_kind(value),
            }))
        }),
    );
    let stash_state = state.clone();
    members.insert(
        "stash".into(),
        Arc::new(move |args: &[Value]| {
            let path = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let payload = &args[1.min(args.len())..];
            let callback = resolve(payload, &path).and_then(Callback::from_value);
            stash_state.lock().unwrap().stashed = callback;
            Ok(Value::Null)
        }),
    );
    for name in ["typed", "typedSignature"] {
        let typed_state = state.clone();
        members.insert(
            name.into(),
            Arc::new(move |_args: &[Value]| {
                typed_state.lock().unwrap().typed_calls += 1;
                Ok(json!("called"))
            }),
        );
    }
    let optional_state = state.clone();
    members.insert(
        "typedOptional".into(),
        Arc::new(move |args: &[Value]| {
            optional_state.lock().unwrap().typed_calls += 1;
            let given = args.first().and_then(Callback::from_value).is_some();
            Ok(json!(if given { "called" } else { "absent" }))
        }),
    );
    let mut bindings = HostBindings::new();
    bindings.add_namespace("probe", members);
    bindings
}

/// QuickJS hands back arithmetic results as floats, so `8` can arrive as
/// `8.0`; the corpus compares values, not number representations.
fn numeric(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64()),
        Value::Array(items) => Value::Array(items.iter().map(numeric).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), numeric(v))).collect()),
        other => other.clone(),
    }
}

fn manifest_for(corpus: &Value, entry: &Value) -> Value {
    let mut manifest = corpus["manifest"].clone();
    if let Some(timeout) = entry.get("timeoutMs") {
        manifest["limits"] = json!({ "timeout_ms": timeout });
    }
    manifest
}

#[test]
fn every_corpus_case_holds() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn every_corpus_case_holds_in_async_mode() {
    run_corpus(RuntimeMode::Async);
}

fn run_corpus(mode: RuntimeMode) {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());

    for entry in cases {
        let name = entry["name"].as_str().unwrap();
        let script = entry["script"].as_str().unwrap();
        let expect = &entry["expect"];
        let state = Arc::new(Mutex::new(ProbeState::default()));
        let runtime = create_runtime_from_value(
            manifest_for(&corpus, entry),
            RuntimeOptions {
                host_bindings: probe(state.clone()),
                mode,
                ..Default::default()
            },
        )
        .unwrap_or_else(|e| panic!("{name}: runtime: {e}"));

        let outcome = runtime.execute(script);
        if expect.get("limit").is_some() {
            assert!(
                matches!(outcome, Err(XriptError::ExecutionLimit { .. })),
                "{name}: expected an execution limit, got {outcome:?}"
            );
            continue;
        }
        if let Some(parts) = expect.get("error").and_then(|v| v.as_array()) {
            let message = match outcome {
                Err(e) => e.to_string(),
                Ok(v) => panic!("{name}: expected an error, got {:?}", v.value),
            };
            for part in parts {
                let part = part.as_str().unwrap();
                assert!(message.contains(part), "{name}: {message:?} lacks {part:?}");
            }
        } else {
            let value = outcome.unwrap_or_else(|e| panic!("{name}: {e}")).value;
            assert_eq!(numeric(&value), numeric(&expect["result"]), "{name}");
        }
        if let Some(calls) = expect.get("typedCalls").and_then(|v| v.as_u64()) {
            assert_eq!(state.lock().unwrap().typed_calls as u64, calls, "{name}: typed calls");
        }
        if expect.get("expiredAfter").is_some() {
            let stashed = state.lock().unwrap().stashed.clone().expect("a stashed callback");
            match stashed.call(&[]) {
                Err(e @ CallbackError::Expired { .. }) => {
                    assert!(e.to_string().contains("probe.stash"), "{name}: {e}");
                }
                other => panic!("{name}: expected expired, got {other:?}"),
            }
        }
    }
}

fn async_manifest() -> Value {
    json!({
        "xript": "0.8",
        "name": "async-callbacks",
        "bindings": {
            "find": { "description": "Tests cells with a predicate.", "async": true },
            "other": { "description": "Any async binding.", "async": true }
        }
    })
}

#[test]
fn a_callback_stays_valid_while_an_async_binding_settles() {
    callback_valid_until_settled(RuntimeMode::Sync);
}

#[test]
fn a_callback_stays_valid_across_a_yielding_async_binding() {
    callback_valid_until_settled(RuntimeMode::Async);
}

fn callback_valid_until_settled(mode: RuntimeMode) {
    let kept: Arc<Mutex<Option<Callback>>> = Arc::new(Mutex::new(None));
    let kept_in = kept.clone();
    let mut bindings = HostBindings::new();
    bindings.add_async_function("other", |_args| async { Ok(json!(1)) });
    bindings.add_async_function("find", move |args| {
        let callback = args.first().and_then(Callback::from_value);
        *kept_in.lock().unwrap() = callback.clone();
        async move {
            let callback = callback.ok_or("no callback")?;
            let before = callback.call(&[json!(1)])?;
            let after = callback.call(&[json!(2)])?;
            Ok(json!([before, after]))
        }
    });
    let runtime = create_runtime_from_value(
        async_manifest(),
        RuntimeOptions {
            host_bindings: bindings,
            mode,
            ..Default::default()
        },
    )
    .unwrap();
    let result = runtime
        .execute("(async () => await find((n) => n * 10))()")
        .unwrap();
    assert_eq!(result.value, json!([10, 20]));
    let kept = kept.lock().unwrap().clone().unwrap();
    assert_eq!(kept.call(&[]).unwrap_err().reason(), "expired");
}

#[test]
fn an_async_binding_refuses_to_start_inside_a_callback() {
    async_refused_inside_callback(RuntimeMode::Sync);
}

#[test]
fn a_yielding_async_binding_refuses_to_start_inside_a_callback() {
    async_refused_inside_callback(RuntimeMode::Async);
}

fn async_refused_inside_callback(mode: RuntimeMode) {
    let mut bindings = HostBindings::new();
    bindings.add_async_function("other", |_args| async { Ok(json!(1)) });
    bindings.add_async_function("find", |args| {
        let callback = args.first().and_then(Callback::from_value);
        async move { Ok(callback.ok_or("no callback")?.call(&[json!(1)])?) }
    });
    let runtime = create_runtime_from_value(
        async_manifest(),
        RuntimeOptions {
            host_bindings: bindings,
            mode,
            ..Default::default()
        },
    )
    .unwrap();
    let result = runtime
        .execute(
            "(async () => { try { await find(() => other()); return 'no throw'; } catch (e) { return e.message; } })()",
        )
        .unwrap();
    let message = result.value.as_str().unwrap().to_string();
    assert!(
        message.contains("other(): cannot be called from inside a callback"),
        "{message}"
    );
}

#[test]
fn a_callback_is_unusable_from_another_thread() {
    let kept: Arc<Mutex<Option<Callback>>> = Arc::new(Mutex::new(None));
    let kept_in = kept.clone();
    let mut bindings = HostBindings::new();
    bindings.add_function("take", move |args| {
        let callback = args.first().and_then(Callback::from_value).ok_or("no callback")?;
        let elsewhere = std::thread::spawn({
            let callback = callback.clone();
            move || callback.call(&[]).unwrap_err().reason()
        })
        .join()
        .unwrap();
        *kept_in.lock().unwrap() = Some(callback);
        Ok(json!(elsewhere))
    });
    let runtime = create_runtime_from_value(
        json!({ "xript": "0.8", "name": "t", "bindings": { "take": { "description": "d" } } }),
        RuntimeOptions {
            host_bindings: bindings,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(runtime.execute("take(() => 1)").unwrap().value, json!("expired"));
}

#[test]
fn a_marker_the_script_forges_without_a_function_is_plain_data() {
    let mut bindings = HostBindings::new();
    bindings.add_function("kind", |args| {
        Ok(json!(args.first().and_then(Callback::from_value).is_some()))
    });
    let runtime = create_runtime_from_value(
        json!({ "xript": "0.8", "name": "t", "bindings": { "kind": { "description": "d" } } }),
        RuntimeOptions {
            host_bindings: bindings,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        runtime.execute("kind({ '$xriptCallback': 0 })").unwrap().value,
        json!(false)
    );
}
