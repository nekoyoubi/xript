//! The Rust side of the XEG differential fuzzer (`npm run fuzz:xeg`).
//!
//! Reads one JSON case per line on stdin and writes one JSON result per line on stdout, in
//! order, flushing after each. The driver in `scripts/xeg-fuzz/` compares the results with
//! the TypeScript and C# implementations. Not part of the crate's API.

use std::collections::HashMap;
use std::io::{self, BufRead, Write};

use serde_json::{json, Value};
use xript_expr::{
    evaluate, evaluate_condition, evaluate_repeat_items, parse, parse_repeat_header, render,
    resolve_segments, segment_text, ExpressionKind, TextSegment,
};

fn bindings_from(value: &Value) -> HashMap<String, Value> {
    value
        .as_object()
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

fn run_eval(case: &Value) -> Value {
    let source = case["src"].as_str().unwrap_or_default();
    let bindings = bindings_from(&case["b"]);
    let parsed = match parse(source) {
        Ok(expression) => json!({
            "kind": if expression.kind == ExpressionKind::Name { "name" } else { "expression" },
            "names": expression.names,
            "nodes": expression.node_count,
        }),
        Err(_) => Value::Null,
    };
    let value = evaluate(source, &bindings);
    json!({
        "parse": parsed,
        "value": value,
        "render": render(&value),
        "truthy": evaluate_condition(source, &bindings),
    })
}

fn run_segment(case: &Value) -> Value {
    let text = case["text"].as_str().unwrap_or_default();
    let bindings = bindings_from(&case["b"]);
    let result = segment_text(text);
    let segments = result.segments.as_ref().map(|segments| {
        segments
            .iter()
            .map(|segment| match segment {
                TextSegment::Literal(value) => json!(["literal", value]),
                TextSegment::Expr(source) => json!(["expr", source]),
            })
            .collect::<Vec<_>>()
    });
    let resolved = result.segments.as_ref().map(|segments| resolve_segments(segments, &bindings));
    json!({ "segments": segments, "issues": result.issues.len(), "resolved": resolved })
}

fn run_repeat(case: &Value) -> Value {
    let source = case["src"].as_str().unwrap_or_default();
    let bindings = bindings_from(&case["b"]);
    match parse_repeat_header(source) {
        Ok(header) => json!({
            "ok": true,
            "item": header.item,
            "index": header.index,
            "source": header.source,
            "items": evaluate_repeat_items(&header, &bindings),
        }),
        Err(_) => json!({ "ok": false }),
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let case: Value = match serde_json::from_str(&line) {
            Ok(case) => case,
            Err(error) => {
                let _ = writeln!(out, "{}", json!({ "harnessError": error.to_string() }));
                let _ = out.flush();
                continue;
            }
        };
        let result = match case["k"].as_str() {
            Some("e") => run_eval(&case),
            Some("s") => run_segment(&case),
            Some("r") => run_repeat(&case),
            _ => json!({ "harnessError": "unknown case kind" }),
        };
        let _ = writeln!(out, "{result}");
        let _ = out.flush();
    }
}
