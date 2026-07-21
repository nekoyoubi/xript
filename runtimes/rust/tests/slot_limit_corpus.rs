use serde_json::Value;
use xript_runtime::Manifest;

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/slot-limit-tests.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus is readable"))
        .expect("corpus is valid JSON")
}

/// Every case in the shared corpus, so the rule deciding which budget governs a
/// call into a slot's fills cannot drift from the other three runtimes.
#[test]
fn resolves_every_case_in_the_shared_corpus() {
    let corpus = corpus();
    let cases = corpus["resolve"].as_array().expect("resolve cases");
    assert!(!cases.is_empty(), "corpus carries no cases");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let manifest: Manifest = serde_json::from_value(case["manifest"].clone())
            .unwrap_or_else(|e| panic!("{name}: manifest does not parse: {e}"));
        let hard = case["hardLimits"]["timeout_ms"].as_u64();
        let slot = case["slot"].as_str().expect("slot id");
        let expected = case["expected"].as_u64().expect("expected budget");

        assert_eq!(
            manifest.effective_slot_timeout_ms(slot, hard),
            expected,
            "{name}"
        );
    }
}

/// The corpus carries the canonical `slotExecutionLimits` schema block so the
/// copy in `manifest.schema.json` cannot drift away from it.
#[test]
fn the_schema_block_matches_the_manifest_schema() {
    let corpus = corpus();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/manifest.schema.json");
    let schema: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("schema is readable"))
            .expect("schema is valid JSON");

    let declared = &schema["$defs"]["slotExecutionLimits"]["properties"]["timeout_ms"];
    let canonical = &corpus["schemaBlock"]["properties"]["timeout_ms"];

    assert_eq!(
        declared["type"], canonical["type"],
        "slotExecutionLimits.timeout_ms type drifted from the corpus"
    );
    assert_eq!(
        declared["minimum"], canonical["minimum"],
        "slotExecutionLimits.timeout_ms minimum drifted from the corpus"
    );
    assert_eq!(
        schema["$defs"]["slotExecutionLimits"]["additionalProperties"],
        canonical.get("additionalProperties").cloned().unwrap_or(Value::Bool(false)),
        "slotExecutionLimits stopped refusing unknown keys"
    );
}
