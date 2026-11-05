use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use xript_runtime::{
    create_runtime_from_value, Callback, HostBindings, HostCallInfo, RetainedCallback, RuntimeMode, RuntimeOptions,
    XriptRuntime,
};

const CORPUS: &str = include_str!("../../../spec/reentrancy-tests.json");

/// How long one case may take before it counts as hung. A hang is the bug
/// this corpus exists to catch, so it fails the case rather than the suite.
const HANG: Duration = Duration::from_secs(10);

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("corpus parses")
}

#[derive(Default)]
struct Host {
    runtime: OnceLock<XriptRuntime>,
    kept: Mutex<Vec<RetainedCallback>>,
    settled: Mutex<Vec<Value>>,
}

impl Host {
    fn runtime(&self) -> &XriptRuntime {
        self.runtime.get().expect("runtime is built")
    }

    fn kept(&self, index: &Value) -> Result<RetainedCallback, String> {
        let index = index.as_u64().ok_or("index")? as usize;
        self.kept.lock().unwrap().get(index).cloned().ok_or_else(|| "no such kept callback".to_string())
    }

    fn enter(&self, args: &[Value], inner_mod: &str) -> Result<Value, String> {
        let entry = args.first().and_then(Value::as_str).ok_or("entry")?;
        let arg = args.get(1).cloned().unwrap_or(Value::Null);
        let pair = |arg: &Value| (arg[0].as_str().unwrap_or_default().to_string(), arg[1].clone());
        let rt = self.runtime();
        let result = match entry {
            "execute" => rt.execute(arg.as_str().ok_or("code")?).map(|r| r.value),
            "executeAsync" => {
                let settled = pollster::block_on(rt.execute_async(arg.as_str().ok_or("code")?));
                self.settled.lock().unwrap().push(settled.map(|r| r.value).map_err(|e| e.to_string())?);
                return Ok(Value::Null);
            }
            "invokeExport" => {
                let (name, call_args) = pair(&arg);
                rt.invoke_export(&name, call_args.as_array().cloned().unwrap_or_default().as_slice())
            }
            "invokeModExport" => {
                let (name, call_args) = pair(&arg);
                rt.invoke_mod_export(inner_mod, &name, call_args.as_array().cloned().unwrap_or_default().as_slice())
            }
            "fireHook" => {
                let (hook, data) = pair(&arg);
                rt.fire_hook(&hook, &[data]).map(Value::Array)
            }
            "emit" => {
                let (event, payload) = pair(&arg);
                rt.emit(&event, &[payload]).map(Value::Array)
            }
            other => return Err(format!("unknown entry {other}")),
        };
        result.map_err(|e| e.to_string())
    }
}

fn bindings(host: &Arc<Host>, inner_mod: &str) -> HostBindings {
    let mut bindings = HostBindings::new();
    let (h, m) = (host.clone(), inner_mod.to_string());
    bindings.add_function("enter", move |args| h.enter(args, &m));
    let h = host.clone();
    bindings.add_function("keep", move |args| {
        let callback = args.first().and_then(Callback::from_value).ok_or("no callback")?;
        let retained = callback.retain()?;
        let mut kept = h.kept.lock().unwrap();
        kept.push(retained);
        Ok(json!(kept.len() - 1))
    });
    let h = host.clone();
    bindings.add_function("callKept", move |args| {
        let callback = h.kept(args.first().unwrap_or(&Value::Null))?;
        callback
            .call(&[args.get(1).cloned().unwrap_or(Value::Null)])
            .map_err(|e| e.to_string())
    });
    bindings.add_function_with_caller("who", |info: &HostCallInfo, _args: &[Value]| {
        Ok(json!({ "modId": info.mod_id, "binding": info.binding }))
    });
    bindings
}

/// JSON equality with numbers compared by value, so `2` and `2.0` agree.
fn same(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y)),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(key, x)| b.get(key).is_some_and(|y| same(x, y)))
        }
        _ => actual == expected,
    }
}

fn run_case(corpus: &Value, case: &Value, mode: RuntimeMode) -> Result<(), String> {
    let inner_mod = corpus["mod"]["manifest"]["name"].as_str().unwrap();
    let host = Arc::new(Host::default());
    let rt = create_runtime_from_value(
        corpus["manifest"].clone(),
        RuntimeOptions {
            host_bindings: bindings(&host, inner_mod),
            mode,
            ..Default::default()
        },
    )
    .map_err(|e| format!("host manifest loads: {e}"))?;
    host.runtime.set(rt).map_err(|_| "runtime set twice")?;
    let rt = host.runtime();

    let entry = corpus["mod"]["manifest"]["entry"]["script"].as_str().unwrap().to_string();
    let sources = HashMap::from([(entry, corpus["mod"]["source"].as_str().unwrap().to_string())]);
    rt.load_mod(&corpus["mod"]["manifest"].to_string(), sources, &HashSet::new(), None)
        .map_err(|e| format!("mod loads: {e}"))?;
    rt.execute(corpus["setup"].as_str().unwrap()).map_err(|e| format!("setup: {e}"))?;

    let script_value = rt
        .execute(case["script"].as_str().unwrap())
        .map_err(|e| format!("script failed: {e}"))?
        .value;
    let actual = match case.get("kept") {
        None => script_value,
        Some(kept) => {
            let args = kept["args"].as_array().cloned().unwrap_or_default();
            host.kept(&kept["index"])?.call(&args).map_err(|e| format!("kept call failed: {e}"))?
        }
    };
    if !same(&actual, &case["expected"]) {
        return Err(format!("got {actual}, expected {}", case["expected"]));
    }
    let settled = Value::Array(host.settled.lock().unwrap().clone());
    let expected_settled = case.get("settled").cloned().unwrap_or_else(|| json!([]));
    if !same(&settled, &expected_settled) {
        return Err(format!("settled {settled}, expected {expected_settled}"));
    }
    match rt.execute("'usable'") {
        Ok(result) if result.value == json!("usable") => Ok(()),
        Ok(result) => Err(format!("runtime answered {} afterwards", result.value)),
        Err(error) => Err(format!("runtime unusable afterwards: {error}")),
    }
}

fn run_corpus(mode: RuntimeMode) {
    let corpus = Arc::new(corpus());
    let mut failures = Vec::new();
    for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap_or_default().to_string();
        let (sender, receiver) = mpsc::channel();
        let shared = corpus.clone();
        std::thread::spawn(move || {
            let case = &shared["cases"][index];
            let _ = sender.send(run_case(&shared, case, mode));
        });
        match receiver.recv_timeout(HANG) {
            Ok(Ok(())) => {}
            Ok(Err(failure)) => failures.push(format!("{name}: {failure}")),
            Err(mpsc::RecvTimeoutError::Timeout) => failures.push(format!("{name}: hung")),
            Err(mpsc::RecvTimeoutError::Disconnected) => failures.push(format!("{name}: panicked")),
        }
    }
    assert!(failures.is_empty(), "{} of {} cases failed ({mode:?}):\n{}", failures.len(), corpus["cases"].as_array().unwrap().len(), failures.join("\n"));
}

#[test]
fn reentrancy_corpus_sync_mode() {
    run_corpus(RuntimeMode::Sync);
}

#[test]
fn reentrancy_corpus_async_mode() {
    run_corpus(RuntimeMode::Async);
}
