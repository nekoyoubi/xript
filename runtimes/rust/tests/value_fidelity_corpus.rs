//! Conformance against the shared value-fidelity corpus in `spec/`, with
//! `value_fidelity` on: values JSON cannot spell cross the host boundary as
//! markers and arrive in script as themselves. The `depth` cases also run with
//! it off, all but the one that asserts a marker.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use xript_runtime::{create_runtime_from_value, Callback, HostBindings, RuntimeOptions, XriptRuntime};

const CORPUS: &str = include_str!("../../../spec/value-fidelity-tests.json");

#[derive(Deserialize, Default)]
#[serde(default)]
struct Corpus {
    manifest: serde_json::Value,
    inbound: Vec<Inbound>,
    echo: Vec<Echo>,
    results: Vec<ResultCase>,
    hook: Vec<HookCase>,
    event: Vec<HookCase>,
    #[serde(rename = "eventResult")]
    event_result: Vec<EventResult>,
    sink: Vec<SinkCase>,
    depth: Vec<DepthCase>,
    prefix: Vec<PrefixCase>,
    #[serde(rename = "callbackResult")]
    callback_result: Vec<CallbackResultCase>,
}

#[derive(Deserialize)]
struct SinkCase {
    name: String,
    script: String,
    received: Option<Vec<serde_json::Value>>,
    expected: String,
}

#[derive(Deserialize)]
struct DepthCase {
    name: String,
    direction: String,
    shape: String,
    depth: usize,
    script: String,
    expected: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct PrefixCase {
    name: String,
    script: String,
    prefix: String,
}

#[derive(Deserialize)]
struct EventResult {
    name: String,
    returns: String,
    expected: serde_json::Value,
}

#[derive(Deserialize)]
struct Inbound {
    name: String,
    #[serde(rename = "hostValue")]
    host_value: serde_json::Value,
    probe: String,
    expected: String,
}

#[derive(Deserialize)]
struct Echo {
    name: String,
    script: String,
    received: Vec<serde_json::Value>,
    expected: String,
}

#[derive(Deserialize)]
struct ResultCase {
    name: String,
    script: String,
    #[serde(default)]
    expected: serde_json::Value,
    #[serde(default)]
    fails: bool,
}

#[derive(Deserialize)]
struct CallbackResultCase {
    name: String,
    returns: String,
    #[serde(default)]
    expected: serde_json::Value,
    error: Option<String>,
}

#[derive(Deserialize)]
struct HookCase {
    name: String,
    data: serde_json::Value,
    expected: String,
}

fn corpus() -> Corpus {
    serde_json::from_str(CORPUS).expect("corpus parses")
}

/// What the corpus bindings saw: `echo`'s arguments, `sink`'s arguments
/// (`None` until it is called), and what `call`'s callback returned.
#[derive(Clone, Default)]
struct Records {
    received: Arc<Mutex<Vec<serde_json::Value>>>,
    sunk: Arc<Mutex<Option<Vec<serde_json::Value>>>>,
    called: Arc<Mutex<Option<serde_json::Value>>>,
}

fn runtime(
    manifest: &serde_json::Value,
    host_value: serde_json::Value,
    received: Arc<Mutex<Vec<serde_json::Value>>>,
) -> XriptRuntime {
    runtime_with(manifest, move || host_value.clone(), Records { received, ..Default::default() }, true)
}

/// The corpus's four bindings: `value` hands over what `host_value` builds,
/// `echo` records and returns its arguments, `sink` records them and returns
/// nothing, and `call` calls its function argument, records what it returned
/// and returns it, letting any failure escape.
fn runtime_with(
    manifest: &serde_json::Value,
    host_value: impl Fn() -> serde_json::Value + Send + Sync + 'static,
    records: Records,
    fidelity: bool,
) -> XriptRuntime {
    let mut bindings = HostBindings::new();
    let Records { received, sunk, called } = records;
    bindings.add_function("value", move |_: &[serde_json::Value]| Ok(host_value()));
    bindings.add_function("echo", move |args: &[serde_json::Value]| {
        *received.lock().unwrap() = args.to_vec();
        Ok(serde_json::Value::Array(args.to_vec()))
    });
    bindings.add_function("sink", move |args: &[serde_json::Value]| {
        *sunk.lock().unwrap() = Some(args.to_vec());
        Ok(xript_runtime::special::undefined())
    });
    bindings.add_function("call", move |args: &[serde_json::Value]| {
        let callback = args.first().and_then(Callback::from_value).ok_or("call(): expected a function")?;
        let returned = callback.call(&[]).map_err(|error| error.to_string())?;
        *called.lock().unwrap() = Some(returned.clone());
        Ok(returned)
    });
    create_runtime_from_value(
        manifest.clone(),
        RuntimeOptions { host_bindings: bindings, value_fidelity: fidelity, ..Default::default() },
    )
    .expect("runtime builds")
}

#[test]
fn inbound_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.inbound {
        let rt = runtime(&corpus.manifest, case.host_value, Arc::default());
        let script = format!("(function () {{ var v = value(); return ({}); }})()", case.probe);
        match rt.execute(&script) {
            Ok(result) if result.value == serde_json::json!(case.expected) => {}
            Ok(result) => failures.push(format!("{}: expected {:?}, got {}", case.name, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "inbound failures:\n{}", failures.join("\n"));
}

#[test]
fn echo_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.echo {
        let received = Arc::new(Mutex::new(Vec::new()));
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, received.clone());
        match rt.execute(&case.script) {
            Ok(result) if result.value == serde_json::json!(case.expected) => {}
            Ok(result) => failures.push(format!("{}: expected {:?}, got {}", case.name, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
        let got = received.lock().unwrap().clone();
        if got != case.received {
            failures.push(format!("{}: host received {:?}, expected {:?}", case.name, got, case.received));
        }
    }
    assert!(failures.is_empty(), "echo failures:\n{}", failures.join("\n"));
}

#[test]
fn result_cases() {
    let corpus = corpus();
    let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
    let mut failures = Vec::new();
    for case in corpus.results {
        match (rt.execute(&case.script), case.fails) {
            (Err(_), true) => {}
            (Ok(result), true) => failures.push(format!("{}: expected the call to fail, got {}", case.name, result.value)),
            (Ok(result), false) if result.value == case.expected => {}
            (Ok(result), false) => failures.push(format!("{}: expected {:?}, got {}", case.name, case.expected, result.value)),
            (Err(error), false) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "result failures:\n{}", failures.join("\n"));
}

#[test]
fn hook_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.hook {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
        rt.execute(
            "hooks.probe(function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })",
        )
        .expect("handler registers");
        match rt.fire_hook("probe", &[case.data]) {
            Ok(results) if results == vec![serde_json::json!(case.expected)] => {}
            Ok(results) => failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, results)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "hook failures:\n{}", failures.join("\n"));
}

#[test]
fn event_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.event {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
        rt.execute(
            "events.on('probed', function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })",
        )
        .expect("subscriber registers");
        match rt.emit("probed", &[case.data]) {
            Ok(results) if results == vec![serde_json::json!(case.expected)] => {}
            Ok(results) => failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, results)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    for case in corpus.event_result {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
        rt.execute(&format!("events.on('probed', function () {{ return {}; }})", case.returns))
            .expect("subscriber registers");
        match rt.emit("probed", &[]) {
            Ok(results) if results == vec![case.expected.clone()] => {}
            Ok(results) => failures.push(format!("{}: expected {}, got {:?}", case.name, case.expected, results)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "event failures:\n{}", failures.join("\n"));
}

#[test]
fn negative_zero_crosses_at_any_depth() {
    let corpus = corpus();
    let received = Arc::new(Mutex::new(Vec::new()));
    let rt = runtime(&corpus.manifest, serde_json::Value::Null, received.clone());
    let result = rt
        .execute("(function () { var r = echo({ z: -0, list: [-0, 1] }); return [Object.is(r[0].z, -0), Object.is(r[0].list[0], -0)].join('|'); })()")
        .unwrap();
    assert_eq!(result.value, serde_json::json!("true|true"));
    let neg_zero = xript_runtime::special::neg_zero();
    assert_eq!(
        *received.lock().unwrap(),
        vec![serde_json::json!({ "z": neg_zero.clone(), "list": [neg_zero.clone(), 1] })]
    );
    assert_eq!(rt.execute("({ z: -0 })").unwrap().value, serde_json::json!({ "z": neg_zero }));
}

#[test]
fn without_fidelity_specials_are_null() {
    let corpus = corpus();
    let mut bindings = HostBindings::new();
    let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = received.clone();
    bindings.add_function("value", |_: &[serde_json::Value]| Ok(serde_json::json!({ "$xript": "NaN" })));
    bindings.add_function("echo", move |args: &[serde_json::Value]| {
        *sink.lock().unwrap() = args.to_vec();
        Ok(serde_json::Value::Null)
    });
    let rt = create_runtime_from_value(
        corpus.manifest,
        RuntimeOptions { host_bindings: bindings, ..Default::default() },
    )
    .unwrap();
    assert_eq!(rt.execute("undefined").unwrap().value, serde_json::Value::Null);
    assert_eq!(rt.execute("0 / 0").unwrap().value, serde_json::Value::Null);
    rt.execute("echo(Infinity, undefined, 1)").unwrap();
    assert_eq!(*received.lock().unwrap(), vec![serde_json::Value::Null, serde_json::Value::Null, serde_json::json!(1)]);
    assert_eq!(rt.execute("typeof value()").unwrap().value, serde_json::json!("object"));
    let negative_zero = rt.execute("-0").unwrap().value;
    assert!(negative_zero.as_f64().is_some_and(|n| n == 0.0 && n.is_sign_negative()), "got {negative_zero:?}");
    rt.execute("echo(-0)").unwrap();
    assert_eq!(*received.lock().unwrap(), vec![serde_json::json!(0)]);
}

#[test]
fn sink_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.sink {
        let records = Records::default();
        let rt = runtime_with(&corpus.manifest, || serde_json::Value::Null, records.clone(), true);
        match rt.execute(&case.script) {
            Ok(result) if result.value == serde_json::json!(case.expected) => {}
            Ok(result) => failures.push(format!("{}: expected {:?}, got {}", case.name, case.expected, result.value)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
        let got = records.sunk.lock().unwrap().clone();
        if got != case.received {
            failures.push(format!("{}: sink received {:?}, expected {:?}", case.name, got, case.received));
        }
    }
    assert!(failures.is_empty(), "sink failures:\n{}", failures.join("\n"));
}

#[test]
fn callback_result_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.callback_result {
        let records = Records::default();
        let rt = runtime_with(&corpus.manifest, || serde_json::Value::Null, records.clone(), true);
        if let Some(error) = &case.error {
            let script = format!(
                "(function () {{ try {{ call(function () {{ return {}; }}); return 'crossed'; }} catch (e) {{ return e.name; }} }})()",
                case.returns
            );
            match rt.execute(&script) {
                Ok(result) if result.value == serde_json::json!(error) => {}
                Ok(result) => failures.push(format!("{}: expected {error:?}, got {}", case.name, result.value)),
                Err(failure) => failures.push(format!("{}: {failure}", case.name)),
            }
            continue;
        }
        if let Err(error) = rt.execute(&format!("call(function () {{ return {}; }})", case.returns)) {
            failures.push(format!("{}: {error}", case.name));
            continue;
        }
        let got = records.called.lock().unwrap().clone();
        if got.as_ref() != Some(&case.expected) {
            failures.push(format!("{}: the host recorded {:?}, expected {:?}", case.name, got, case.expected));
        }
    }
    assert!(failures.is_empty(), "callbackResult failures:\n{}", failures.join("\n"));
}

#[test]
fn prefix_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for case in corpus.prefix {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null, Arc::default());
        match rt.execute(&case.script) {
            Ok(result) => {
                let message = result.value.as_str().unwrap_or_default().to_string();
                let twice = format!("{0}{0}", case.prefix);
                if !message.starts_with(&case.prefix) || message.starts_with(&twice) {
                    failures.push(format!("{}: message {message:?} must begin with {:?} once", case.name, case.prefix));
                }
            }
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
    }
    assert!(failures.is_empty(), "prefix failures:\n{}", failures.join("\n"));
}

/// A value `depth` containers deep of `shape`, the innermost holding `0`,
/// built without recursing.
fn nested(shape: &str, depth: usize) -> serde_json::Value {
    let mut value = serde_json::json!(0);
    for _ in 0..depth {
        value = match shape {
            "array" => serde_json::Value::Array(vec![value]),
            _ => {
                let mut map = serde_json::Map::new();
                map.insert("d".into(), value);
                serde_json::Value::Object(map)
            }
        };
    }
    value
}

/// How many containers of `shape` `value` nests before reaching `0`, or
/// `None` when it reaches anything else.
fn nesting(shape: &str, value: &serde_json::Value) -> Option<usize> {
    let mut depth = 0;
    let mut current = value;
    loop {
        current = match (shape, current) {
            ("array", serde_json::Value::Array(items)) if items.len() == 1 => &items[0],
            ("object", serde_json::Value::Object(map)) => map.get("d")?,
            (_, leaf) => return (*leaf == serde_json::json!(0)).then_some(depth),
        };
        depth += 1;
    }
}

/// Drops `value` without recursing, so a 100000-level case costs the runner no
/// native stack either.
fn discard(value: serde_json::Value) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            serde_json::Value::Array(items) => pending.extend(items),
            serde_json::Value::Object(map) => pending.extend(map.into_iter().map(|(_, item)| item)),
            _ => {}
        }
    }
}

/// Runs on a thread with stack to spare: the runner's own bindings clone and
/// compare deep `serde_json::Value`s, which `serde_json` does recursively.
#[test]
fn depth_cases() {
    std::thread::Builder::new().stack_size(64 * 1024 * 1024).spawn(run_depth_cases).unwrap().join().unwrap();
}

fn run_depth_cases() {
    let corpus = corpus();
    let mut failures = Vec::new();
    for fidelity in [true, false] {
        for case in &corpus.depth {
            if !fidelity && case.script.contains("undefined") {
                continue;
            }
            let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
            let (shape, depth) = (case.shape.clone(), case.depth);
            let inbound = case.direction == "inbound";
            let rt = runtime_with(
                &corpus.manifest,
                move || if inbound { nested(&shape, depth) } else { serde_json::Value::Null },
                Records { received: received.clone(), ..Default::default() },
                fidelity,
            );
            let label = format!("{} (fidelity {fidelity})", case.name);
            let message = match rt.execute(&case.script) {
                Ok(result) => result.value.as_str().unwrap_or_default().to_string(),
                Err(error) => {
                    failures.push(format!("{label}: {error}"));
                    continue;
                }
            };
            if let Some(expected) = &case.expected
                && &message != expected
            {
                failures.push(format!("{label}: expected {expected:?}, got {message:?}"));
            }
            if let Some(prefix) = &case.error
                && !message.starts_with(prefix.as_str())
            {
                failures.push(format!("{label}: message {message:?} must begin with {prefix:?}"));
            }
            let echoed = std::mem::take(&mut *received.lock().unwrap());
            if case.direction == "outbound" && case.expected.is_some() {
                let got = echoed.first().and_then(|value| nesting(&case.shape, value));
                if got != Some(case.depth) {
                    failures.push(format!("{label}: echo received {got:?} levels, expected {}", case.depth));
                }
            }
            echoed.into_iter().for_each(discard);
        }
    }
    assert!(failures.is_empty(), "depth failures:\n{}", failures.join("\n"));
}
