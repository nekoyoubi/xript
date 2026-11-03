//! Caller identity follows the logical call, not the top of a shared stack:
//! on a yielding runtime two mods' calls park on async bindings and resume in
//! either order, and each resumption is still credited to its own mod.

#![cfg(feature = "threads")]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use xript_runtime::{HostBindings, RuntimeMode, RuntimeOptions, XriptHandle};

const MANIFEST: &str = r#"{
    "xript": "0.10",
    "name": "interleave-host",
    "bindings": {
        "wait": { "description": "Settles after a delay.", "async": true, "params": [{ "name": "ms", "type": "number" }] },
        "who": { "description": "Records the calling mod.", "params": [{ "name": "tag", "type": "string" }] }
    },
    "events": [{ "id": "note.posted", "description": "A note was posted." }]
}"#;

const MOD_SOURCE: &str = r#"
xript.exports.register('go', async function (tag, ms) {
    who(tag + ':before');
    await wait(ms);
    events.on('note.posted', function () { return tag; });
    who(tag + ':after');
    await wait(ms);
    return who(tag + ':end');
});
xript.exports.register('dangle', function (tag, ms) {
    wait(ms).then(function () { who(tag + ':late'); });
    return who(tag + ':returned');
});
"#;

fn handle(seen: Arc<Mutex<Vec<String>>>) -> XriptHandle {
    let mut bindings = HostBindings::new();
    bindings.add_async_function("wait", |args: &[Value]| {
        let ms = args.first().and_then(Value::as_u64).unwrap_or(0);
        async move {
            let (tx, rx) = futures_channel();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(ms));
                tx();
            });
            rx.await;
            Ok(json!(ms))
        }
    });
    bindings.add_function_with_caller("who", move |info, args| {
        let tag = args.first().and_then(Value::as_str).unwrap_or("").to_string();
        let mod_id = info.mod_id.clone();
        seen.lock().unwrap().push(format!("{tag}={}", mod_id.as_deref().unwrap_or("null")));
        Ok(mod_id.map(Value::String).unwrap_or(Value::Null))
    });
    let handle = XriptHandle::new(
        MANIFEST.to_string(),
        RuntimeOptions { host_bindings: bindings, mode: RuntimeMode::Async, ..Default::default() },
    )
    .unwrap();
    for name in ["mod-a", "mod-b"] {
        let manifest = format!(
            r#"{{ "xript": "0.10", "name": "{name}", "version": "1.0.0",
                 "entry": {{ "script": "mod.js", "exports": {{ "go": {{ "description": "go" }}, "dangle": {{ "description": "dangle" }} }} }} }}"#
        );
        handle
            .load_mod(&manifest, HashMap::from([("mod.js".to_string(), MOD_SOURCE.to_string())]), &HashSet::new(), None)
            .wait()
            .unwrap();
    }
    handle
}

/// A one-shot signal: the sender fires it from any thread, the future wakes.
fn futures_channel() -> (impl FnOnce() + Send, impl std::future::Future<Output = ()>) {
    let state: Arc<Mutex<(bool, Option<std::task::Waker>)>> = Arc::new(Mutex::new((false, None)));
    let sender = state.clone();
    let fire = move || {
        let mut guard = sender.lock().unwrap();
        guard.0 = true;
        if let Some(waker) = guard.1.take() {
            waker.wake();
        }
    };
    let wait = std::future::poll_fn(move |cx| {
        let mut guard = state.lock().unwrap();
        if guard.0 {
            std::task::Poll::Ready(())
        } else {
            guard.1 = Some(cx.waker().clone());
            std::task::Poll::Pending
        }
    });
    (fire, wait)
}

fn assert_own_mods(seen: &[String]) {
    for entry in seen {
        let (tag, owner) = entry.split_once('=').unwrap();
        assert_eq!(owner, format!("mod-{}", &tag[..1]), "{entry} was credited to the wrong mod; saw {seen:?}");
    }
}

#[test]
fn each_resumed_call_is_credited_to_its_own_mod() {
    for (a_ms, b_ms) in [(10u64, 60u64), (60, 10)] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handle = handle(seen.clone());
        let a = handle.invoke_mod_export("mod-a", "go", &[json!("a"), json!(a_ms)]);
        let b = handle.invoke_mod_export("mod-b", "go", &[json!("b"), json!(b_ms)]);
        assert_eq!(a.wait().unwrap(), json!("mod-a"));
        assert_eq!(b.wait().unwrap(), json!("mod-b"));
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 6, "{seen:?}");
        assert_own_mods(&seen);
    }
}

#[test]
fn subscriptions_made_after_an_await_belong_to_the_subscribing_mod() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let handle = handle(seen);
    let a = handle.invoke_mod_export("mod-a", "go", &[json!("a"), json!(10)]);
    let b = handle.invoke_mod_export("mod-b", "go", &[json!("b"), json!(40)]);
    a.wait().unwrap();
    b.wait().unwrap();
    let owners = handle
        .execute("JSON.stringify(events.subscribers('note.posted').owners)")
        .wait()
        .unwrap()
        .value;
    assert_eq!(owners, json!(r#"[{"owner":"mod-a","count":1},{"owner":"mod-b","count":1}]"#));
}

#[test]
fn a_continuation_that_outlives_its_call_has_no_owner() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let handle = handle(seen.clone());
    assert_eq!(handle.invoke_mod_export("mod-a", "dangle", &[json!("a"), json!(10)]).wait().unwrap(), json!("mod-a"));
    let parked = handle.invoke_mod_export("mod-b", "go", &[json!("b"), json!(60)]);
    parked.wait().unwrap();
    let seen = seen.lock().unwrap().clone();
    assert!(seen.contains(&"a:returned=mod-a".to_string()), "{seen:?}");
    assert!(seen.contains(&"a:late=null".to_string()), "{seen:?}");
    assert_own_mods(&seen.iter().filter(|entry| !entry.starts_with("a:late")).cloned().collect::<Vec<_>>());
}
