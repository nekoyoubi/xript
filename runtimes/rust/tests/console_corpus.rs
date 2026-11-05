//! Conformance against the shared console corpus in `spec/`: a console call
//! never throws, whatever it is given, and a string handler receives each
//! argument rendered as the corpus's `message` rule says.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use xript_runtime::{
    create_runtime_from_value, ConsoleHandler, HardLimits, LogSeverity, RuntimeMode, RuntimeOptions, XriptError,
};

const CORPUS: &str = include_str!("../../../spec/console-tests.json");

#[derive(Deserialize)]
struct Corpus {
    manifest: Value,
    sentinel: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    script: String,
    logs: Vec<Log>,
}

#[derive(Deserialize)]
struct Log {
    severity: String,
    message: Value,
}

type Lines = Arc<Mutex<Vec<(String, String)>>>;

fn severity_name(severity: LogSeverity) -> &'static str {
    match severity {
        LogSeverity::Trace => "trace",
        LogSeverity::Debug => "debug",
        LogSeverity::Info => "info",
        LogSeverity::Warn => "warn",
        LogSeverity::Error => "error",
    }
}

fn recording(lines: &Lines) -> ConsoleHandler {
    let sink = lines.clone();
    ConsoleHandler {
        on: Some(Box::new(move |severity, message| {
            sink.lock().unwrap().push((severity_name(severity).to_string(), message.to_string()));
        })),
        ..ConsoleHandler::default()
    }
}

const MATCHER_KEYS: [&str; 4] = ["$expect", "prefix", "suffix", "optional"];

/// Whether `got` meets `expected`: equal text, or a `$expect` matcher's
/// prefix and suffix. `None` is an absent value, which only a matcher marked
/// `"optional": true` accepts. A string handler always receives a message, so
/// for a whole `message` the flag never relaxes anything. A matcher key this
/// runner does not know fails the case rather than being ignored.
fn matches(expected: &Value, got: Option<&str>) -> bool {
    if let Some(text) = expected.as_str() {
        return got == Some(text);
    }
    let Some(matcher) = expected.as_object() else { return false };
    if matcher.get("$expect").and_then(Value::as_str) != Some("string")
        || matcher.keys().any(|key| !MATCHER_KEYS.contains(&key.as_str()))
    {
        return false;
    }
    let Some(got) = got else {
        return matcher.get("optional").and_then(Value::as_bool) == Some(true);
    };
    let prefix = matcher.get("prefix").and_then(Value::as_str).unwrap_or("");
    let suffix = matcher.get("suffix").and_then(Value::as_str).unwrap_or("");
    got.starts_with(prefix) && got.ends_with(suffix)
}

#[test]
fn the_matcher_reads_optional_as_permission_to_be_absent() {
    let required = json!({ "$expect": "string" });
    let optional = json!({ "$expect": "string", "optional": true, "prefix": "Error" });
    assert!(matches(&required, Some("anything")));
    assert!(!matches(&required, None));
    assert!(matches(&optional, None));
    assert!(matches(&optional, Some("Error: boom")));
    assert!(!matches(&optional, Some("boom")));
    assert!(!matches(&json!({ "$expect": "string", "optionl": true }), Some("typo")));
}

#[test]
fn console_corpus() {
    let corpus: Corpus = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        for case in &corpus.cases {
            let lines = Lines::default();
            let rt = create_runtime_from_value(
                corpus.manifest.clone(),
                RuntimeOptions { console: recording(&lines), mode, ..Default::default() },
            )
            .expect("runtime builds");
            let label = format!("{mode:?} {}", case.name);
            match rt.execute(&case.script) {
                Ok(result) if result.value == json!(corpus.sentinel) => {}
                Ok(result) => failures.push(format!("{label}: the script ended {}", result.value)),
                Err(error) => failures.push(format!("{label}: {error}")),
            }
            let got = lines.lock().unwrap().clone();
            if got.len() != case.logs.len() {
                failures.push(format!("{label}: {} console calls, expected {}: {got:?}", got.len(), case.logs.len()));
                continue;
            }
            for ((severity, message), log) in got.iter().zip(&case.logs) {
                if *severity != log.severity || !matches(&log.message, Some(message)) {
                    failures.push(format!("{label}: got {severity} {message:?}, expected {} {}", log.severity, log.message));
                }
            }
        }
    }
    assert!(failures.is_empty(), "console corpus failures:\n{}", failures.join("\n"));
}

#[test]
fn the_execution_limit_still_ends_a_script_while_console_reads_an_argument() {
    for script in [
        "console.log({ get spin() { while (true) {} } }); 'continued'",
        "console.log({ toJSON: function () { while (true) {} } }); 'continued'",
        "console.error({ name: 'E', get message() { while (true) {} } }); 'continued'",
        "var e = new Error(); Object.defineProperty(e, 'message', { get: function () { while (true) {} } }); console.error(e); 'continued'",
        "console.log(Object.create({ get stack() { while (true) {} } })); 'continued'",
        "console.log({ get toJSON() { while (true) {} } }); 'continued'",
        "console.log({ get bad() { throw { get name() { while (true) {} } }; } }); 'continued'",
    ] {
        let lines = Lines::default();
        let rt = create_runtime_from_value(
            json!({ "xript": "0.10", "name": "console-limit" }),
            RuntimeOptions {
                console: recording(&lines),
                hard_limits: Some(HardLimits { timeout_ms: Some(100), ..Default::default() }),
                ..Default::default()
            },
        )
        .unwrap();
        let outcome = rt.execute(script);
        assert!(
            matches!(outcome, Err(XriptError::ExecutionLimit { ref limit }) if limit == "timeout_ms"),
            "{script}: {outcome:?}"
        );
        assert!(lines.lock().unwrap().is_empty(), "{script}: the console call never completed");
    }
}

#[test]
fn a_lone_surrogate_reaches_the_handler_as_the_replacement_character() {
    let lines = Lines::default();
    let rt = create_runtime_from_value(
        json!({ "xript": "0.10", "name": "console-text" }),
        RuntimeOptions { console: recording(&lines), ..Default::default() },
    )
    .unwrap();
    rt.execute("console.log('a\\uD800', ['\\uDC00'])").unwrap();
    assert_eq!(*lines.lock().unwrap(), vec![("info".to_string(), "a\u{FFFD} [\"\\udc00\"]".to_string())]);
}
