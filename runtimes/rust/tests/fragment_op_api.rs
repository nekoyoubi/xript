//! The in-sandbox fragment API end to end: what a mod calls, and what a host
//! receives once the command buffer is finalized.

use std::sync::{Arc, Mutex};

use xript_runtime::{create_runtime, RuntimeOptions, XriptRuntime};

const MANIFEST: &str = r#"{ "xript": "0.1", "name": "host" }"#;

fn fire(runtime: &XriptRuntime, body: &str) -> Vec<xript_runtime::FragmentOp> {
    runtime
        .execute(&format!(
            "hooks.fragment.update(\"probe\", function(bindings, fragment) {{ {body} }});"
        ))
        .expect("handler registers");
    runtime.fire_fragment_hook("probe", "update", None).expect("hook fires")
}

fn runtime() -> XriptRuntime {
    create_runtime(MANIFEST, RuntimeOptions::default()).expect("runtime builds")
}

#[test]
fn a_string_list_stays_a_list() {
    let ops = fire(
        &runtime(),
        r#"fragment.replaceChildren(".list", ["<li onclick='x()'>a</li>", "<li>b</li>"]);"#,
    );
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].value, Some(serde_json::json!(["<li>a</li>", "<li>b</li>"])));
}

#[test]
fn an_empty_list_is_an_explicit_clear() {
    let ops = fire(&runtime(), r#"fragment.replaceChildren(".list", []);"#);
    assert_eq!(ops[0].value, Some(serde_json::json!([])));
}

#[test]
fn remove_attr_is_the_inverse_of_set_attr() {
    let ops = fire(&runtime(), r##"fragment.removeAttr("#go", "disabled");"##);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].op, "removeAttr");
    assert_eq!(ops[0].prop.as_deref(), Some("disabled"));
    assert_eq!(ops[0].attr.as_deref(), Some("disabled"));
    assert_eq!(ops[0].value, None);
}

#[test]
fn set_attr_false_or_null_finalizes_as_remove_attr() {
    let ops = fire(
        &runtime(),
        r##"fragment.setAttr("#go", "disabled", false);
            fragment.setAttr("#go", "title", null);
            fragment.setAttr("#go", "aria-pressed", "false");"##,
    );
    let names: Vec<&str> = ops.iter().map(|op| op.op.as_str()).collect();
    assert_eq!(names, ["removeAttr", "removeAttr", "setAttr"]);
    assert_eq!(ops[2].value, Some(serde_json::json!("false")));
}

#[test]
fn a_non_primitive_set_attr_value_is_refused_with_a_diagnostic() {
    let seen: Arc<Mutex<Vec<(String, String, Option<String>)>>> = Arc::default();
    let sink = seen.clone();
    let runtime = create_runtime(
        MANIFEST,
        RuntimeOptions {
            on_fragment_diagnostic: Some(Arc::new(move |_, diagnostic| {
                sink.lock().unwrap().push((
                    diagnostic.code.as_str().to_string(),
                    diagnostic.node.clone(),
                    diagnostic.prop.clone(),
                ));
            })),
            ..Default::default()
        },
    )
    .expect("runtime builds");
    let ops = fire(
        &runtime,
        r##"fragment.setAttr("#go", "title", { label: "x" });
            fragment.setAttr("#go", "title", ["a", "b"]);"##,
    );
    assert!(ops.is_empty());
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0], ("op-invalid-value".to_string(), "#go".to_string(), Some("title".to_string())));
}
