//! What exports, hooks and events hand the host, pinned for both runtime
//! modes against a golden transcript: returns, throws, promises, thenables,
//! queued jobs, handlers that throw or register more, value fidelity on and off.
//!
//! The transcript was recorded from the runtime that evaluated per-call
//! dispatch source, before dispatch went native. A deliberate change in what
//! the host receives is re-recorded with `XRIPT_BLESS=1`, once per feature set
//! (`preserve_order` keeps its own transcript, since it changes how an object
//! payload spreads).

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, HostBindings, RuntimeMode, RuntimeOptions, XriptRuntime};

const GOLDEN: &str = if cfg!(feature = "preserve_order") {
    "tests/fixtures/host_entry_golden.preserve_order.txt"
} else {
    "tests/fixtures/host_entry_golden.txt"
};

const SETUP: &str = r#"
    var exportsByName = {
        awaitsBinding: async function (x) { return [await later(x), 'after']; },
        spins: function () { while (true) {} },
        echo: function (x) { return x; },
        many: function () { return Array.prototype.slice.call(arguments); },
        nothing: function () {},
        symbol: function () { return Symbol('tag'); },
        fn: function () { return function () {}; },
        resolved: function () { return Promise.resolve(5); },
        rejected: function () { return Promise.reject(new Error('nope')); },
        asyncValue: async function (x) { return x + 1; },
        thenable: function () { return { then: function (resolve) { resolve(42); } }; },
        thenThrows: function () { return { then: function () { throw new Error('then threw'); } }; },
        thenGetterThrows: function () { return Object.defineProperty({}, 'then', { get: function () { throw new Error('getter threw'); } }); },
        queued: function () { var o = { v: 1 }; Promise.resolve().then(function () { o.v = 2; }); return o; },
        queuedPrimitive: function () { var box = []; Promise.resolve().then(function () { box.push(1); }); return 3; },
        throwsError: function () { throw new Error('boom'); },
        throwsTyped: function () { throw new TypeError('typed'); },
        throwsString: function () { throw 'plain'; },
        throwsNumberMessage: function () { throw { message: 5 }; },
        throwsObjectMessage: function () { throw { message: 'from object' }; },
        throwsUndefined: function () { throw undefined; },
        throwsNull: function () { throw null; },
        messageGetterThrows: function () { throw Object.defineProperty({}, 'message', { get: function () { throw new Error('inner'); } }); },
        keyed: function () { return { toJSON: function (key) { return 'key:' + key; } }; },
        nestedKeyed: function () { return { inner: { toJSON: function (key) { return 'key:' + key; } } }; },
        getterThrows: function () { return Object.defineProperty({}, 'bad', { enumerable: true, get: function () { throw new Error('read failed'); } }); },
        bigint: function () { return 10n; },
        cyclic: function () { var o = {}; o.self = o; return o; },
        specials: function () { return [NaN, Infinity, -0, undefined]; },
        integral: function () { return 7; },
        half: function () { return 7.5; },
        negZero: function () { return -0; },
        array: function () { return [1, 'two', { three: 3 }]; }
    };
    Object.keys(exportsByName).forEach(function (name) { xript.exports.register(name, exportsByName[name]); });

    hooks.tick(function (a, b) { return [a, b]; });
    hooks.tick(function () { throw new Error('handler threw'); });
    hooks.tick(function () { return Symbol('hooked'); });
    hooks.tick(function () { return { toJSON: function (key) { return 'key:' + key; } }; });
    hooks.tick(function () { return undefined; });
    hooks.tick(function () { return 3; });
    hooks.tick(function () { return later('hooked'); });
    hooks.grow(function () { hooks.grow(function () { return 'late'; }); return 'first'; });
    hooks.phased.before(function (x) { return ['before', x]; });
    hooks.phased.after(function (x) { return ['after', x]; });

    events.on('ping', function (x) { return x; });
    events.on('ping', function () { throw new Error('subscriber threw'); });
    events.on('ping', function () { return Symbol('evented'); });
"#;

/// Pending on its first poll, so an async-mode runtime genuinely yields.
struct YieldOnce(bool);

impl std::future::Future for YieldOnce {
    type Output = ();

    fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<()> {
        if self.0 {
            return std::task::Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    }
}

fn runtime(mode: RuntimeMode, fidelity: bool) -> XriptRuntime {
    let mut bindings = HostBindings::new();
    bindings.add_async_function("later", |args: &[Value]| {
        let first = args.first().cloned().unwrap_or(Value::Null);
        async move {
            YieldOnce(false).await;
            Ok(json!({ "later": first }))
        }
    });
    let rt = create_runtime_from_value(
        json!({
            "xript": "0.10",
            "name": "host-entry-parity",
            "limits": { "timeout_ms": 300 },
            "bindings": { "later": { "description": "Settles on a later poll.", "async": true } },
            "hooks": {
                "tick": { "description": "Several handlers." },
                "grow": { "description": "A handler that registers another." },
                "phased": { "description": "Phased.", "phases": ["before", "after"] },
                "odd": { "description": "Entries of every shape." }
            },
            "events": [{ "id": "ping", "description": "Several subscribers." }]
        }),
        RuntimeOptions { mode, value_fidelity: fidelity, host_bindings: bindings, ..Default::default() },
    )
    .expect("runtime builds");
    rt.execute(SETUP).expect("setup runs");
    rt
}

fn exports() -> Vec<(&'static str, Vec<Value>)> {
    vec![
        ("echo", vec![json!(7)]),
        ("echo", vec![json!(7.5)]),
        ("echo", vec![json!("s")]),
        ("echo", vec![Value::Null]),
        ("echo", vec![json!({ "a": { "b": [1, 2.5, "c"] } })]),
        ("echo", vec![json!([1, [2, [3]]])]),
        ("echo", vec![json!({ "$xript": "undefined" })]),
        ("echo", vec![json!({ "$xript": "NaN" })]),
        ("many", vec![json!(1), json!("two"), json!({ "three": 3 })]),
        ("many", vec![]),
        ("nothing", vec![]),
        ("symbol", vec![]),
        ("fn", vec![]),
        ("resolved", vec![]),
        ("rejected", vec![]),
        ("asyncValue", vec![json!(1)]),
        ("thenable", vec![]),
        ("thenThrows", vec![]),
        ("thenGetterThrows", vec![]),
        ("queued", vec![]),
        ("queuedPrimitive", vec![]),
        ("throwsError", vec![]),
        ("throwsTyped", vec![]),
        ("throwsString", vec![]),
        ("throwsNumberMessage", vec![]),
        ("throwsObjectMessage", vec![]),
        ("throwsUndefined", vec![]),
        ("throwsNull", vec![]),
        ("messageGetterThrows", vec![]),
        ("keyed", vec![]),
        ("nestedKeyed", vec![]),
        ("getterThrows", vec![]),
        ("bigint", vec![]),
        ("cyclic", vec![]),
        ("specials", vec![]),
        ("integral", vec![]),
        ("half", vec![]),
        ("negZero", vec![]),
        ("array", vec![]),
        ("missing", vec![]),
        ("awaitsBinding", vec![json!(3)]),
        ("spins", vec![]),
    ]
}

/// Every entry's outcome on one runtime, one line per call, labelled.
fn transcript(mode: RuntimeMode, fidelity: bool) -> Vec<String> {
    let rt = runtime(mode, fidelity);
    let mut lines = Vec::new();
    let mut record = |label: String, outcome: String| lines.push(format!("fidelity={fidelity} {label} => {outcome}"));

    for (name, args) in exports() {
        record(format!("invoke_export {name} {args:?}"), format!("{:?}", rt.invoke_export(name, &args)));
    }

    let payloads: Vec<Vec<Value>> = vec![
        vec![],
        vec![json!(1)],
        vec![json!(1), json!(2)],
        vec![json!({ "b": 1, "a": 2, "10": 3 })],
        vec![json!([1, 2])],
        vec![json!({ "$xript": "undefined" })],
    ];
    for payload in &payloads {
        record(format!("fire_hook tick {payload:?}"), format!("{:?}", rt.fire_hook_tagged("tick", payload)));
    }
    record("fire_hook odd".into(), format!("{:?}", rt.fire_hook_tagged("odd", &[json!(1)])));
    for round in 0..3 {
        record(format!("fire_hook grow #{round}"), format!("{:?}", rt.fire_hook("grow", &[])));
    }
    let data = [None, Some(json!(4)), Some(json!({ "y": 1, "x": 2 })), Some(json!({ "$xript": "undefined" }))];
    for phase in ["before", "after", "", "unknown"] {
        for datum in &data {
            record(
                format!("fire_hook_phase phased/{phase} {datum:?}"),
                format!("{:?}", rt.fire_hook_phase_tagged("phased", phase, datum.as_ref())),
            );
        }
    }
    record("fire_hook undeclared".into(), format!("{:?}", rt.fire_hook("undeclared", &[json!(1)])));

    for payload in [vec![], vec![json!(7)], vec![json!({ "k": [1, 2.5] })]] {
        record(format!("emit ping {payload:?}"), format!("{:?}", rt.emit_tagged("ping", &payload)));
    }
    record("emit unknown".into(), format!("{:?}", rt.emit("unknown", &[json!(1)])));
    lines
}

fn recorded() -> Vec<String> {
    [false, true].into_iter().flat_map(|fidelity| transcript(RuntimeMode::Async, fidelity)).collect()
}

fn golden() -> Vec<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(GOLDEN);
    if std::env::var_os("XRIPT_BLESS").is_some() {
        std::fs::create_dir_all(path.parent().expect("a fixtures directory")).expect("fixtures directory");
        std::fs::write(&path, recorded().join("\n") + "\n").expect("golden transcript written");
    }
    std::fs::read_to_string(&path)
        .expect("golden transcript present")
        .lines()
        .map(str::to_string)
        .collect()
}

fn assert_matches_golden(mode: RuntimeMode) {
    let golden = golden();
    let actual: Vec<String> = [false, true].into_iter().flat_map(|fidelity| transcript(mode, fidelity)).collect();
    assert_eq!(actual.len(), golden.len(), "{mode:?}: the transcript has a different number of calls");
    for (actual, expected) in actual.iter().zip(&golden) {
        assert_eq!(actual, expected, "{mode:?}");
    }
}

#[test]
fn a_sync_runtime_hands_the_host_the_recorded_values() {
    assert_matches_golden(RuntimeMode::Sync);
}

#[test]
fn an_async_runtime_hands_the_host_the_recorded_values() {
    assert_matches_golden(RuntimeMode::Async);
}
