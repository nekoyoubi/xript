use serde_json::{json, Value};
use xript_tree::{diff_repeat, resolve_repeat_keys, RepeatKeyProblem, RepeatMode, RepeatPatchOp};

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/repeat-tests.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus is readable"))
        .expect("corpus is valid JSON")
}

fn mode(value: &Value) -> RepeatMode {
    match value.as_str().unwrap() {
        "keyed" => RepeatMode::Keyed,
        "index" => RepeatMode::Index,
        _ => RepeatMode::Replace,
    }
}

fn normalize(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), normalize(v))).collect()),
        other => other.clone(),
    }
}

fn patch_json(patch: &[RepeatPatchOp]) -> Value {
    Value::Array(
        patch
            .iter()
            .map(|op| {
                let mut entry = serde_json::Map::new();
                entry.insert("op".into(), json!(op.op.as_str()));
                entry.insert("key".into(), op.key.clone());
                if let Some(from) = op.from {
                    entry.insert("from".into(), json!(from));
                }
                if let Some(to) = op.to {
                    entry.insert("to".into(), json!(to));
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

#[test]
fn diff_matches_the_corpus() {
    for case in corpus()["diff"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let previous_keys: Vec<Value> = case["previous"]["keys"].as_array().cloned().unwrap_or_default();
        let previous = (!case["previous"].is_null())
            .then(|| (mode(&case["previous"]["mode"]), previous_keys.as_slice()));
        let next_keys = case["next"]["keys"].as_array().cloned().unwrap();
        let patch = diff_repeat(previous, (mode(&case["next"]["mode"]), &next_keys));
        assert_eq!(normalize(&patch_json(&patch)), normalize(&case["patch"]), "{id}");
    }
}

#[test]
fn a_duplicate_key_falls_back_to_index() {
    let resolution = resolve_repeat_keys(vec![json!("a"), json!("a")]);
    assert_eq!(resolution.mode, RepeatMode::Index);
    assert_eq!(resolution.problem, Some(RepeatKeyProblem::DuplicateKey));
}

#[test]
fn a_non_scalar_key_is_invalid() {
    let resolution = resolve_repeat_keys(vec![json!("a"), json!(null)]);
    assert_eq!(resolution.problem, Some(RepeatKeyProblem::InvalidKey));
}

#[test]
fn a_number_and_its_string_are_distinct_keys() {
    let resolution = resolve_repeat_keys(vec![json!(1), json!("1")]);
    assert_eq!(resolution.mode, RepeatMode::Keyed);
}
