//! Values crossing the host boundary that JSON alone cannot carry: BigInt,
//! symbols, strings with lone surrogates, cycles, primitive wrappers, `toJSON`
//! and getters that throw, and values nested a thousand levels deep, with value
//! fidelity on and off. Also the async-function-body shape of `execute_async`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use xript_runtime::{
    create_runtime_from_value, special, Callback, HostBindings, Marker, RuntimeMode, RuntimeOptions,
    XriptError, XriptRuntime, XriptValue, MAX_DEPTH,
};

fn manifest() -> Value {
    json!({
        "xript": "0.10",
        "name": "value-crossing",
        "bindings": {
            "echo": { "description": "Returns its arguments as an array." },
            "value": { "description": "Returns the host's value." },
            "invoke": { "description": "Calls its first argument with the host's value and returns what it returned." },
            "slow": { "description": "Settles with its argument.", "async": true }
        },
        "hooks": { "probe": { "description": "Reports what its handlers receive." } },
        "events": [ { "id": "probed", "description": "Reports what its subscribers receive." } ]
    })
}

struct Probe {
    rt: XriptRuntime,
    received: Arc<Mutex<Vec<Value>>>,
    host_value: Arc<Mutex<Value>>,
    returned: Arc<Mutex<Option<Value>>>,
}

fn probe_in(fidelity: bool, mode: RuntimeMode) -> Probe {
    let received: Arc<Mutex<Vec<Value>>> = Arc::default();
    let host_value: Arc<Mutex<Value>> = Arc::default();
    let returned: Arc<Mutex<Option<Value>>> = Arc::default();
    let mut bindings = HostBindings::new();
    let sink = received.clone();
    bindings.add_function("echo", move |args: &[Value]| {
        *sink.lock().unwrap() = args.to_vec();
        Ok(Value::Array(args.to_vec()))
    });
    let source = host_value.clone();
    bindings.add_function("value", move |_: &[Value]| Ok(source.lock().unwrap().clone()));
    let source = host_value.clone();
    let record = returned.clone();
    bindings.add_function("invoke", move |args: &[Value]| {
        let callback = Callback::from_value(&args[0]).ok_or("not a callback")?;
        let arg = source.lock().unwrap().clone();
        let result = callback.call(&[arg]).map_err(|e| e.to_string())?;
        *record.lock().unwrap() = Some(result.clone());
        Ok(result)
    });
    bindings.add_async_function("slow", |args: &[Value]| {
        let value = args.first().cloned().unwrap_or(Value::Null);
        async move { Ok(value) }
    });
    let rt = create_runtime_from_value(
        manifest(),
        RuntimeOptions { host_bindings: bindings, value_fidelity: fidelity, mode, ..Default::default() },
    )
    .expect("runtime builds");
    Probe { rt, received, host_value, returned }
}

fn probe(fidelity: bool) -> Probe {
    probe_in(fidelity, RuntimeMode::Sync)
}

impl Probe {
    fn run(&self, script: &str) -> Value {
        self.rt.execute(script).unwrap_or_else(|e| panic!("`{script}` failed: {e}")).value
    }

    fn received(&self) -> Vec<Value> {
        self.received.lock().unwrap().clone()
    }

    fn hand(&self, value: Value) {
        *self.host_value.lock().unwrap() = value;
    }
}

fn bigint(digits: &str) -> Value {
    json!({ "$xript": "bigint", "value": digits })
}

fn units(units: &[u16]) -> Value {
    json!({ "$xript": "string", "units": units })
}

#[test]
fn bigints_cross_out_as_markers_with_fidelity() {
    let p = probe(true);
    let result = p.run(
        "var r = echo(10n, -12345678901234567890n, Object(7n), { n: 3n }, [4n]); \
         [r[0] === 10n, r[1] === -12345678901234567890n, r[2] === 7n, r[3].n === 3n, typeof r[4][0]].join('|')",
    );
    assert_eq!(result, json!("true|true|true|true|bigint"));
    assert_eq!(
        p.received(),
        vec![bigint("10"), bigint("-12345678901234567890"), bigint("7"), json!({ "n": bigint("3") }), json!([bigint("4")])]
    );
    assert_eq!(p.run("2n ** 70n"), bigint("1180591620717411303424"));
    assert_eq!(p.run("({ big: -1n })"), json!({ "big": bigint("-1") }));
    assert_eq!(p.received()[0].marker(), Some(Marker::BigInt("10".into())));
}

#[test]
fn bigint_markers_cross_in_as_bigints() {
    let p = probe(true);
    p.hand(json!({ "a": bigint("-90071992547409931"), "b": [bigint("0")] }));
    assert_eq!(
        p.run("var v = value(); [typeof v.a, v.a === -90071992547409931n, v.b[0] === 0n].join('|')"),
        json!("bigint|true|true")
    );
}

#[test]
fn without_fidelity_a_bigint_refuses_naming_the_binding() {
    let p = probe(false);
    for script in ["echo(1n)", "echo({ deep: [2n] })", "echo(Object(3n))"] {
        let message = p.run(&format!("try {{ {script}; 'crossed' }} catch (e) {{ e.message }}"));
        let message = message.as_str().unwrap();
        assert!(message.starts_with("echo(): "), "{script}: {message}");
        assert!(!message.starts_with("echo(): echo(): "), "{script}: {message}");
    }
    assert!(p.received().is_empty());
    assert!(matches!(p.rt.execute("5n"), Err(XriptError::Script(m)) if m.contains("BigInt")));
    p.hand(bigint("5"));
    assert_eq!(p.run("typeof value()"), json!("object"));
}

#[test]
fn a_bigint_with_its_own_to_json_crosses_by_it() {
    let p = probe(false);
    p.run("BigInt.prototype.toJSON = function () { return this.toString() + 'n'; }; echo(5n, { k: 6n })");
    assert_eq!(p.received(), vec![json!("5n"), json!({ "k": "6n" })]);
}

#[test]
fn a_top_level_symbol_argument_crosses_as_its_marker() {
    let p = probe(true);
    p.run("echo(Symbol('token'), Symbol(), Symbol(''), { s: Symbol('x'), keep: 1 }, [Symbol('y')])");
    assert_eq!(
        p.received(),
        vec![
            json!({ "$xript": "symbol", "description": "token" }),
            json!({ "$xript": "symbol" }),
            json!({ "$xript": "symbol", "description": "" }),
            json!({ "keep": 1 }),
            json!([null]),
        ]
    );
    assert_eq!(p.run("({ nested: Symbol('n') })"), json!({}));

    let off = probe(false);
    off.run("echo(Symbol('token'), { s: Symbol('x') }, [Symbol('y')])");
    assert_eq!(off.received(), vec![Value::Null, json!({}), json!([null])]);
}

#[test]
fn a_symbol_result_crosses_as_its_marker() {
    let marker = json!({ "$xript": "symbol", "description": "r" });
    let p = probe(true);
    assert_eq!(p.run("Symbol('r')"), marker);
    assert_eq!(p.run("Symbol()"), json!({ "$xript": "symbol" }));
    assert_eq!(pollster::block_on(p.rt.execute_async("return Symbol('r');")).unwrap().value, marker);
    p.run("hooks.probe(function () { return Symbol('r'); }); events.on('probed', function () { return Symbol('r'); });");
    assert_eq!(p.rt.fire_hook("probe", &[]).unwrap(), vec![marker.clone()]);
    assert_eq!(p.rt.emit("probed", &[]).unwrap(), vec![marker.clone()]);
    p.hand(json!(0));
    p.run("invoke(function () { return Symbol('r'); })");
    assert_eq!(p.returned.lock().unwrap().clone(), Some(marker.clone()));
    p.run("invoke(function () { return [Symbol('nested')]; })");
    assert_eq!(p.returned.lock().unwrap().clone(), Some(json!([null])));

    let off = probe(false);
    assert_eq!(off.run("Symbol('r')"), Value::Null);
    off.run("hooks.probe(function () { return Symbol('r'); })");
    assert_eq!(off.rt.fire_hook("probe", &[]).unwrap(), vec![Value::Null]);
}

#[test]
fn a_callback_return_carries_bigints_and_symbols() {
    let p = probe(true);
    p.hand(json!(0));
    for (returns, expected) in [
        ("12n", bigint("12")),
        ("{ big: -3n, list: [4n] }", json!({ "big": bigint("-3"), "list": [bigint("4")] })),
        ("Symbol('cb')", json!({ "$xript": "symbol", "description": "cb" })),
    ] {
        p.run(&format!("invoke(function () {{ return {returns}; }})"));
        assert_eq!(p.returned.lock().unwrap().take(), Some(expected), "{returns}");
    }
}

const REVOKED: &str = "var revocable = Proxy.revocable({}, {}); revocable.revoke(); var dead = revocable.proxy;";

#[test]
fn a_revoked_proxy_fails_the_crossing_with_the_engines_type_error() {
    for fidelity in [true, false] {
        let p = probe(fidelity);
        p.hand(json!(0));
        for call in [
            "echo(dead)",
            "echo({ inner: [dead] })",
            "invoke(function () { return dead; })",
            "invoke(function () { return { inner: dead }; })",
        ] {
            let result = p.run(&format!(
                "(function () {{ {REVOKED} try {{ {call}; return 'crossed'; }} catch (e) {{ return e instanceof TypeError; }} }})()"
            ));
            assert_eq!(result, json!(true), "fidelity {fidelity}: {call}");
        }
        assert!(p.received().is_empty(), "the host never receives a revoked proxy");
        for result in [format!("(function () {{ {REVOKED} return dead; }})()"), format!("(function () {{ {REVOKED} return [1, {{ d: dead }}]; }})()")] {
            match p.rt.execute(&result) {
                Err(XriptError::Script(message)) => assert!(message.contains("TypeError"), "{message}"),
                other => panic!("fidelity {fidelity}: a revoked proxy result crossed as {other:?}"),
            }
        }
        p.run(&format!("(function () {{ {REVOKED} hooks.probe(function () {{ return dead; }}); }})()"));
        assert!(p.rt.fire_hook("probe", &[]).is_err(), "fidelity {fidelity}: a hook result");
    }
}

#[test]
fn a_symbol_marker_crosses_in_as_a_fresh_symbol() {
    let p = probe(true);
    p.hand(json!([{ "$xript": "symbol", "description": "k" }, { "$xript": "symbol" }]));
    assert_eq!(
        p.run(
            "var v = value(); [typeof v[0], v[0].description, v[0] !== Symbol.for('k'), typeof v[1], v[1].description === undefined, value()[0] !== v[0]].join('|')"
        ),
        json!("symbol|k|true|symbol|true|true")
    );
}

#[test]
fn lone_surrogates_cross_as_code_units_with_fidelity() {
    let p = probe(true);
    let result = p.run(
        "var r = echo('a\\uD800', '\\uDC00b', 'ok \\uD83D\\uDE00', { k: '\\uD83D' }); \
         [r[0] === 'a\\uD800', r[1] === '\\uDC00b', r[2], r[3].k.charCodeAt(0)].join('|')",
    );
    assert_eq!(result, json!("true|true|ok \u{1F600}|55357"));
    assert_eq!(
        p.received(),
        vec![units(&[97, 0xD800]), units(&[0xDC00, 98]), json!("ok \u{1F600}"), json!({ "k": units(&[0xD83D]) })]
    );
    assert_eq!(p.run("'x\\uDFFF'"), units(&[120, 0xDFFF]));
    assert_eq!(p.run("({ s: '\\uD800' })"), json!({ "s": units(&[0xD800]) }));
    assert_eq!(special::utf16(&[97, 0xD800]), units(&[97, 0xD800]));
}

#[test]
fn a_string_marker_crosses_in_as_the_exact_units() {
    let p = probe(true);
    p.hand(units(&[0xD800, 0x41]));
    assert_eq!(
        p.run("var v = value(); [typeof v, v.length, v.charCodeAt(0), v.charCodeAt(1)].join('|')"),
        json!("string|2|55296|65")
    );
}

#[test]
fn without_fidelity_a_lone_surrogate_becomes_the_replacement_character() {
    let p = probe(false);
    p.run("echo('a\\uD800', { k: '\\uDC00' }, ['\\uD83D'], { ['\\uD800']: 1 })");
    assert_eq!(
        p.received(),
        vec![json!("a\u{FFFD}"), json!({ "k": "\u{FFFD}" }), json!(["\u{FFFD}"]), json!({ "\u{FFFD}": 1 })]
    );
    assert_eq!(p.run("'x\\uDFFF'"), json!("x\u{FFFD}"));
    p.hand(units(&[0xD800]));
    assert_eq!(p.run("typeof value()"), json!("object"));
}

#[test]
fn cycles_cross_out_as_back_references_and_shared_values_as_copies() {
    let p = probe(true);
    let result = p.run(
        "var a = { name: 'a' }; a.self = a; \
         var b = [1]; b.push(b); \
         var c = { inner: {} }; c.inner.root = c; \
         var shared = { s: 1 }; \
         var r = echo(a, b, c, { x: shared, y: shared }); \
         [r[0].self === r[0], r[1][1] === r[1], r[2].inner.root === r[2], r[3].x !== r[3].y, r[3].y.s].join('|')",
    );
    assert_eq!(result, json!("true|true|true|true|1"));
    assert_eq!(
        p.received(),
        vec![
            json!({ "name": "a", "self": special::cycle(1) }),
            json!([1, special::cycle(1)]),
            json!({ "inner": { "root": special::cycle(2) } }),
            json!({ "x": { "s": 1 }, "y": { "s": 1 } }),
        ]
    );
    assert_eq!(p.run("var o = { list: [] }; o.list.push(o); o"), json!({ "list": [special::cycle(2)] }));
}

#[test]
fn a_cycle_marker_crosses_in_as_a_real_cycle() {
    let p = probe(true);
    p.hand(json!({ "kids": [{ "parent": special::cycle(3) }], "me": special::cycle(1), "far": special::cycle(9) }));
    assert_eq!(
        p.run("var v = value(); [v.kids[0].parent === v, v.me === v, typeof v.far, v.far.up].join('|')"),
        json!("true|true|object|9")
    );
}

#[test]
fn without_fidelity_a_cycle_refuses_naming_the_binding() {
    let p = probe(false);
    let message = p.run("var a = {}; a.a = a; try { echo([a]); 'crossed' } catch (e) { e.message }");
    assert!(message.as_str().unwrap().starts_with("echo(): "), "{message}");
    assert!(p.received().is_empty());
    assert!(matches!(p.rt.execute("var a = {}; a.a = a; a"), Err(XriptError::Script(_))));
    p.run("var s = { v: 1 }; echo({ x: s, y: s })");
    assert_eq!(p.received(), vec![json!({ "x": { "v": 1 }, "y": { "v": 1 } })]);
}

#[test]
fn primitive_wrappers_unwrap_keeping_special_values() {
    let script = "echo(new Number(NaN), new Number(-0), new Number(Infinity), new String('s'), new Boolean(false), \
                  { n: new Number(5), z: [new Number(-Infinity)] })";
    let on = probe(true);
    on.run(script);
    assert_eq!(
        on.received(),
        vec![
            special::nan(),
            special::neg_zero(),
            special::infinity(),
            json!("s"),
            json!(false),
            json!({ "n": 5, "z": [special::neg_infinity()] }),
        ]
    );
    assert_eq!(on.run("({ a: new Number(NaN), b: [new Number(-0)] })"), json!({ "a": special::nan(), "b": [special::neg_zero()] }));
    assert_eq!(on.run("new Number(Infinity)"), special::infinity());

    let off = probe(false);
    off.run(script);
    assert_eq!(
        off.received(),
        vec![Value::Null, json!(0), Value::Null, json!("s"), json!(false), json!({ "n": 5, "z": [null] })]
    );
}

#[test]
fn a_callback_return_unwraps_wrappers_and_keeps_markers() {
    let p = probe(true);
    p.hand(json!(1));
    p.run("invoke(function () { return { z: new Number(-0), big: 9n, w: new String('w') }; })");
    assert_eq!(
        p.returned.lock().unwrap().clone(),
        Some(json!({ "z": special::neg_zero(), "big": bigint("9"), "w": "w" }))
    );
    p.run("invoke(function () { return new Number(NaN); })");
    assert_eq!(p.returned.lock().unwrap().clone(), Some(special::nan()));
}

#[test]
fn callback_arguments_decode_new_markers() {
    let p = probe(true);
    p.hand(json!({ "n": bigint("-3"), "s": units(&[0xDBFF]), "me": special::cycle(1) }));
    assert_eq!(
        p.run("invoke(function (v) { return [v.n === -3n, v.s.charCodeAt(0), v.me === v].join('|'); })"),
        json!("true|56319|true")
    );
}

#[test]
fn a_throwing_to_json_is_skipped_and_the_object_crosses_by_its_own_properties() {
    for fidelity in [true, false] {
        let p = probe(fidelity);
        p.run(
            "var proto = { toJSON: function () { throw new Error('nope'); } }; \
             var o = Object.create(proto); o.a = 1; \
             echo(o, { inner: o })",
        );
        assert_eq!(p.received(), vec![json!({ "a": 1 }), json!({ "inner": { "a": 1 } })]);
        assert_eq!(p.run("({ a: 2, toJSON: function () { throw 'x'; } })"), json!({ "a": 2 }));
    }
}

#[test]
fn a_to_json_is_applied_with_its_key() {
    let p = probe(false);
    p.run(
        "var keyed = { toJSON: function (k) { return 'key=' + k; } }; \
         echo(keyed, { x: keyed }, [keyed], new Date(0))",
    );
    assert_eq!(
        p.received(),
        vec![json!("key="), json!({ "x": "key=x" }), json!(["key=0"]), json!("1970-01-01T00:00:00.000Z")]
    );
    assert_eq!(p.run("({ toJSON: function (k) { return 'root' + k.length; } })"), json!("root0"));
}

#[test]
fn a_throwing_getter_fails_the_call_with_its_own_error() {
    for fidelity in [true, false] {
        let p = probe(fidelity);
        let setup = "var err = new TypeError('boom'); var o = {}; \
                     Object.defineProperty(o, 'g', { enumerable: true, get: function () { throw err; } });";
        for call in ["echo(o)", "echo({ wrap: [o] })", "echo(1, o)"] {
            let result = p.run(&format!(
                "{setup} try {{ {call}; 'crossed' }} catch (e) {{ (e === err) + ':' + e.name + ':' + e.message }}"
            ));
            assert_eq!(result, json!("true:TypeError:boom"), "fidelity {fidelity}, {call}");
        }
        assert!(p.received().is_empty(), "the host is never reached");
        match p.rt.execute(&format!("{setup} o")) {
            Err(XriptError::Script(message)) => assert!(message.contains("boom"), "{message}"),
            other => panic!("expected the getter's error, got {other:?}"),
        }
    }
}

#[test]
fn a_getter_runs_once_per_crossing() {
    for fidelity in [true, false] {
        let p = probe(fidelity);
        assert_eq!(
            p.run("var n = 0; var o = { get g() { n++; return n; } }; echo(o, { o: o }); n"),
            json!(2)
        );
        assert_eq!(p.received(), vec![json!({ "g": 1 }), json!({ "o": { "g": 2 } })]);
    }
}

fn nested_arrays(depth: usize) -> Value {
    let mut value = json!(0);
    for _ in 0..depth {
        value = Value::Array(vec![value]);
    }
    value
}

fn nested_objects(depth: usize) -> Value {
    let mut value = json!("leaf");
    for _ in 0..depth {
        let mut map = serde_json::Map::new();
        map.insert("c".into(), value);
        value = Value::Object(map);
    }
    value
}

fn depth_of(value: &Value) -> usize {
    let mut depth = 0;
    let mut current = value;
    loop {
        current = match current {
            Value::Array(items) if !items.is_empty() => &items[0],
            Value::Object(map) if map.contains_key("c") => &map["c"],
            _ => return depth,
        };
        depth += 1;
    }
}

/// Drops a deep value without recursing, so the test measures the runtime and
/// not `serde_json`'s own drop.
fn flatten(value: Value) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Array(items) => pending.extend(items),
            Value::Object(map) => pending.extend(map.into_iter().map(|(_, v)| v)),
            _ => {}
        }
    }
}

/// Runs `body` on a thread with stack to spare. The probe's own bindings clone
/// and compare `serde_json::Value`s, which `serde_json` does recursively; that
/// is the harness's cost, not the runtime's, and this keeps it out of the way.
fn roomy<T: Send + 'static>(body: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new().stack_size(64 * 1024 * 1024).spawn(body).unwrap().join().unwrap()
}

const MEASURE: &str = "function depth(x) { var d = 0; while (x !== null && typeof x === 'object') { x = Array.isArray(x) ? x[0] : x.c; d++; } return d; }";

#[test]
fn a_thousand_levels_cross_in_both_directions() {
    roomy(|| {
        for fidelity in [true, false] {
            let p = probe(fidelity);
            let script = format!(
                "{MEASURE} var a = 0; for (var i = 0; i < 1000; i++) a = [a]; \
                 var o = 'leaf'; for (var j = 0; j < 1000; j++) o = {{ c: o }}; \
                 var r = echo(a, o); [depth(r[0]), depth(r[1])].join('|')"
            );
            assert_eq!(p.run(&script), json!("1000|1000"), "fidelity {fidelity}");
            let received = std::mem::take(&mut *p.received.lock().unwrap());
            assert_eq!(received.iter().map(depth_of).collect::<Vec<_>>(), vec![1000, 1000]);
            received.into_iter().for_each(flatten);

            p.hand(json!([nested_arrays(999), nested_objects(999)]));
            assert_eq!(
                p.run(&format!("{MEASURE} var v = value(); [depth(v[0]), depth(v[1])].join('|')")),
                json!("999|999")
            );
            flatten(std::mem::take(&mut *p.host_value.lock().unwrap()));

            let result = p.run("var a = 0; for (var i = 0; i < 1000; i++) a = [a]; a");
            assert_eq!(depth_of(&result), 1000);
            flatten(result);
        }
    });
}

#[test]
fn a_thousand_levels_cross_through_callbacks() {
    roomy(|| {
        let p = probe(true);
        p.hand(nested_objects(1000));
        assert_eq!(
            p.run(&format!(
                "{MEASURE} invoke(function (v) {{ var r = 0; for (var i = 0; i < 1000; i++) r = [r]; return [depth(v), r]; }})[0]"
            )),
            json!(1000)
        );
        let returned = p.returned.lock().unwrap().take().unwrap();
        assert_eq!(depth_of(&returned[1]), 1000);
        flatten(returned);
        flatten(std::mem::take(&mut *p.host_value.lock().unwrap()));
    });
}

#[test]
fn past_the_depth_limit_the_crossing_fails_naming_the_binding() {
    roomy(|| {
        for fidelity in [true, false] {
            let p = probe(fidelity);
            let message = p.run(&format!(
                "var a = 0; for (var i = 0; i < {}; i++) a = [a]; try {{ echo(a); 'crossed' }} catch (e) {{ e.message }}",
                MAX_DEPTH + 1
            ));
            assert!(message.as_str().unwrap().starts_with("echo(): "), "{message}");
            assert!(p.received().is_empty());

            p.hand(nested_arrays(MAX_DEPTH + 1));
            let message = p.run("try { value(); 'crossed' } catch (e) { e.message }");
            assert!(message.as_str().unwrap().starts_with("value(): "), "{message}");
            flatten(std::mem::take(&mut *p.host_value.lock().unwrap()));

            assert!(matches!(
                p.rt.execute(&format!("var a = 0; for (var i = 0; i < {}; i++) a = [a]; a", MAX_DEPTH + 1)),
                Err(XriptError::Script(_))
            ));
        }
    });
}

/// Values exactly `MAX_DEPTH` deep cross every way on a 1 MiB stack, with
/// bindings that never recurse over them, so any native recursion over the
/// depth would be the runtime's own.
#[test]
fn the_deepest_value_allowed_needs_no_deep_native_stack() {
    let worker = std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(|| {
            let seen: Arc<Mutex<Vec<usize>>> = Arc::default();
            let mut bindings = HostBindings::new();
            let sink = seen.clone();
            bindings.add_function("echo", move |args: &[Value]| {
                sink.lock().unwrap().push(depth_of(&args[0]));
                Ok(Value::Null)
            });
            bindings.add_function("value", |_: &[Value]| Ok(nested_objects(MAX_DEPTH)));
            let sink = seen.clone();
            bindings.add_function("invoke", move |args: &[Value]| {
                let callback = Callback::from_value(&args[0]).ok_or("not a callback")?;
                let arg = [nested_objects(MAX_DEPTH)];
                let returned = callback.call(&arg).map_err(|e| e.to_string());
                arg.into_iter().for_each(flatten);
                let returned = returned?;
                sink.lock().unwrap().push(depth_of(&returned));
                flatten(returned);
                Ok(Value::Null)
            });
            let rt = create_runtime_from_value(
                manifest(),
                RuntimeOptions { host_bindings: bindings, value_fidelity: true, ..Default::default() },
            )
            .unwrap();
            rt.execute("hooks.probe(function (v) { var r = 'x'; for (var i = 0; i < 1022; i++) r = { c: r }; return r; })")
                .unwrap();
            let build = format!("var o = 'leaf'; for (var i = 0; i < {MAX_DEPTH}; i++) o = {{ c: o }};");
            let script = format!(
                "{MEASURE} {build} echo(o); var v = value(); \
                 invoke(function (arg) {{ return {{ c: arg.c }}; }}); depth(v)"
            );
            let in_script = rt.execute(&script).unwrap().value;
            let result = rt.execute(&format!("{build} o")).unwrap().value;
            let result_depth = depth_of(&result);
            flatten(result);
            let hooked = rt.fire_hook("probe", &[Value::Null]).unwrap();
            let hook_depth = depth_of(&hooked[0]);
            hooked.into_iter().for_each(flatten);
            (in_script, result_depth, hook_depth, seen.lock().unwrap().clone())
        })
        .unwrap();
    assert_eq!(
        worker.join().unwrap(),
        (json!(MAX_DEPTH), MAX_DEPTH, 1022, vec![MAX_DEPTH, MAX_DEPTH])
    );
}

#[test]
fn hook_and_event_payloads_carry_the_new_markers() {
    let p = probe(true);
    p.run(
        "hooks.probe(function (v) { return [typeof v.n, v.me === v, v.s.length]; }); \
         events.on('probed', function (v) { var o = { big: v.n * 2n }; o.self = o; return o; });",
    );
    let payload = json!({ "n": bigint("21"), "me": special::cycle(1), "s": units(&[0xD800]) });
    assert_eq!(p.rt.fire_hook("probe", &[payload.clone(), Value::Null]).unwrap(), vec![json!(["bigint", true, 1])]);
    assert_eq!(
        p.rt.emit("probed", &[payload, Value::Null]).unwrap(),
        vec![json!({ "big": bigint("42"), "self": special::cycle(1) })]
    );
}

#[test]
fn async_bindings_read_their_arguments_the_same_way() {
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        let p = probe_in(true, mode);
        let result = pollster::block_on(
            p.rt.execute_async("var o = { n: 5n }; o.o = o; var r = await slow(o); return [r.n === 5n, r.o === r].join('|');"),
        )
        .unwrap();
        assert_eq!(result.value, json!("true|true"), "{mode:?}");
        let message = pollster::block_on(p.rt.execute_async(
            "var err = new Error('late'); var o = { get g() { throw err; } }; try { await slow(o); return 'crossed'; } catch (e) { return e === err; }",
        ))
        .unwrap();
        assert_eq!(message.value, json!(true), "{mode:?}");
    }
}

#[test]
fn execute_async_runs_an_async_function_body() {
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        for fidelity in [true, false] {
            let p = probe_in(fidelity, mode);
            let run = |code: &str| pollster::block_on(p.rt.execute_async(code)).unwrap().value;
            assert_eq!(run("return 41 + 1;"), json!(42), "{mode:?}");
            assert_eq!(run("const x = await Promise.resolve(5);\nreturn x * 2;"), json!(10), "{mode:?}");
            assert_eq!(run("return await slow('awaited');"), json!("awaited"), "{mode:?}");
            assert_eq!(run("return 'trailing'; // a comment on the last line"), json!("trailing"), "{mode:?}");
            let bare = run("40 + 2");
            assert!(if fidelity { bare.is_undefined() } else { bare.is_null() }, "{mode:?}: {bare}");
            let within = pollster::block_on(p.rt.execute_within_async("await null; return 'within';", Some(1_000)));
            assert_eq!(within.unwrap().value, json!("within"), "{mode:?}");
            let thrown = pollster::block_on(p.rt.execute_async("await null; throw new Error('body threw');"));
            assert!(matches!(thrown, Err(XriptError::Script(ref m)) if m.contains("body threw")), "{thrown:?}");
        }
    }
}

#[test]
fn local_bindings_cross_values_the_same_way() {
    let received = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let sink = received.clone();
    let mut local = xript_runtime::LocalHostBindings::new();
    local.add_function("echo", move |args: &[Value]| {
        *sink.borrow_mut() = args.to_vec();
        Ok(Value::Array(args.to_vec()))
    });
    let rt = xript_runtime::create_local_runtime(
        &manifest().to_string(),
        RuntimeOptions { value_fidelity: true, ..Default::default() },
        local,
    )
    .unwrap();
    let result = rt
        .execute("var o = { n: 1n, s: '\\uD800' }; o.o = o; var r = echo(o, new Number(-0))[0]; [r.n === 1n, r.o === r, r.s.length].join('|')")
        .unwrap();
    assert_eq!(result.value, json!("true|true|1"));
    assert_eq!(
        *received.borrow(),
        vec![json!({ "n": bigint("1"), "s": units(&[0xD800]), "o": special::cycle(1) }), special::neg_zero()]
    );
}

#[cfg(feature = "threads")]
#[test]
fn a_pool_carries_the_new_markers() {
    use xript_runtime::{PoolConfig, XriptPool};
    let (pool, ready) = XriptPool::spawn(
        manifest().to_string(),
        |_| {
            let mut bindings = HostBindings::new();
            bindings.add_function("value", |_: &[Value]| Ok(json!({ "n": bigint("8"), "me": special::cycle(1) })));
            RuntimeOptions { host_bindings: bindings, value_fidelity: true, ..Default::default() }
        },
        PoolConfig { workers: 2, interactive: 1, ..PoolConfig::default() },
    );
    ready.wait().unwrap();
    assert_eq!(pool.execute("var v = value(); [v.n === 8n, v.me === v].join('|')").wait().unwrap().value, json!("true|true"));
    assert_eq!(
        pool.execute("var o = { n: -2n, s: '\\uDC00' }; o.self = o; o").wait().unwrap().value,
        json!({ "n": bigint("-2"), "s": units(&[0xDC00]), "self": special::cycle(1) })
    );
}

#[test]
fn execute_awaits_a_promise_result() {
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        let p = probe_in(false, mode);
        assert_eq!(p.run("Promise.resolve(5)"), json!(5), "{mode:?}");
        assert_eq!(p.run("(async () => { await null; return 'later'; })()"), json!("later"), "{mode:?}");
        assert_eq!(p.run("slow('settled')"), json!("settled"), "{mode:?}");
        let rejected = p.rt.execute("Promise.reject(new Error('refused'))");
        assert!(matches!(rejected, Err(XriptError::Script(ref m)) if m.contains("refused")), "{rejected:?}");
    }
}
