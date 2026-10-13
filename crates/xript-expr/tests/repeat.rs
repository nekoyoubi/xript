use std::collections::HashMap;

use serde_json::{json, Value};
use xript_expr::{evaluate, evaluate_repeat_items, parse_repeat_header, repeat_scope};

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/repeat-tests.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus is readable"))
        .expect("corpus is valid JSON")
}

#[test]
fn headers_match_the_corpus() {
    for case in corpus()["headers"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let parsed = parse_repeat_header(case["source"].as_str().unwrap());
        if case["expected"].is_null() {
            assert!(parsed.is_err(), "{id}: expected a rejection");
            continue;
        }
        let header = parsed.unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(
            json!({ "item": header.item, "index": header.index, "expression": header.source }),
            case["expected"],
            "{id}"
        );
    }
}

#[test]
fn a_non_array_repeats_nothing() {
    let header = parse_repeat_header("x in xs").unwrap();
    for value in [json!("abc"), json!({ "a": 1 }), json!(null), json!(3)] {
        let bindings = HashMap::from([("xs".to_string(), value)]);
        assert!(evaluate_repeat_items(&header, &bindings).is_empty());
    }
}

#[test]
fn the_scope_shadows_and_binds_both_index_names() {
    let header = parse_repeat_header("(item, i) in items").unwrap();
    let bindings = HashMap::from([("item".to_string(), json!("outer"))]);
    let scope = repeat_scope(&bindings, &header, json!("inner"), 2);
    assert_eq!(evaluate("item", &scope), json!("inner"));
    assert_eq!(evaluate("i + $index", &scope).as_f64(), Some(4.0));
    assert_eq!(evaluate("item", &bindings), json!("outer"));
}
