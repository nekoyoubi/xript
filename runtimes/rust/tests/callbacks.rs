//! Script functions crossing into host bindings, checked against the shared
//! callback corpus every runtime answers to.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use xript_runtime::{
    create_runtime_from_value, Callback, CallbackError, HostBindings, HostFn, RetainedCallback, RuntimeMode,
    RuntimeOptions, XriptError, XriptRuntime,
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
    kept: Vec<RetainedCallback>,
}

type Shared = Arc<Mutex<ProbeState>>;

/// Records a retained callback, reusing the index of one already kept: the
/// same retained callback is never listed twice.
fn record(state: &Shared, retained: RetainedCallback) -> usize {
    let mut state = state.lock().unwrap();
    if let Some(index) = state.kept.iter().position(|k| *k == retained) {
        return index;
    }
    state.kept.push(retained);
    state.kept.len() - 1
}

fn kept(state: &Shared, index: &Value) -> Result<RetainedCallback, String> {
    let index = index.as_u64().ok_or("index must be a number")? as usize;
    state.lock().unwrap().kept.get(index).cloned().ok_or_else(|| "nothing kept at index".to_string())
}

fn retain_caught(state: &Shared, value: Option<&Value>) -> Result<Value, String> {
    let callback = value.and_then(Callback::from_value).ok_or("not a callback")?;
    Ok(match callback.retain() {
        Ok(retained) => json!(record(state, retained)),
        Err(error) => json!({ "kind": error.reason() }),
    })
}

fn retain_thrown(state: &Shared, value: Option<&Value>) -> Result<Value, String> {
    let callback = value.and_then(Callback::from_value).ok_or("not a callback")?;
    Ok(json!(record(state, callback.retain()?)))
}

fn caught(outcome: Result<Value, CallbackError>) -> Value {
    match outcome {
        Ok(value) => json!({ "kind": "returned", "value": value }),
        Err(CallbackError::Threw { message, .. }) => json!({ "kind": "threw", "message": message }),
        Err(other) => json!({ "kind": other.reason() }),
    }
}

fn probe(state: Shared) -> HostBindings {
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
            Ok(caught(callback.call(&call_args)))
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
    members.insert(
        "handBack".into(),
        Arc::new(|args: &[Value]| {
            let path = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let nested = args.get(1).and_then(|v| v.as_bool()).unwrap_or(false);
            let payload = &args[2.min(args.len())..];
            let callback = resolve(payload, &path).and_then(Callback::from_value).ok_or("not a callback")?;
            Ok(if nested { json!({ "inner": [callback.to_value()] }) } else { callback.to_value() })
        }),
    );
    members.insert(
        "callWithSelf".into(),
        Arc::new(|args: &[Value]| {
            let path = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let payload = &args[1.min(args.len())..];
            let callback = resolve(payload, &path).and_then(Callback::from_value).ok_or("not a callback")?;
            Ok(callback.call(&[callback.to_value(), json!({ "inner": [callback.to_value()] })])?)
        }),
    );
    let s = state.clone();
    members.insert(
        "callStashing".into(),
        Arc::new(move |args: &[Value]| {
            let path = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let payload = &args[1.min(args.len())..];
            let callback = resolve(payload, &path).and_then(Callback::from_value).ok_or("not a callback")?;
            s.lock().unwrap().stashed = Some(callback.clone());
            Ok(callback.call(&[])?)
        }),
    );
    let s = state.clone();
    members.insert(
        "handStashed".into(),
        Arc::new(move |_args: &[Value]| {
            Ok(s.lock().unwrap().stashed.as_ref().map(Callback::to_value).unwrap_or(Value::Null))
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
    for name in ["typedOptional", "typedOptionalFlag"] {
        let optional_state = state.clone();
        members.insert(
            name.into(),
            Arc::new(move |args: &[Value]| {
                optional_state.lock().unwrap().typed_calls += 1;
                let given = args.first().and_then(Callback::from_value).is_some();
                Ok(json!(if given { "called" } else { "absent" }))
            }),
        );
    }

    let s = state.clone();
    members.insert("keep".into(), Arc::new(move |args: &[Value]| retain_caught(&s, args.first())));
    let s = state.clone();
    members.insert(
        "retainField".into(),
        Arc::new(move |args: &[Value]| {
            let field = args.get(1).and_then(|v| v.as_str()).ok_or("field must be a string")?;
            retain_caught(&s, args.first().and_then(|o| o.get(field)))
        }),
    );
    let s = state.clone();
    members.insert(
        "keepAll".into(),
        Arc::new(move |args: &[Value]| {
            let list = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let indices = list
                .iter()
                .map(|item| retain_thrown(&s, item.get("onDone")))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!(indices))
        }),
    );
    let s = state.clone();
    members.insert(
        "keepEach".into(),
        Arc::new(move |args: &[Value]| {
            let indices = args.iter().map(|arg| retain_thrown(&s, Some(arg))).collect::<Result<Vec<_>, _>>()?;
            Ok(json!(indices))
        }),
    );
    let s = state.clone();
    members.insert(
        "tryRetain".into(),
        Arc::new(move |args: &[Value]| {
            let path = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let payload = &args[1.min(args.len())..];
            retain_caught(&s, resolve(payload, &path))
        }),
    );
    let s = state.clone();
    members.insert(
        "retainTreeAt".into(),
        Arc::new(move |args: &[Value]| {
            let mut path = vec![json!(0)];
            path.extend(args.get(1).and_then(|v| v.as_array()).cloned().unwrap_or_default());
            retain_caught(&s, resolve(&args[..1.min(args.len())], &path))
        }),
    );
    let s = state.clone();
    members.insert(
        "node".into(),
        Arc::new(move |args: &[Value]| {
            let callback = args.first().and_then(Callback::from_value).ok_or("not a callback")?;
            let retained = callback.retain()?;
            let marker = retained.to_value();
            record(&s, retained);
            Ok(json!({ "kind": "action", "fn": marker }))
        }),
    );
    let s = state.clone();
    members.insert(
        "runKept".into(),
        Arc::new(move |args: &[Value]| {
            let retained = kept(&s, args.first().unwrap_or(&Value::Null))?;
            let call_args = args.get(1).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            Ok(retained.call(&call_args)?)
        }),
    );
    let s = state.clone();
    members.insert(
        "catchKept".into(),
        Arc::new(move |args: &[Value]| {
            let retained = kept(&s, args.first().unwrap_or(&Value::Null))?;
            let call_args = args.get(1).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            Ok(caught(retained.call(&call_args)))
        }),
    );
    let s = state.clone();
    members.insert(
        "release".into(),
        Arc::new(move |args: &[Value]| {
            kept(&s, args.first().unwrap_or(&Value::Null))?.release();
            Ok(Value::Null)
        }),
    );
    let s = state.clone();
    members.insert(
        "giveBack".into(),
        Arc::new(move |args: &[Value]| Ok(kept(&s, args.first().unwrap_or(&Value::Null))?.to_value())),
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
    let mut limits = serde_json::Map::new();
    if let Some(extra) = entry.get("limits").and_then(|v| v.as_object()) {
        limits.extend(extra.clone());
    }
    if let Some(timeout) = entry.get("timeoutMs") {
        limits.insert("timeout_ms".into(), timeout.clone());
    }
    if !limits.is_empty() {
        manifest["limits"] = Value::Object(limits);
    }
    manifest
}

/// Replaces every `{ "$kept": i }` with `kept[i]`'s marker.
fn substitute(value: &Value, state: &Shared) -> Value {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$kept") => {
            kept(state, &map["$kept"]).expect("a kept callback").to_value()
        }
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), substitute(v, state))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute(v, state)).collect()),
        other => other.clone(),
    }
}

fn assert_error_mentions(name: &str, message: &str, parts: &Value) {
    for part in parts.as_array().expect("error parts") {
        let part = part.as_str().unwrap();
        assert!(message.contains(part), "{name}: {message:?} lacks {part:?}");
    }
}

fn assert_outcome(name: &str, step: &Value, outcome: Result<Value, String>) {
    if let Some(parts) = step.get("error") {
        match outcome {
            Err(message) => assert_error_mentions(name, &message, parts),
            Ok(value) => panic!("{name}: expected an error, got {value:?}"),
        }
    } else if let Some(expected) = step.get("result") {
        let value = outcome.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(numeric(&value), numeric(expected), "{name}");
    } else {
        outcome.unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

fn assert_failure(name: &str, step: &Value, outcome: Result<Value, CallbackError>) {
    let Some(expected) = step.get("fails").and_then(|v| v.as_str()) else {
        let value = outcome.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(numeric(&value), numeric(&step["result"]), "{name}");
        return;
    };
    match outcome {
        Err(error) => {
            assert_eq!(error.reason(), expected, "{name}: {error}");
            if let Some(message) = step.get("message").and_then(|v| v.as_str()) {
                assert_eq!(error.to_string(), message, "{name}");
            }
        }
        Ok(value) => panic!("{name}: expected {expected}, got {value:?}"),
    }
}

/// A fire step with `fails` must surface that callback failure to the host;
/// the error carries it as the callback's own message, `callback <reason>`.
fn assert_fire(name: &str, step: &Value, outcome: Result<Value, String>) {
    let Some(expected) = step.get("fails").and_then(|v| v.as_str()) else {
        assert_outcome(name, step, outcome);
        return;
    };
    match outcome {
        Err(message) => assert!(
            message.contains(&format!("callback {expected}")),
            "{name}: expected a {expected} failure, got {message:?}"
        ),
        Ok(value) => panic!("{name}: expected {expected}, got {value:?}"),
    }
}

fn run_after(name: &str, steps: &[Value], runtime: &mut Option<XriptRuntime>, state: &Shared) {
    for step in steps {
        let rt = || runtime.as_ref().expect("the runtime is still alive");
        if let Some(index) = step.get("call") {
            let retained = kept(state, index).unwrap();
            let args = step.get("args").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            assert_failure(name, step, retained.call(&args));
        } else if let Some(index) = step.get("callOffThread") {
            let retained = kept(state, index).unwrap();
            let args = step.get("args").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let outcome = std::thread::spawn(move || retained.call(&args)).join().unwrap();
            assert_failure(name, step, outcome);
        } else if let Some(index) = step.get("release") {
            kept(state, index).unwrap().release();
        } else if let Some(mod_name) = step.get("releaseMod").and_then(|v| v.as_str()) {
            let released = rt().release_retained(mod_name);
            assert_eq!(Some(released as u64), step["released"].as_u64(), "{name}: released");
        } else if step.get("dispose").is_some() {
            runtime.take();
        } else if let Some(code) = step.get("execute").and_then(|v| v.as_str()) {
            let outcome = rt().execute(code).map(|r| r.value).map_err(|e| e.to_string());
            assert_outcome(name, step, outcome);
        } else if let Some(hook) = step.get("fireHook").and_then(|v| v.as_str()) {
            let data = substitute(&step["data"], state);
            let outcome = rt().fire_hook(hook, &[data]).map(Value::from).map_err(|e| e.to_string());
            assert_fire(name, step, outcome);
        } else if let Some(event) = step.get("emit").and_then(|v| v.as_str()) {
            let payload = substitute(&step["payload"], state);
            let outcome = rt().emit(event, &[payload]).map(Value::from).map_err(|e| e.to_string());
            assert_fire(name, step, outcome);
        } else if let Some(export) = step.get("invoke").and_then(|v| v.as_str()) {
            let args = substitute(step.get("args").unwrap_or(&json!([])), state);
            let args = args.as_array().cloned().unwrap_or_default();
            let outcome = match step.get("owner").and_then(|v| v.as_str()) {
                Some(owner) => rt().invoke_mod_export(owner, export, &args),
                None => rt().invoke_export(export, &args),
            };
            assert_outcome(name, step, outcome.map_err(|e| e.to_string()));
        } else if step.get("retainStashed").is_some() {
            let stashed = state.lock().unwrap().stashed.clone().expect("a stashed callback");
            let outcome = stashed.retain();
            assert_eq!(
                outcome.as_ref().err().map(|e| e.reason()),
                step["fails"].as_str(),
                "{name}: {outcome:?}"
            );
        } else {
            panic!("{name}: unknown after step {step}");
        }
    }
}

fn load_mods(name: &str, runtime: &XriptRuntime, mods: &[Value]) {
    for module in mods {
        let mod_name = module["name"].as_str().unwrap();
        let manifest = json!({ "xript": "0.10", "name": mod_name, "version": "1.0.0", "entry": "main.js" });
        let sources = HashMap::from([("main.js".to_string(), module["script"].as_str().unwrap().to_string())]);
        runtime
            .load_mod(&manifest.to_string(), sources, &HashSet::new(), None)
            .unwrap_or_else(|e| panic!("{name}: loading {mod_name}: {e}"));
    }
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
        let state: Shared = Arc::new(Mutex::new(ProbeState::default()));
        let mut runtime = Some(
            create_runtime_from_value(
                manifest_for(&corpus, entry),
                RuntimeOptions {
                    host_bindings: probe(state.clone()),
                    mode,
                    ..Default::default()
                },
            )
            .unwrap_or_else(|e| panic!("{name}: runtime: {e}")),
        );
        let rt = runtime.as_ref().unwrap();
        if let Some(mods) = entry.get("mods").and_then(|v| v.as_array()) {
            load_mods(name, rt, mods);
        }

        let expect = entry.get("expect").cloned().unwrap_or(Value::Null);
        if let Some(script) = entry.get("script").and_then(|v| v.as_str()) {
            let outcome = rt.execute(script);
            if expect.get("limit").is_some() {
                assert!(
                    matches!(outcome, Err(XriptError::ExecutionLimit { .. })),
                    "{name}: expected an execution limit, got {outcome:?}"
                );
                continue;
            }
            if let Some(parts) = expect.get("error") {
                let message = match outcome {
                    Err(e) => e.to_string(),
                    Ok(v) => panic!("{name}: expected an error, got {:?}", v.value),
                };
                assert_error_mentions(name, &message, parts);
            } else {
                let value = outcome.unwrap_or_else(|e| panic!("{name}: {e}")).value;
                if let Some(result) = expect.get("result") {
                    assert_eq!(numeric(&value), numeric(result), "{name}");
                }
            }
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
        if let Some(steps) = entry.get("after").and_then(|v| v.as_array()) {
            run_after(name, steps, &mut runtime, &state);
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

fn retaining_manifest() -> Value {
    json!({
        "xript": "0.10",
        "name": "retaining",
        "bindings": {
            "keep": {
                "description": "Retains a callback.",
                "params": [{ "name": "fn", "type": "function", "retain": true }]
            },
            "give": { "description": "Returns what the host chose." },
            "later": { "description": "Any async binding.", "async": true }
        },
        "hooks": { "tick": { "description": "A hook." } }
    })
}

struct Retaining {
    runtime: XriptRuntime,
    kept: Arc<Mutex<Vec<RetainedCallback>>>,
    given: Arc<Mutex<Value>>,
}

fn retaining(mode: RuntimeMode) -> Retaining {
    let kept: Arc<Mutex<Vec<RetainedCallback>>> = Arc::new(Mutex::new(Vec::new()));
    let given = Arc::new(Mutex::new(Value::Null));
    let mut bindings = HostBindings::new();
    let keep_into = kept.clone();
    bindings.add_function("keep", move |args| {
        let retained = args.first().and_then(Callback::from_value).ok_or("no callback")?.retain()?;
        keep_into.lock().unwrap().push(retained);
        Ok(Value::Null)
    });
    let give_from = given.clone();
    bindings.add_function("give", move |_args| Ok(give_from.lock().unwrap().clone()));
    bindings.add_async_function("later", |_args| async { Ok(json!("later")) });
    let runtime = create_runtime_from_value(
        retaining_manifest(),
        RuntimeOptions {
            host_bindings: bindings,
            mode,
            ..Default::default()
        },
    )
    .unwrap();
    Retaining { runtime, kept, given }
}

#[test]
fn an_async_binding_refuses_to_start_inside_a_retained_callback() {
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        let host = retaining(mode);
        host.runtime.execute("keep(function () { return later(); })").unwrap();
        let retained = host.kept.lock().unwrap()[0].clone();
        let error = retained.call(&[]).unwrap_err();
        assert_eq!(error.reason(), "threw", "{mode:?}");
        assert!(
            error.to_string().contains("later(): cannot be called from inside a callback"),
            "{error}"
        );
    }
}

#[test]
fn a_callback_marker_that_does_not_resolve_reaches_script_as_undefined() {
    let host = retaining(RuntimeMode::Sync);
    let other = retaining(RuntimeMode::Sync);
    other.runtime.execute("keep(function () {})").unwrap();
    let foreign = other.kept.lock().unwrap()[0].to_value();

    for marker in [
        json!({ "$xriptCallback": "r:1:2:keep" }),
        json!({ "$xriptCallback": "1:0:5:probe.call" }),
        foreign,
    ] {
        *host.given.lock().unwrap() = json!({ "nested": [marker.clone()] });
        let value = host.runtime.execute("(function () { var v = give(); return typeof v.nested[0]; })()").unwrap().value;
        assert_eq!(value, json!("undefined"), "{marker}");
    }

    let numeric = json!({ "$xriptCallback": 0 });
    *host.given.lock().unwrap() = json!({ "nested": [numeric.clone()] });
    assert_eq!(host.runtime.execute("give()").unwrap().value, json!({ "nested": [numeric] }));
}

#[test]
fn a_released_marker_is_refused_crossing_back_in() {
    let host = retaining(RuntimeMode::Sync);
    host.runtime.execute("keep(function () {})").unwrap();
    let retained = host.kept.lock().unwrap()[0].clone();
    retained.release();
    assert!(retained.is_released());
    *host.given.lock().unwrap() = retained.to_value();
    let outcome = host
        .runtime
        .execute("(function () { try { give(); return 'no throw'; } catch (e) { return e.message; } })()")
        .unwrap()
        .value;
    assert!(outcome.as_str().unwrap().contains("keep(): callback released"), "{outcome}");
}

#[test]
fn a_retained_callback_crosses_back_through_callback_arguments() {
    let host = retaining(RuntimeMode::Sync);
    host.runtime
        .execute("var f = function () {}; keep(f); keep(function (g) { return g === f; });")
        .unwrap();
    let (first, second) = {
        let kept = host.kept.lock().unwrap();
        (kept[0].clone(), kept[1].clone())
    };
    assert_eq!(second.call(&[first.to_value()]).unwrap(), json!(true));
}

#[test]
fn a_hook_handler_retains_on_behalf_of_its_mod() {
    let host = retaining(RuntimeMode::Sync);
    let manifest = json!({ "xript": "0.10", "name": "alpha", "version": "1.0.0", "entry": "main.js" });
    let sources = HashMap::from([(
        "main.js".to_string(),
        "hooks.tick(function () { keep(function () { return 'held'; }); });".to_string(),
    )]);
    host.runtime
        .load_mod(&manifest.to_string(), sources, &HashSet::new(), None)
        .unwrap();
    host.runtime.fire_hook("tick", &[]).unwrap();
    let retained = host.kept.lock().unwrap()[0].clone();
    assert_eq!(retained.call(&[]).unwrap(), json!("held"));
    assert_eq!(host.runtime.release_retained("alpha"), 1);
    assert_eq!(retained.call(&[]).unwrap_err().reason(), "released");
}

#[test]
fn a_hook_handler_keeps_its_receiver() {
    let host = retaining(RuntimeMode::Sync);
    host.runtime
        .execute("hooks.tick(function () { 'use strict'; return this === null; });")
        .unwrap();
    assert_eq!(host.runtime.fire_hook("tick", &[]).unwrap(), vec![json!(true)]);
}

#[test]
fn equal_handles_name_the_same_retained_callback() {
    let host = retaining(RuntimeMode::Sync);
    host.runtime.execute("var f = function () {}; keep(f); keep(f);").unwrap();
    let kept = host.kept.lock().unwrap();
    assert_eq!(kept[0], kept[1]);
    assert_eq!(kept[0].token(), kept[1].token());
    assert!(kept[0].token().starts_with("r:"));
}

#[test]
fn a_retained_callback_is_released_when_its_runtime_drops() {
    let host = retaining(RuntimeMode::Sync);
    host.runtime.execute("keep(function () { return 1; })").unwrap();
    let retained = host.kept.lock().unwrap()[0].clone();
    drop(host);
    assert_eq!(retained.call(&[]).unwrap_err().reason(), "released");
    assert!(retained.is_released());
}
