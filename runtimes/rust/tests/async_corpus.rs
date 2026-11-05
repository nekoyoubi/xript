//! Conformance against the shared async corpus in `spec/`: `execute_async`
//! runs its source as an async function body, and an async binding hands the
//! script a real promise. The `body`, `promise` and `exportAsync` sections
//! apply to Rust; `syncReach`, `executeResult` and `exportSync` cover
//! JavaScript runtimes that cannot drive an async binding synchronously, and
//! Rust skips them as the corpus says.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use serde::Deserialize;
use xript_runtime::{create_runtime_from_value, HostBindings, RuntimeMode, RuntimeOptions, XriptRuntime};

const CORPUS: &str = include_str!("../../../spec/async-tests.json");

#[derive(Deserialize)]
struct Corpus {
    manifest: serde_json::Value,
    body: Vec<Case>,
    promise: Vec<Case>,
    #[serde(rename = "mod")]
    module: Module,
    #[serde(rename = "exportAsync")]
    export_async: Vec<ExportCase>,
}

#[derive(Deserialize)]
struct Module {
    manifest: serde_json::Value,
    source: String,
}

#[derive(Deserialize)]
struct ExportCase {
    name: String,
    export: String,
    args: Vec<serde_json::Value>,
    expected: serde_json::Value,
    #[serde(default)]
    concurrent: bool,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    script: String,
    expected: serde_json::Value,
    #[serde(default)]
    concurrent: bool,
}

/// A timer that needs no executor: a thread sleeps, then wakes whoever polled.
struct Sleep {
    shared: Arc<Mutex<(bool, Option<Waker>)>>,
    duration: Duration,
    started: bool,
}

impl Future for Sleep {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut state = self.shared.lock().unwrap();
        if state.0 {
            return Poll::Ready(());
        }
        state.1 = Some(cx.waker().clone());
        drop(state);
        if !self.started {
            self.started = true;
            let shared = self.shared.clone();
            let duration = self.duration;
            std::thread::spawn(move || {
                std::thread::sleep(duration);
                let mut state = shared.lock().unwrap();
                state.0 = true;
                if let Some(waker) = state.1.take() {
                    waker.wake();
                }
            });
        }
        Poll::Pending
    }
}

fn sleep(ms: u64) -> Sleep {
    Sleep { shared: Arc::default(), duration: Duration::from_millis(ms), started: false }
}

fn runtime(manifest: &serde_json::Value, mode: RuntimeMode) -> XriptRuntime {
    let mut bindings = HostBindings::new();
    bindings.add_async_function("slow", |args: &[serde_json::Value]| {
        let ms = args.first().and_then(|v| v.as_u64()).unwrap_or(0);
        let value = args.get(1).cloned().unwrap_or(serde_json::Value::Null);
        async move {
            sleep(ms).await;
            Ok(value)
        }
    });
    bindings.add_async_function("fail", |args: &[serde_json::Value]| {
        let message = args.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
        async move { Err(message) }
    });
    bindings.add_function("sync", |_: &[serde_json::Value]| Ok(serde_json::json!("sync")));
    create_runtime_from_value(
        manifest.clone(),
        RuntimeOptions { host_bindings: bindings, mode, value_fidelity: true, ..Default::default() },
    )
    .expect("runtime builds")
}

#[test]
fn async_corpus() {
    let corpus: Corpus = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        let rt = runtime(&corpus.manifest, mode);
        for case in corpus.body.iter().chain(corpus.promise.iter()) {
            if case.concurrent && mode == RuntimeMode::Sync {
                continue;
            }
            match pollster::block_on(rt.execute_async(&case.script)) {
                Ok(result) if result.value == case.expected => {}
                Ok(result) => failures.push(format!("{mode:?} {}: expected {}, got {}", case.name, case.expected, result.value)),
                Err(error) => failures.push(format!("{mode:?} {}: {error}", case.name)),
            }
        }
        let mod_name = corpus.module.manifest["name"].as_str().unwrap_or_default().to_string();
        rt.load_mod(
            &corpus.module.manifest.to_string(),
            std::collections::HashMap::from([("mod.js".to_string(), corpus.module.source.clone())]),
            &std::collections::HashSet::new(),
            None,
        )
        .expect("the corpus mod loads");
        for case in &corpus.export_async {
            if case.concurrent && mode == RuntimeMode::Sync {
                continue;
            }
            match pollster::block_on(rt.invoke_mod_export_async(&mod_name, &case.export, &case.args)) {
                Ok(value) if value == case.expected => {}
                Ok(value) => failures.push(format!("{mode:?} {}: expected {}, got {value}", case.name, case.expected)),
                Err(error) => failures.push(format!("{mode:?} {}: {error}", case.name)),
            }
        }
    }
    assert!(failures.is_empty(), "async corpus failures:\n{}", failures.join("\n"));
}
