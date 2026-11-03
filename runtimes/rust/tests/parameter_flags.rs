//! A host reading `rt.manifest()` sees every parameter flag the schema
//! defines. The flags are descriptive: no runtime checks argument count.

use xript_runtime::{create_runtime, Binding, HostBindings, RuntimeOptions};

const MANIFEST: &str = r#"{
    "xript": "0.10",
    "name": "params",
    "bindings": {
        "log": {
            "description": "logs",
            "params": [
                { "name": "level", "type": "string" },
                { "name": "tag", "type": "string", "optional": true },
                { "name": "fallback", "type": "string", "default": "x" },
                { "name": "loose", "type": "string", "required": false },
                { "name": "parts", "type": "string", "variadic": true }
            ]
        }
    }
}"#;

#[test]
fn a_host_reads_optional_and_variadic_from_the_manifest() {
    let mut bindings = HostBindings::new();
    bindings.add_function("log", |args: &[serde_json::Value]| Ok(serde_json::json!(args.len())));
    let rt = create_runtime(MANIFEST, RuntimeOptions { host_bindings: bindings, ..Default::default() }).unwrap();

    let Some(Binding::Function(log)) = rt.manifest().bindings.as_ref().and_then(|b| b.get("log")) else {
        panic!("log is a function binding");
    };
    let params = log.params.as_ref().unwrap();
    let optional: Vec<bool> = params.iter().map(|p| p.is_optional()).collect();
    assert_eq!(optional, [false, true, true, true, true]);
    assert_eq!(params[1].optional, Some(true));
    assert!(params[4].variadic);
    assert!(params[4].is_variadic());
    assert!(!params[0].is_variadic());

    assert_eq!(rt.execute("log()").unwrap().value.as_f64(), Some(0.0));
    assert_eq!(rt.execute("log('a', 'b', 'c', 'd', 'e', 'f', 'g')").unwrap().value.as_f64(), Some(7.0));
}
