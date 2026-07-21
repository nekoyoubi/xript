use std::collections::HashMap;

use xript_runtime::{create_runtime, HostBindings, HostNamespaceMember, RuntimeOptions, XriptError};

const HOST: &str = r#"{
    "xript": "0.8",
    "name": "drift-host",
    "bindings": {
        "solo": { "description": "Standalone." },
        "fs": { "description": "Filesystem.", "members": {
            "read": { "description": "Reads." },
            "write": { "description": "Writes." }
        }}
    }
}"#;

fn partial() -> HostBindings {
    let mut bindings = HostBindings::new();
    let mut members: HashMap<String, HostNamespaceMember> = HashMap::new();
    members.insert(
        "read".into(),
        HostNamespaceMember::Function(std::sync::Arc::new(|_: &[serde_json::Value]| {
            Ok(serde_json::json!("data"))
        })),
    );
    bindings.add_nested_namespace("fs", members);
    bindings
}

fn complete() -> HostBindings {
    let mut bindings = partial();
    bindings.add_function("solo", |_: &[serde_json::Value]| Ok(serde_json::json!(1)));
    let mut members: HashMap<String, HostNamespaceMember> = HashMap::new();
    for name in ["read", "write"] {
        members.insert(
            name.into(),
            HostNamespaceMember::Function(std::sync::Arc::new(|_: &[serde_json::Value]| {
                Ok(serde_json::json!("data"))
            })),
        );
    }
    bindings.add_nested_namespace("fs", members);
    bindings
}

#[test]
fn reports_every_declared_binding_the_host_did_not_supply() {
    let rt = create_runtime(
        HOST,
        RuntimeOptions {
            host_bindings: partial(),
            ..RuntimeOptions::default()
        },
    )
    .unwrap();

    assert_eq!(rt.missing_bindings(), ["fs.write", "solo"]);
}

#[test]
fn strict_bindings_refuses_to_construct() {
    let result = create_runtime(
        HOST,
        RuntimeOptions {
            host_bindings: partial(),
            strict_bindings: true,
            ..RuntimeOptions::default()
        },
    );

    match result {
        Err(XriptError::MissingBindings { missing }) => assert_eq!(missing, ["fs.write", "solo"]),
        other => panic!("expected MissingBindings, got {other:?}"),
    }
}

#[test]
fn a_fully_supplied_host_is_clean_under_strict() {
    let rt = create_runtime(
        HOST,
        RuntimeOptions {
            host_bindings: complete(),
            strict_bindings: true,
            ..RuntimeOptions::default()
        },
    )
    .unwrap();

    assert!(rt.missing_bindings().is_empty());
}
