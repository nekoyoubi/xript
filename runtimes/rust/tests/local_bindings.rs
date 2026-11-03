//! Bindings whose closures hold non-`Send` host state, on a runtime driven
//! from one thread.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use xript_runtime::{create_local_runtime, HostBindings, LocalHostBindings, RuntimeOptions};

const MANIFEST: &str = r#"{
    "xript": "0.10",
    "name": "local-app",
    "bindings": {
        "count": { "description": "bumps a counter" },
        "fetch": { "description": "fetches", "async": true },
        "shared": { "description": "a Send binding" },
        "store": {
            "description": "a store",
            "members": {
                "get": { "description": "reads" },
                "put": { "description": "writes" },
                "label": { "description": "a label" }
            }
        }
    }
}"#;

fn local(counter: Rc<Cell<i64>>, store: Rc<RefCell<Vec<String>>>) -> LocalHostBindings {
    let mut local = LocalHostBindings::new();
    let bump = counter.clone();
    local.add_function("count", move |_| {
        bump.set(bump.get() + 1);
        Ok(serde_json::json!(bump.get()))
    });
    let seen = counter.clone();
    local.add_async_function("fetch", move |args| {
        let seen = seen.clone();
        let key = args.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
        async move { Ok(serde_json::json!(format!("{key}:{}", seen.get()))) }
    });
    let reader = store.clone();
    let writer = store.clone();
    local
        .namespace("store")
        .bind_sync("get", move |_| Ok(serde_json::json!(reader.borrow().join(","))))
        .bind_sync("put", move |args| {
            writer.borrow_mut().push(args[0].as_str().unwrap_or("").to_string());
            Ok(serde_json::Value::Null)
        })
        .property("label", serde_json::json!("local store"))
        .finish();
    local
}

#[test]
fn local_bindings_reach_non_send_state() {
    let counter = Rc::new(Cell::new(0));
    let store = Rc::new(RefCell::new(Vec::new()));
    let mut shared = HostBindings::new();
    shared.add_function("shared", |_: &[serde_json::Value]| Ok(serde_json::json!("send")));
    let rt = create_local_runtime(
        MANIFEST,
        RuntimeOptions { host_bindings: shared, ..Default::default() },
        local(counter.clone(), store.clone()),
    )
    .unwrap();

    assert!(!rt.missing_bindings().iter().any(|name| name == "count" || name == "fetch" || name == "store.get"));
    rt.execute("count(); count();").unwrap();
    assert_eq!(counter.get(), 2);
    rt.execute("store.put('a'); store.put('b');").unwrap();
    assert_eq!(rt.execute("store.get() + '|' + store.label + '|' + shared()").unwrap().value, serde_json::json!("a,b|local store|send"));
    assert_eq!(rt.execute("(async () => await fetch('k'))()").unwrap().value, serde_json::json!("k:2"));
    assert_eq!(*store.borrow(), ["a", "b"]);
}

#[test]
fn a_local_binding_refuses_another_thread() {
    let rt = create_local_runtime(
        MANIFEST,
        RuntimeOptions::default(),
        local(Rc::new(Cell::new(0)), Rc::new(RefCell::new(Vec::new()))),
    )
    .unwrap();
    let error = std::thread::scope(|scope| scope.spawn(|| rt.execute("count()")).join().unwrap()).unwrap_err();
    assert!(error.to_string().contains("can only be called on the thread that registered it"), "{error}");
    assert!(rt.execute("count()").is_ok());
}
