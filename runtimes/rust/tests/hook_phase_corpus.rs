//! Conformance against the shared hook-phase corpus in `spec/`, through every
//! surface that fires a phase: the runtime, a handle, and a pool.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use xript_runtime::{create_runtime_from_value, RuntimeOptions};
#[cfg(feature = "threads")]
use xript_runtime::{PoolConfig, XriptHandle, XriptPool};

const CORPUS: &str = include_str!("../../../spec/hook-phase-tests.json");

#[derive(Deserialize)]
struct Corpus {
    manifest: serde_json::Value,
    #[serde(rename = "mod")]
    filler: Filler,
    setup: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Filler {
    manifest: serde_json::Value,
    source: String,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    hook: String,
    phase: String,
    data: Option<serde_json::Value>,
    expected: Vec<serde_json::Value>,
}

fn corpus() -> Corpus {
    serde_json::from_str(CORPUS).expect("corpus parses")
}

fn filler_sources(corpus: &Corpus) -> HashMap<String, String> {
    HashMap::from([("mod.js".to_string(), corpus.filler.source.clone())])
}

#[test]
fn runtime_fires_one_phase() {
    let corpus = corpus();
    let rt = create_runtime_from_value(corpus.manifest.clone(), RuntimeOptions::default()).unwrap();
    rt.load_mod(&corpus.filler.manifest.to_string(), filler_sources(&corpus), &HashSet::new(), None)
        .unwrap();
    rt.execute(&corpus.setup).unwrap();
    let mut failures = Vec::new();
    for case in &corpus.cases {
        match rt.fire_hook_phase(&case.hook, &case.phase, case.data.as_ref()) {
            Ok(results) if results == case.expected => {}
            Ok(results) => failures.push(format!("{}: expected {:?}, got {:?}", case.name, case.expected, results)),
            Err(error) => failures.push(format!("{}: {error}", case.name)),
        }
        let tagged = rt.fire_hook_phase_tagged(&case.hook, &case.phase, case.data.as_ref()).unwrap();
        let values: Vec<serde_json::Value> = tagged.into_iter().map(|t| t.value).collect();
        if values != case.expected {
            failures.push(format!("{} (tagged): expected {:?}, got {:?}", case.name, case.expected, values));
        }
    }
    assert!(failures.is_empty(), "hook phase failures:\n{}", failures.join("\n"));
}

#[cfg(feature = "threads")]
#[test]
fn handle_fires_one_phase() {
    let corpus = corpus();
    let handle = XriptHandle::new(corpus.manifest.to_string(), RuntimeOptions::default()).unwrap();
    handle
        .load_mod(&corpus.filler.manifest.to_string(), filler_sources(&corpus), &HashSet::new(), None)
        .wait()
        .unwrap();
    handle.execute(&corpus.setup).wait().unwrap();
    for case in &corpus.cases {
        let results = handle.fire_hook_phase(&case.hook, &case.phase, case.data.as_ref()).wait().unwrap();
        assert_eq!(results, case.expected, "{}", case.name);
    }
}

#[cfg(feature = "threads")]
#[test]
fn pool_fires_one_phase() {
    let corpus = corpus();
    let config = PoolConfig { workers: 2, interactive: 1, ..PoolConfig::default() };
    let (pool, ready) = XriptPool::spawn(corpus.manifest.to_string(), |_| RuntimeOptions::default(), config);
    ready.wait().unwrap();
    pool.load_mod(&corpus.filler.manifest.to_string(), filler_sources(&corpus), &HashSet::new(), None)
        .wait()
        .unwrap();
    let mod_manifest = r#"{ "xript": "0.10", "name": "phase-mod", "version": "1.0.0", "entry": { "script": "main.js" } }"#;
    pool.load_mod(mod_manifest, HashMap::new(), &HashSet::new(), Some(&corpus.setup)).wait().unwrap();
    for case in &corpus.cases {
        let results = pool.fire_hook_phase(&case.hook, &case.phase, case.data.as_ref()).wait().unwrap();
        assert_eq!(results, case.expected, "{}", case.name);
    }
}
