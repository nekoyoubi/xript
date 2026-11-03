//! Conformance against the shared key-order corpus in `spec/`. Authored key
//! order survives the host boundary only with the `preserve_order` feature, so
//! this suite runs only then: `cargo test --features preserve_order`.
#![cfg(feature = "preserve_order")]

use serde::Deserialize;
use xript_runtime::{create_runtime_from_value, HostBindings, RuntimeOptions, XriptRuntime};

const CORPUS: &str = include_str!("../../../spec/key-order-tests.json");

#[derive(Deserialize)]
struct Corpus {
    manifest: serde_json::Value,
    inbound: Vec<Inbound>,
    echo: Vec<Echo>,
    hook: Vec<HookCase>,
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
    expected: String,
}

#[derive(Deserialize)]
struct HookCase {
    name: String,
    data: serde_json::Value,
    expected: String,
}

fn runtime(manifest: &serde_json::Value, host_value: serde_json::Value) -> XriptRuntime {
    let mut bindings = HostBindings::new();
    bindings.add_function("value", move |_: &[serde_json::Value]| Ok(host_value.clone()));
    bindings.add_function("echo", |args: &[serde_json::Value]| Ok(serde_json::Value::Array(args.to_vec())));
    create_runtime_from_value(manifest.clone(), RuntimeOptions { host_bindings: bindings, ..Default::default() })
        .expect("runtime builds")
}

#[test]
fn key_order_corpus() {
    let corpus: Corpus = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();

    for case in corpus.inbound {
        let rt = runtime(&corpus.manifest, case.host_value);
        let script = format!("(function () {{ var v = value(); return ({}); }})()", case.probe);
        let got = rt.execute(&script).map(|r| r.value);
        if got.as_ref().ok() != Some(&serde_json::json!(case.expected)) {
            failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, got));
        }
    }

    for case in corpus.echo {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null);
        let got = rt.execute(&case.script).map(|r| r.value);
        if got.as_ref().ok() != Some(&serde_json::json!(case.expected)) {
            failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, got));
        }
    }

    for case in corpus.hook {
        let rt = runtime(&corpus.manifest, serde_json::Value::Null);
        rt.execute("hooks.probe(function () { return Array.prototype.join.call(arguments, ','); })")
            .expect("handler registers");
        let got = rt.fire_hook("probe", &[case.data]);
        if got.as_ref().ok() != Some(&vec![serde_json::json!(case.expected)]) {
            failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, got));
        }
    }

    assert!(failures.is_empty(), "key order failures:\n{}", failures.join("\n"));
}
