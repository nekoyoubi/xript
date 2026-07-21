//! Declared execution intent, checked against the shared conformance corpus
//! every runtime and the validator answer to.

use xript_runtime::{
    ExecutionIntent, IntentAffinity, IntentDuration, Manifest, ModManifest, ResolvedIntent,
};

const CORPUS: &str = include_str!("../../../spec/execution-tests.json");

fn corpus() -> serde_json::Value {
    serde_json::from_str(CORPUS).expect("the execution corpus is well-formed JSON")
}

fn expected(value: &serde_json::Value) -> ResolvedIntent {
    serde_json::from_value::<ExecutionIntent>(value.clone())
        .expect("an expectation is a well-formed intent")
        .resolved()
}

fn declared(value: &serde_json::Value) -> ExecutionIntent {
    serde_json::from_value(value.clone()).expect("a declared intent is well-formed")
}

#[test]
fn the_schema_defaults_are_brief_and_any() {
    let corpus = corpus();
    let defaults = expected(&corpus["defaults"]);
    assert_eq!(defaults.duration, IntentDuration::Brief);
    assert_eq!(defaults.affinity, IntentAffinity::Any);
    assert_eq!(ResolvedIntent::default(), defaults);
}

#[test]
fn both_axes_are_totally_ordered_as_the_corpus_says() {
    let corpus = corpus();
    let durations: Vec<IntentDuration> = corpus["durationOrder"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| serde_json::from_value(v.clone()).unwrap())
        .collect();
    assert!(durations.windows(2).all(|pair| pair[0] < pair[1]));

    let affinities: Vec<IntentAffinity> = corpus["affinityOrder"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| serde_json::from_value(v.clone()).unwrap())
        .collect();
    assert!(affinities.windows(2).all(|pair| pair[0] < pair[1]));
}

#[test]
fn widen_takes_the_pairwise_maximum_on_every_corpus_case() {
    for case in corpus()["widen"].as_array().unwrap() {
        let a = declared(&case["a"]).resolved();
        let b = declared(&case["b"]).resolved();
        let want = expected(&case["expected"]);
        assert_eq!(
            ResolvedIntent::widen(a, b),
            want,
            "{}",
            case["name"].as_str().unwrap_or("")
        );
        assert_eq!(
            ResolvedIntent::widen(b, a),
            want,
            "widen is symmetric: {}",
            case["name"].as_str().unwrap_or("")
        );
    }
}

#[test]
fn a_surface_resolves_the_way_the_corpus_says() {
    for case in corpus()["resolve"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap_or("");
        let path = case["path"].as_str().unwrap();
        let want = expected(&case["expected"]);
        let got = if path.starts_with("exports/") {
            let manifest: ModManifest = serde_json::from_value(case["manifest"].clone())
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            manifest.execution_of(path)
        } else {
            let manifest: Manifest = serde_json::from_value(case["manifest"].clone())
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            manifest.execution_of(path)
        };
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn a_child_refines_a_base_execution_per_axis() {
    for case in corpus()["extends"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap_or("");
        let base: Manifest = serde_json::from_value(case["base"].clone()).unwrap();
        let child: Manifest = serde_json::from_value(case["child"].clone()).unwrap();
        let merged = ExecutionIntent::refine(base.execution, child.execution)
            .unwrap_or_default()
            .resolved();
        assert_eq!(merged, expected(&case["expected"]), "{name}");
    }
}

/// The full precedence chain: a call-site intent wins alone; otherwise the
/// host slot and the mod export are widened; a missing declaration on either
/// side falls to that manifest's own default and then to the schema's.
#[test]
fn host_and_mod_intents_meet_by_widening() {
    for case in corpus()["precedence"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap_or("");
        let host: Manifest = serde_json::from_value(case["host"].clone()).unwrap();
        let module: ModManifest = serde_json::from_value(case["mod"].clone()).unwrap();
        let call = &case["call"];
        let want = expected(&case["expected"]);

        let got = if let Some(call_site) = call.get("callSite") {
            declared(call_site).resolved()
        } else {
            let host_side = match call.get("slot").and_then(|v| v.as_str()) {
                Some(slot) => host.execution_of(&format!("slots/{slot}")),
                None => host.execution.unwrap_or_default().resolved(),
            };
            let export = call["export"].as_str().unwrap();
            let mod_side = module.execution_of(&format!("exports/{export}"));
            ResolvedIntent::widen(host_side, mod_side)
        };
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn a_mods_aggregate_intent_is_the_widen_over_its_exports() {
    let module: ModManifest = serde_json::from_str(
        r#"{
            "xript": "0.8",
            "name": "mixed",
            "version": "1.0.0",
            "entry": {
                "script": "main.js",
                "exports": {
                    "tick": { "description": "quick", "execution": { "duration": "instant" } },
                    "crunch": { "description": "slow", "execution": { "duration": "long", "affinity": "pinned" } }
                }
            }
        }"#,
    )
    .unwrap();
    assert_eq!(
        module.aggregate_execution(),
        ResolvedIntent {
            duration: IntentDuration::Long,
            affinity: IntentAffinity::Pinned,
        },
        "one long export is enough to make the whole mod long, which is what \
         keeps it off the interactive lane"
    );
}
