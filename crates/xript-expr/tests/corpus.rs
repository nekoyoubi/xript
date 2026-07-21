use std::collections::HashMap;

use serde_json::Value;
use xript_expr::{
    contains_interpolation, evaluate, evaluate_condition, expression_kind, parse, render,
    resolve_segments, segment_text, segments_to_source, ExpressionKind, TextSegment,
};

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/expression-tests.json");
    let text = std::fs::read_to_string(path).expect("expression corpus is readable");
    serde_json::from_str(&text).expect("expression corpus is valid JSON")
}

fn bindings_from(value: &Value) -> HashMap<String, Value> {
    value
        .as_object()
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Numeric equality across JSON's integer/float split: the corpus writes `35`, an
/// evaluator that went through `f64` writes `35.0`, and both mean the same number.
fn values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) => (x - y).abs() < 1e-9,
            _ => false,
        },
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| values_equal(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter().all(|(k, v)| b.get(k).map(|other| values_equal(v, other)).unwrap_or(false))
        }
        _ => left == right,
    }
}

fn segments_from(value: &Value) -> Vec<TextSegment> {
    value
        .as_array()
        .expect("segments is an array")
        .iter()
        .map(|entry| {
            let kind = entry["kind"].as_str().expect("segment kind");
            if kind == "literal" {
                TextSegment::Literal(entry["value"].as_str().unwrap().to_string())
            } else {
                TextSegment::Expr(entry["source"].as_str().unwrap().to_string())
            }
        })
        .collect()
}

#[test]
fn corpus_evaluation() {
    let corpus = corpus();
    let defaults = bindings_from(&corpus["defaultBindings"]);
    let mut failures = Vec::new();

    for case in corpus["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let expression = case["expression"].as_str().unwrap();
        let bindings =
            if case.get("bindings").is_some() { bindings_from(&case["bindings"]) } else { defaults.clone() };
        let actual = evaluate(expression, &bindings);
        if !values_equal(&actual, &case["expect"]) {
            failures.push(format!("{id}: `{expression}` -> {actual} (expected {})", case["expect"]));
        }
    }

    assert!(failures.is_empty(), "{} case(s) diverged:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn corpus_rejects() {
    let corpus = corpus();
    let defaults = bindings_from(&corpus["defaultBindings"]);
    let mut failures = Vec::new();

    for case in corpus["rejects"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let expression = case["expression"].as_str().unwrap();
        if parse(expression).is_ok() {
            failures.push(format!("{id}: `{expression}` parsed but must not"));
        }
        if evaluate(expression, &defaults) != Value::Null {
            failures.push(format!("{id}: `{expression}` evaluated to something"));
        }
        if evaluate_condition(expression, &defaults) {
            failures.push(format!("{id}: `{expression}` was truthy"));
        }
    }

    assert!(failures.is_empty(), "{} reject(s) leaked:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn corpus_interpolation() {
    let corpus = corpus();
    let mut failures = Vec::new();

    for case in corpus["interpolation"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        let result = segment_text(text);

        if case.get("invalid").and_then(Value::as_bool).unwrap_or(false) {
            if result.issues.is_empty() {
                failures.push(format!("{id}: expected a segmentation issue"));
            }
            continue;
        }

        if !result.issues.is_empty() {
            failures.push(format!("{id}: unexpected issues {:?}", result.issues));
            continue;
        }

        let expected = match case.get("segments") {
            Some(Value::Null) | None => None,
            Some(value) => Some(segments_from(value)),
        };

        if result.segments != expected {
            failures.push(format!("{id}: {:?} (expected {:?})", result.segments, expected));
        }
    }

    assert!(failures.is_empty(), "{} case(s) diverged:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn corpus_safety() {
    let corpus = corpus();
    let mut failures = Vec::new();

    for case in corpus["safety"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        let bindings = bindings_from(&case["bindings"]);
        let result = segment_text(text);
        let resolved = match &result.segments {
            None => text.to_string(),
            Some(segments) => resolve_segments(segments, &bindings),
        };
        let expected = case["rendered"].as_str().unwrap();
        if resolved != expected {
            failures.push(format!("{id}: {resolved:?} (expected {expected:?})"));
        }
    }

    assert!(failures.is_empty(), "{} case(s) diverged:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn corpus_bind_classification() {
    let corpus = corpus();
    for case in corpus["bind"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let expression = case["expression"].as_str().unwrap();
        let expected = match case["kind"].as_str().unwrap() {
            "name" => ExpressionKind::Name,
            _ => ExpressionKind::Expression,
        };
        assert_eq!(expression_kind(expression), Some(expected), "{id}");
    }
}

#[test]
fn segments_round_trip_to_their_source() {
    let corpus = corpus();
    for case in corpus["interpolation"].as_array().unwrap() {
        if case.get("invalid").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let text = case["text"].as_str().unwrap();
        let result = segment_text(text);
        let Some(segments) = result.segments else { continue };
        let again = segment_text(&segments_to_source(&segments));
        assert_eq!(again.segments.as_deref(), Some(segments.as_slice()), "{}", case["id"]);
    }
}

#[test]
fn a_value_cannot_re_enter_the_tokenizer() {
    let mut bindings = HashMap::new();
    bindings.insert("nested".to_string(), Value::String("{{ secret }}".to_string()));
    bindings.insert("secret".to_string(), Value::String("leaked".to_string()));

    let result = segment_text("{{ nested }}");
    let resolved = resolve_segments(result.segments.as_deref().unwrap(), &bindings);
    assert_eq!(resolved, "{{ secret }}");
    assert!(!resolved.contains("leaked"));
}

#[test]
fn a_value_that_spells_markup_stays_text() {
    let mut bindings = HashMap::new();
    bindings.insert("evil".to_string(), Value::String("</p><script>x</script>".to_string()));

    let result = segment_text("{{ evil }}");
    let segments = result.segments.unwrap();
    assert_eq!(segments.len(), 1);
    assert!(matches!(segments[0], TextSegment::Expr(_)));
    assert_eq!(resolve_segments(&segments, &bindings), "</p><script>x</script>");
}

#[test]
fn prose_that_merely_opens_a_delimiter_is_untouched() {
    let text = "Handlebars uses {{ as an opener; xript borrowed it.";
    assert!(contains_interpolation(text));
    assert_eq!(segment_text(text).segments, None);
}

#[test]
fn a_windows_path_is_untouched() {
    assert_eq!(segment_text("C:\\Users\\home\\notes.txt").segments, None);
}

#[test]
fn the_grammar_has_no_host_reach() {
    for source in [
        "globalThis",
        "eval('1')",
        "fetch('x')",
        "require('fs')",
        "process.exit()",
        "this",
        "new Function('x')",
        "hp.constructor('x')",
    ] {
        assert!(parse(source).is_err(), "{source} must not parse");
    }

    let bindings = HashMap::new();
    assert_eq!(evaluate("process", &bindings), Value::Null);
    assert_eq!(evaluate("process.env.SECRET", &bindings), Value::Null);
}

#[test]
fn null_renders_as_nothing() {
    assert_eq!(render(&Value::Null), "");
}

#[test]
fn the_node_limit_is_enforced_at_parse_time() {
    let deep = vec!["1"; 400].join(" + ");
    let err = parse(&deep).expect_err("must exceed the limit");
    assert!(err.message.contains("node limit"), "{}", err.message);
}
