use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use xript_runtime::{
    create_runtime, Callback, CallbackError, ConsoleHandler, HostBindings, RetainedCallback, RuntimeMode,
    RuntimeOptions, XriptRuntime,
};

const MANIFEST: &str = r#"{
    "xript": "0.10",
    "name": "reentry",
    "limits": { "timeout_ms": 500 },
    "bindings": {
        "keep": { "description": "Retains a function.", "params": [{ "name": "fn", "type": "function", "retain": true }] },
        "drive": { "description": "Awaits a retained callback with call_async." },
        "refuse": { "description": "Calls a retained callback with call." },
        "later": { "description": "Settles on a later poll.", "async": true },
        "run": { "description": "Re-enters execute." }
    }
}"#;

/// Settles on its second poll, so an async binding returning it is genuinely
/// pending for a moment.
struct Later(Option<Value>, bool);

impl Future for Later {
    type Output = Result<Value, String>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.1 {
            return Poll::Ready(Ok(self.0.take().unwrap_or(Value::Null)));
        }
        self.1 = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

#[derive(Default)]
struct Host {
    runtime: OnceLock<XriptRuntime>,
    kept: Mutex<Vec<RetainedCallback>>,
}

impl Host {
    fn kept(&self, args: &[Value]) -> Result<RetainedCallback, String> {
        let index = args.first().and_then(Value::as_u64).ok_or("index")? as usize;
        self.kept.lock().unwrap().get(index).cloned().ok_or_else(|| "no such kept callback".into())
    }
}

fn runtime(mode: RuntimeMode, console: Option<ConsoleHandler>) -> Arc<Host> {
    let host = Arc::new(Host::default());
    let mut bindings = HostBindings::new();
    let h = host.clone();
    bindings.add_function("keep", move |args| {
        let retained = args.first().and_then(Callback::from_value).ok_or("no callback")?.retain()?;
        let mut kept = h.kept.lock().unwrap();
        kept.push(retained);
        Ok(json!(kept.len() - 1))
    });
    let h = host.clone();
    bindings.add_function("drive", move |args| {
        let callback = h.kept(args)?;
        pollster::block_on(callback.call_async(&args[1..])).map_err(|e| e.to_string())
    });
    let h = host.clone();
    bindings.add_function("refuse", move |args| {
        let callback = h.kept(args)?;
        Ok(match callback.call(&args[1..]) {
            Ok(value) => value,
            Err(error) => json!({ "refused": error.reason() }),
        })
    });
    bindings.add_async_function("later", |args: &[Value]| Later(args.first().cloned(), false));
    let h = host.clone();
    bindings.add_function("run", move |args| {
        let code = args.first().and_then(Value::as_str).ok_or("code")?;
        h.runtime.get().unwrap().execute(code).map(|r| r.value).map_err(|e| e.to_string())
    });
    let rt = create_runtime(
        MANIFEST,
        RuntimeOptions {
            host_bindings: bindings,
            mode,
            console: console.unwrap_or_default(),
            ..Default::default()
        },
    )
    .expect("runtime builds");
    host.runtime.set(rt).unwrap();
    host
}

fn modes() -> [RuntimeMode; 2] {
    [RuntimeMode::Sync, RuntimeMode::Async]
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

#[test]
fn call_async_settles_an_async_callback_between_script_calls() {
    for mode in modes() {
        let host = runtime(mode, None);
        let rt = host.runtime.get().unwrap();
        rt.execute("keep(async function (x) { await null; var y = await Promise.resolve(x); return y * 2; })").unwrap();
        let kept = host.kept(&[json!(0)]).unwrap();
        assert!(matches!(kept.call(&[json!(1)]), Err(CallbackError::Promise { .. })), "{mode:?}");
        let settled = pollster::block_on(kept.call_async(&[json!(21)])).unwrap();
        assert_eq!(number(&settled), 42.0, "{mode:?}");
        assert_eq!(rt.execute("'usable'").unwrap().value, json!("usable"), "{mode:?}");
    }
}

#[test]
fn call_async_returns_a_plain_value_as_call_does() {
    for mode in modes() {
        let host = runtime(mode, None);
        host.runtime.get().unwrap().execute("keep(function (x) { return 'plain:' + x; })").unwrap();
        let kept = host.kept(&[json!(0)]).unwrap();
        assert_eq!(pollster::block_on(kept.call_async(&[json!("a")])).unwrap(), json!("plain:a"), "{mode:?}");
    }
}

#[test]
fn call_async_awaits_an_async_binding_the_callback_awaits() {
    for mode in modes() {
        let host = runtime(mode, None);
        host.runtime.get().unwrap().execute("keep(async function (x) { return 'got:' + (await later(x)); })").unwrap();
        let kept = host.kept(&[json!(0)]).unwrap();
        assert_eq!(pollster::block_on(kept.call_async(&[json!("v")])).unwrap(), json!("got:v"), "{mode:?}");
    }
}

#[test]
fn call_async_works_nested_inside_a_binding_where_call_refuses() {
    for mode in modes() {
        let host = runtime(mode, None);
        let rt = host.runtime.get().unwrap();
        let value = rt
            .execute("keep(async function (x) { await null; return x + 1; }); [refuse(0, 1), drive(0, 41)]")
            .unwrap()
            .value;
        assert_eq!(value[0], json!({ "refused": "promise" }), "{mode:?}");
        assert_eq!(number(&value[1]), 42.0, "{mode:?}");
    }
}

#[test]
fn call_async_nested_awaits_an_async_binding_in_place() {
    for mode in modes() {
        let host = runtime(mode, None);
        let rt = host.runtime.get().unwrap();
        let value = rt
            .execute("keep(async function (x) { return 'got:' + (await later(x)); }); drive(0, 'n')")
            .unwrap()
            .value;
        assert_eq!(value, json!("got:n"), "{mode:?}");
    }
}

#[test]
fn call_async_nests_inside_call_async() {
    for mode in modes() {
        let host = runtime(mode, None);
        let rt = host.runtime.get().unwrap();
        rt.execute(
            "keep(async function (x) { await null; return 'inner:' + x; }); \
             keep(async function (x) { var v = drive(0, x); await null; return 'outer(' + v + ')'; });",
        )
        .unwrap();
        let outer = host.kept(&[json!(1)]).unwrap();
        assert_eq!(pollster::block_on(outer.call_async(&[json!("z")])).unwrap(), json!("outer(inner:z)"), "{mode:?}");
        let nested = rt.execute("drive(1, 'q')").unwrap().value;
        assert_eq!(nested, json!("outer(inner:q)"), "{mode:?}");
    }
}

#[test]
fn call_async_reports_a_rejection_as_a_throw() {
    for mode in modes() {
        let host = runtime(mode, None);
        host.runtime.get().unwrap().execute("keep(async function () { await null; throw new Error('nope'); })").unwrap();
        let kept = host.kept(&[json!(0)]).unwrap();
        match pollster::block_on(kept.call_async(&[])) {
            Err(CallbackError::Threw { message, .. }) => assert_eq!(message, "nope", "{mode:?}"),
            other => panic!("{mode:?}: expected a throw, got {other:?}"),
        }
    }
}

#[test]
fn call_async_runs_on_a_fresh_budget_and_leaves_the_runtime_usable() {
    for mode in modes() {
        let host = runtime(mode, None);
        let rt = host.runtime.get().unwrap();
        rt.execute("keep(async function () { await null; for (;;) {} })").unwrap();
        let kept = host.kept(&[json!(0)]).unwrap();
        let started = Instant::now();
        let outcome = pollster::block_on(kept.call_async(&[]));
        assert!(matches!(outcome, Err(CallbackError::Limit { .. })), "{mode:?}: {outcome:?}");
        assert!(started.elapsed() < Duration::from_secs(5), "{mode:?}");
        assert_eq!(rt.execute("'usable'").unwrap().value, json!("usable"), "{mode:?}");
    }
}

#[test]
fn call_async_future_is_send() {
    fn assert_send<T: Send>(_: &T) {}
    let host = runtime(RuntimeMode::Async, None);
    host.runtime.get().unwrap().execute("keep(function () { return 1; })").unwrap();
    let kept = host.kept(&[json!(0)]).unwrap();
    let future = kept.call_async(&[]);
    assert_send(&future);
    assert_eq!(number(&pollster::block_on(future).unwrap()), 1.0);
}

#[test]
fn a_console_handler_can_re_enter_its_runtime() {
    for mode in modes() {
        let slot: Arc<OnceLock<Arc<Host>>> = Arc::new(OnceLock::new());
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (handler_slot, handler_seen) = (slot.clone(), seen.clone());
        let console = ConsoleHandler {
            log: Box::new(move |line| {
                let answer = match handler_slot.get() {
                    Some(host) => {
                        let executed = host.runtime.get().unwrap().execute("6 * 7").map(|r| r.value.to_string());
                        let kept = host.kept(&[json!(0)]).unwrap();
                        let called = kept.call(&[]).map(|v| v.to_string());
                        let awaited = pollster::block_on(kept.call_async(&[])).map(|v| v.to_string());
                        format!("{executed:?} {called:?} {awaited:?}")
                    }
                    None => "no runtime".into(),
                };
                handler_seen.lock().unwrap().push(format!("{line} -> {answer}"));
            }),
            ..Default::default()
        };
        let host = runtime(mode, Some(console));
        slot.set(host.clone()).ok();
        host.runtime.get().unwrap().execute("keep(function () { return 'k'; }); console.log('hi'); 1").unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "{mode:?}");
        assert_eq!(seen[0], r#"hi -> Ok("42") Ok("\"k\"") Ok("\"k\"")"#, "{mode:?}");
    }
}

#[test]
fn a_binding_re_enters_from_a_script_that_awaits_on_an_async_runtime() {
    let host = runtime(RuntimeMode::Async, None);
    let rt = host.runtime.get().unwrap();
    let value = pollster::block_on(rt.execute_async("var a = await later(2); return run('1 + ' + a);")).unwrap().value;
    assert_eq!(number(&value), 3.0);
}
