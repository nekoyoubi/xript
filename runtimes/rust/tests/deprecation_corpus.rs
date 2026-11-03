//! The deprecation channel, checked against the shared corpus every runtime
//! answers to.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use xript_runtime::{create_runtime_from_value, Deprecation, HostBindings, HostNamespaceMember, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/deprecation-tests.json");

fn host(case: &Value) -> HostBindings {
    let mut bindings = HostBindings::new();
    let mut namespaces: HashMap<String, HashMap<String, HostNamespaceMember>> = HashMap::new();
    for path in case["provided"].as_array().unwrap() {
        let path = path.as_str().unwrap();
        match path.split_once('.') {
            Some((ns, member)) => {
                namespaces
                    .entry(ns.to_string())
                    .or_default()
                    .insert(member.to_string(), HostNamespaceMember::Function(Arc::new(|_| Ok(json!(null)))));
            }
            None => bindings.add_function(path, |_: &[Value]| Ok(json!(null))),
        }
    }
    for (name, members) in namespaces {
        bindings.add_nested_namespace(name, members);
    }
    bindings
}

fn notices(case: &Value) -> Vec<Value> {
    let seen: Arc<Mutex<Vec<Deprecation>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    create_runtime_from_value(
        case["manifest"].clone(),
        RuntimeOptions {
            host_bindings: host(case),
            on_deprecation: Some(Arc::new(move |notice: &Deprecation| sink.lock().unwrap().push(notice.clone()))),
            ..Default::default()
        },
    )
    .unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
    let recorded = seen.lock().unwrap().clone();
    recorded
        .into_iter()
        .map(|n| json!({ "code": n.code, "message": n.message, "replacement": n.replacement }))
        .collect()
}

#[test]
fn every_corpus_case_holds() {
    let corpus: Value = serde_json::from_str(CORPUS).expect("the deprecation corpus is well-formed JSON");
    let cases = corpus["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let runtimes = case.get("runtimes").and_then(|v| v.as_u64()).unwrap_or(1);
        for _ in 0..runtimes {
            assert_eq!(notices(case), case["expect"].as_array().unwrap().clone(), "{}", case["name"]);
        }
    }
}
