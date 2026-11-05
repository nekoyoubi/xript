//! Conformance against the shared stack corpus in `spec/`: a script that
//! exhausts the stack ends with an error it can catch (or succeeds), the
//! runtime stays usable, and disposing it afterwards is clean. Every case runs
//! in both runtime modes, on the test thread and on a 1 MiB thread.

use serde::Deserialize;
use xript_runtime::{create_runtime_from_value, RuntimeMode, RuntimeOptions};

const CORPUS: &str = include_str!("../../../spec/stack-tests.json");

#[derive(Deserialize)]
struct Corpus {
    manifest: serde_json::Value,
    template: String,
    after: String,
    #[serde(rename = "afterExpected")]
    after_expected: serde_json::Value,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    script: String,
}

fn run_corpus() -> Vec<String> {
    let corpus: Corpus = serde_json::from_str(CORPUS).expect("corpus parses");
    let mut failures = Vec::new();
    for mode in [RuntimeMode::Sync, RuntimeMode::Async] {
        for case in &corpus.cases {
            let label = format!("{mode:?} {}", case.name);
            let rt = create_runtime_from_value(corpus.manifest.clone(), RuntimeOptions { mode, ..Default::default() })
                .expect("runtime builds");
            match rt.execute(&corpus.template.replace("SCRIPT", &case.script)) {
                Ok(result) if result.value == "caught" || result.value == "ok" => {}
                Ok(result) => failures.push(format!("{label}: ended {}", result.value)),
                Err(error) => failures.push(format!("{label}: {error}")),
            }
            match rt.execute(&corpus.after) {
                Ok(result) if result.value.as_f64() == corpus.after_expected.as_f64() => {}
                Ok(result) => failures.push(format!("{label}: after gave {}", result.value)),
                Err(error) => failures.push(format!("{label}: after failed: {error}")),
            }
            drop(rt);
        }
    }
    failures
}

#[test]
fn stack_corpus() {
    let failures = run_corpus();
    assert!(failures.is_empty(), "stack corpus failures:\n{}", failures.join("\n"));
}

#[test]
fn stack_corpus_on_a_one_mebibyte_thread() {
    let failures = std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(run_corpus)
        .unwrap()
        .join()
        .expect("the host thread survives");
    assert!(failures.is_empty(), "stack corpus failures on a 1 MiB thread:\n{}", failures.join("\n"));
}
