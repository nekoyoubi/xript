//! Script that exhausts the stack (runaway recursion, or `JSON.stringify` and
//! `JSON.parse` of something nested far too deep) throws a catchable error in
//! the sandbox and leaves the runtime usable, rather than overflowing the
//! native stack and taking the host process with it. The engine's budget is
//! measured from the thread that enters it, so a big thread recurses deep and
//! a small one stays safe.

use std::sync::{Arc, Mutex};

use serde_json::json;
use xript_runtime::{create_runtime_from_value, HardLimits, HostBindings, RuntimeOptions, XriptRuntime};

const MAX_RECURSION: &str =
    "(function () { var max = 0; function f(n) { max = n; return f(n + 1) + 1; } try { f(0); } catch (e) {} return max; })()";

fn on_thread<T: Send + 'static>(stack_bytes: usize, body: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new().stack_size(stack_bytes).spawn(body).unwrap().join().expect("the host thread survives")
}

fn depth_of(rt: &XriptRuntime) -> u64 {
    rt.execute(MAX_RECURSION).unwrap().value.as_u64().unwrap()
}

const EXHAUSTERS: &[&str] = &[
    "(function () { function f(n) { return f(n + 1) + 1; } try { f(0); return 'returned'; } catch (e) { return 'caught'; } })()",
    "(function () { var v = 0; for (var i = 0; i < 1000000; i++) v = [v]; try { JSON.stringify(v); return 'returned'; } catch (e) { return 'caught'; } })()",
    "(function () { var v = 0; for (var i = 0; i < 1000000; i++) v = { d: v }; try { JSON.stringify(v); return 'returned'; } catch (e) { return 'caught'; } })()",
    "(function () { var s = '['.repeat(1000000) + ']'.repeat(1000000); try { JSON.parse(s); return 'returned'; } catch (e) { return 'caught'; } })()",
    "(function () { var o = {}; o.toString = function () { return String(o); }; try { String(o); return 'returned'; } catch (e) { return 'caught'; } })()",
    "(function () { var o = { get g() { return this.g + 1; } }; try { o.g; return 'returned'; } catch (e) { return 'caught'; } })()",
    "(function () { function C() { new C(); } try { new C(); return 'returned'; } catch (e) { return 'caught'; } })()",
    "(function () { var v = 0; for (var i = 0; i < 1000000; i++) v = [v]; try { String(v); return 'returned'; } catch (e) { return 'caught'; } })()",
];

fn runtime(options: RuntimeOptions) -> XriptRuntime {
    create_runtime_from_value(json!({ "xript": "0.10", "name": "stack-probe" }), options).expect("runtime builds")
}

fn exhaust(rt: &XriptRuntime) {
    for script in EXHAUSTERS {
        assert_eq!(rt.execute(script).unwrap().value, json!("caught"), "{script}");
        assert_eq!(rt.execute("1 + 1").unwrap().value, json!(2), "usable after {script}");
    }
}

#[test]
fn stack_exhaustion_is_a_catchable_error() {
    exhaust(&runtime(RuntimeOptions::default()));
    exhaust(&runtime(RuntimeOptions { value_fidelity: true, ..Default::default() }));
}

#[test]
fn stack_exhaustion_is_caught_on_a_one_mebibyte_thread() {
    std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(|| exhaust(&runtime(RuntimeOptions::default())))
        .unwrap()
        .join()
        .expect("the host thread survives");
}

#[test]
fn a_host_stack_ceiling_still_applies() {
    let rt = runtime(RuntimeOptions {
        hard_limits: Some(HardLimits { max_stack_depth: Some(128), ..Default::default() }),
        ..Default::default()
    });
    exhaust(&rt);
}

#[test]
fn exhausting_the_stack_inside_a_crossing_value_fails_the_call_catchably() {
    let mut bindings = xript_runtime::HostBindings::new();
    bindings.add_function("sink", |_: &[serde_json::Value]| Ok(serde_json::Value::Null));
    let rt = create_runtime_from_value(
        json!({ "xript": "0.10", "name": "stack-probe", "bindings": { "sink": { "description": "Takes a value." } } }),
        RuntimeOptions { host_bindings: bindings, value_fidelity: true, ..Default::default() },
    )
    .unwrap();
    let caught = rt
        .execute("(function () { function f(n) { return f(n + 1) + 1; } try { sink({ get g() { return f(0); } }); return 'crossed'; } catch (e) { return 'caught'; } })()")
        .unwrap();
    assert_eq!(caught.value, json!("caught"));
    assert_eq!(rt.execute("1 + 1").unwrap().value, json!(2));
}

#[test]
fn a_big_thread_recurses_deep() {
    let depth = on_thread(8 * 1024 * 1024, || depth_of(&runtime(RuntimeOptions::default())));
    let small = on_thread(1024 * 1024, || depth_of(&runtime(RuntimeOptions::default())));
    eprintln!("recursion depth: {depth} on an 8 MiB thread, {small} on a 1 MiB thread");
    let floor = 2000;
    assert!(depth >= floor, "only {depth} levels on an 8 MiB thread");
    assert!(depth > small * 4, "the budget did not follow the thread: {depth} vs {small}");
}

#[test]
fn a_binding_called_from_the_deepest_frame_has_room_to_run() {
    on_thread(1024 * 1024, || {
        let mut bindings = HostBindings::new();
        bindings.add_function("probe", |args: &[serde_json::Value]| {
            Ok(json!({ "echo": args.to_vec(), "text": "x".repeat(4096), "list": (0..64).collect::<Vec<_>>() }))
        });
        let rt = create_runtime_from_value(
            json!({ "xript": "0.10", "name": "stack-probe", "bindings": { "probe": { "description": "Returns its argument." } } }),
            RuntimeOptions { host_bindings: bindings, value_fidelity: true, ..Default::default() },
        )
        .unwrap();
        let result = rt
            .execute(
                "(function () { var calls = 0; function f(n) { try { return f(n + 1); } catch (e) { calls++; return probe({ n: n, nested: [[[n]]] }).list.length; } } \
                 return f(0) + ':' + (calls > 0); })()",
            )
            .unwrap();
        assert_eq!(result.value, json!("64:true"));
    });
}

/// A host binding of one runtime entering another on the same thread: the
/// nested entry is held to the outer entry's floor rather than given a fresh
/// budget of its own.
#[test]
fn a_nested_entry_never_widens_the_outer_budget() {
    let (alone, nested) = on_thread(8 * 1024 * 1024, || {
        let inner = Arc::new(Mutex::new(runtime(RuntimeOptions::default())));
        let alone = depth_of(&inner.lock().unwrap());
        let mut bindings = HostBindings::new();
        let reach = inner.clone();
        bindings.add_function("inner", move |_: &[serde_json::Value]| {
            Ok(json!(depth_of(&reach.lock().unwrap())))
        });
        let outer = create_runtime_from_value(
            json!({ "xript": "0.10", "name": "outer", "bindings": { "inner": { "description": "Recurses elsewhere." } } }),
            RuntimeOptions {
                host_bindings: bindings,
                hard_limits: Some(HardLimits { max_stack_depth: Some(256), ..Default::default() }),
                ..Default::default()
            },
        )
        .unwrap();
        let nested = outer.execute("inner()").unwrap().value.as_f64().unwrap() as u64;
        assert_eq!(depth_of(&inner.lock().unwrap()), alone, "the outer floor is released when the nested entry ends");
        (alone, nested)
    });
    assert!(nested * 4 < alone, "a nested entry under a 256 KiB cap reached {nested} levels; alone it reaches {alone}");
}

#[test]
fn ordinary_recursion_still_runs() {
    let rt = runtime(RuntimeOptions::default());
    let result = rt
        .execute("(function () { function f(n) { return n === 0 ? 0 : f(n - 1) + 1; } return f(25); })()")
        .unwrap();
    assert_eq!(result.value, json!(25));
}
