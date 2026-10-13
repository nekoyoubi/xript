use serde_json::{json, Value};
use xript_expr::{parse_repeat_header, MAX_REPEAT_COPIES};
use xript_runtime::fragment::{create_fragment_instance, FragmentInstance, FragmentOptions};
use xript_runtime::{
    diff_repeat, FragmentBinding, FragmentDeclaration, FragmentRepeat, FragmentResult, RepeatKey,
    RepeatMode, RepeatPatchOp,
};

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/repeat-tests.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus is readable"))
        .expect("corpus is valid JSON")
}

fn instance(source: &str, names: &[String], interpolate: bool) -> FragmentInstance {
    let declaration = FragmentDeclaration {
        id: "corpus".to_string(),
        slot: "corpus".to_string(),
        format: "text/html".to_string(),
        source: source.to_string(),
        inline: Some(true),
        bindings: Some(
            names
                .iter()
                .map(|name| FragmentBinding { name: name.clone(), path: name.clone(), r#type: None, extensions: Default::default() })
                .collect(),
        ),
        handlers: None,
        events: None,
        priority: None,
        interpolate: Some(interpolate),
    };
    create_fragment_instance(&declaration, source, &FragmentOptions::default()).expect("fragment")
}

/// Keys compare numerically, because a Rust number built from an `f64` and one parsed
/// from the corpus are the same value in different representations.
fn key_json(key: &RepeatKey) -> Value {
    match key {
        Value::Number(n) => json!(n.as_f64().unwrap_or(0.0)),
        other => other.clone(),
    }
}

fn normalize(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap_or(0.0)),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
        }
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
                entry.insert("key".into(), key_json(&op.key));
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

fn repeat_json(repeat: &FragmentRepeat) -> Value {
    json!({
        "site": {
            "template": repeat.site.template,
            "within": repeat.site.within.iter().map(key_json).collect::<Vec<_>>(),
        },
        "path": repeat.path,
        "start": repeat.start,
        "count": repeat.count,
        "expression": repeat.expression,
        "key": repeat.key,
        "mode": repeat.mode.as_str(),
        "keys": repeat.keys.iter().map(key_json).collect::<Vec<_>>(),
        "patch": patch_json(&repeat.patch),
    })
}

fn diagnostics_json(result: &FragmentResult) -> Value {
    Value::Array(
        result
            .diagnostics
            .iter()
            .map(|d| json!({ "code": d.code.as_str(), "path": d.path, "node": d.node, "prop": d.prop }))
            .collect(),
    )
}

fn conditions_json(result: &FragmentResult) -> Value {
    Value::Array(
        result
            .conditions
            .iter()
            .map(|c| json!({ "path": c.path, "expression": c.expression, "visible": c.visible }))
            .collect(),
    )
}

fn binding_names(bindings: &Value) -> Vec<String> {
    bindings.as_object().map(|map| map.keys().cloned().collect()).unwrap_or_default()
}

#[test]
fn copy_ceiling_matches_the_corpus() {
    assert_eq!(MAX_REPEAT_COPIES as u64, corpus()["maxCopies"].as_u64().unwrap());
}

#[test]
fn headers() {
    for case in corpus()["headers"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let parsed = parse_repeat_header(case["source"].as_str().unwrap());
        let expected = &case["expected"];
        if expected.is_null() {
            assert!(parsed.is_err(), "{id}: expected a rejection");
            continue;
        }
        let header = parsed.unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(
            json!({ "item": header.item, "index": header.index, "expression": header.source }),
            *expected,
            "{id}"
        );
    }
}

#[test]
fn render() {
    for case in corpus()["render"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let mut bindings = case["bindings"].clone();
        if let Some(generate) = case.get("generate").and_then(Value::as_object) {
            for (name, count) in generate {
                let items: Vec<Value> = (0..count.as_u64().unwrap()).map(Value::from).collect();
                bindings[name] = Value::Array(items);
            }
        }
        let interpolate = case["interpolate"].as_bool().unwrap_or(false);
        let result = instance(case["source"].as_str().unwrap(), &binding_names(&bindings), interpolate)
            .get_content(&bindings);
        let expected = &case["expected"];
        if let Some(copies) = expected.get("copies") {
            let total: usize = result.repeats.iter().map(|r| r.count).sum();
            assert_eq!(total as u64, copies.as_u64().unwrap(), "{id}");
            assert_eq!(result.repeats.len() as u64, expected["repeats"].as_u64().unwrap(), "{id}");
        } else {
            assert_eq!(result.html, expected["html"].as_str().unwrap(), "{id}");
            assert_eq!(conditions_json(&result), expected["conditions"], "{id}");
            let repeats: Vec<Value> = result.repeats.iter().map(repeat_json).collect();
            assert_eq!(normalize(&Value::Array(repeats)), normalize(&expected["repeats"]), "{id}");
        }
        assert_eq!(diagnostics_json(&result), expected["diagnostics"], "{id}");
    }
}

#[test]
fn updates() {
    for case in corpus()["updates"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let steps = case["steps"].as_array().unwrap();
        let mut names: Vec<String> = Vec::new();
        for step in steps {
            for name in binding_names(&step["bindings"]) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
        let fragment = instance(case["source"].as_str().unwrap(), &names, false);
        for (index, step) in steps.iter().enumerate() {
            let result = fragment.get_content(&step["bindings"]);
            assert_eq!(result.html, step["expected"]["html"].as_str().unwrap(), "{id} step {index}");
            let repeats: Vec<Value> = result.repeats.iter().map(repeat_json).collect();
            assert_eq!(normalize(&Value::Array(repeats)), normalize(&step["expected"]["repeats"]), "{id} step {index}");
        }
    }
}

fn mode(value: &Value) -> RepeatMode {
    match value.as_str().unwrap() {
        "keyed" => RepeatMode::Keyed,
        "index" => RepeatMode::Index,
        _ => RepeatMode::Replace,
    }
}

#[test]
fn diff() {
    for case in corpus()["diff"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let previous_keys: Vec<Value> = case["previous"]["keys"].as_array().cloned().unwrap_or_default();
        let previous = if case["previous"].is_null() {
            None
        } else {
            Some((mode(&case["previous"]["mode"]), previous_keys.as_slice()))
        };
        let next_keys: Vec<Value> = case["next"]["keys"].as_array().cloned().unwrap();
        let patch = diff_repeat(previous, (mode(&case["next"]["mode"]), &next_keys));
        assert_eq!(normalize(&patch_json(&patch)), normalize(&case["patch"]), "{id}");
    }
}

#[test]
fn copies_drop_the_template_attributes_and_keep_the_rest() {
    let source = r#"<li id="row" data-each="x in xs" data-key="x" data-if="x" class="r" data-bind="x"></li>"#;
    let result = instance(source, &["xs".to_string()], false).get_content(&json!({ "xs": ["a"] }));
    let copy = result.tree[0].as_element().unwrap();
    let names: Vec<&str> = copy.props.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, vec!["id", "data-if", "class", "data-bind"]);
}

#[test]
fn a_repeat_reaches_the_rendered_contract() {
    let source = r#"<ul><li data-each="x in xs" data-bind="x"></li></ul>"#;
    let rendered = instance(source, &["xs".to_string()], false)
        .get_content(&json!({ "xs": [1, 2] }))
        .to_rendered();
    assert_eq!(rendered.repeats.len(), 1);
    assert_eq!(rendered.repeats[0].count, 2);
}
