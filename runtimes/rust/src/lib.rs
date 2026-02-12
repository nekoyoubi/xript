mod error;
mod manifest;
mod sandbox;

pub use error::{Result, ValidationIssue, XriptError};
pub use manifest::{
    Binding, Capability, FunctionBinding, HookDef, Limits, Manifest, NamespaceBinding, Parameter,
};
pub use sandbox::{
    ConsoleHandler, ExecutionResult, HostBindings, HostFn, RuntimeOptions, XriptRuntime,
};

pub fn create_runtime(manifest_json: &str, options: RuntimeOptions) -> Result<XriptRuntime> {
    let manifest: Manifest = serde_json::from_str(manifest_json)?;
    XriptRuntime::new(manifest, options)
}

pub fn create_runtime_from_value(
    manifest: serde_json::Value,
    options: RuntimeOptions,
) -> Result<XriptRuntime> {
    let manifest: Manifest =
        serde_json::from_value(manifest).map_err(XriptError::Json)?;
    XriptRuntime::new(manifest, options)
}

pub fn create_runtime_from_file(
    path: &std::path::Path,
    options: RuntimeOptions,
) -> Result<XriptRuntime> {
    let content = std::fs::read_to_string(path)?;
    create_runtime(&content, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_manifest() -> &'static str {
        r#"{ "xript": "0.1", "name": "test-app" }"#
    }

    #[test]
    fn creates_runtime_from_minimal_manifest() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        );
        assert!(rt.is_ok());
    }

    #[test]
    fn rejects_empty_xript_field() {
        let result = create_runtime(
            r#"{ "xript": "", "name": "test" }"#,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        );
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            XriptError::ManifestValidation { .. }
        ));
    }

    #[test]
    fn rejects_empty_name_field() {
        let result = create_runtime(
            r#"{ "xript": "0.1", "name": "" }"#,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn executes_simple_expressions() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("2 + 2").unwrap();
        assert_eq!(result.value, serde_json::json!(4));
        assert!(result.duration_ms >= 0.0);
    }

    #[test]
    fn executes_string_expressions() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("'hello' + ' ' + 'world'").unwrap();
        assert_eq!(result.value, serde_json::json!("hello world"));
    }

    #[test]
    fn supports_standard_builtins() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("Math.max(1, 5, 3)").unwrap();
        assert_eq!(result.value, serde_json::json!(5));

        let result = rt.execute("JSON.stringify({ a: 1 })").unwrap();
        assert_eq!(result.value, serde_json::json!("{\"a\":1}"));
    }

    #[test]
    fn blocks_eval() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("eval('1 + 1')");
        assert!(result.is_err());
    }

    #[test]
    fn blocks_process_and_require() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("typeof process").unwrap();
        assert_eq!(result.value, serde_json::json!("undefined"));

        let result = rt.execute("typeof require").unwrap();
        assert_eq!(result.value, serde_json::json!("undefined"));
    }

    #[test]
    fn routes_console_output() {
        use std::sync::{Arc, Mutex};

        let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let logs_clone = logs.clone();

        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler {
                    log: Box::new(move |msg| logs_clone.lock().unwrap().push(msg.to_string())),
                    warn: Box::new(|_| {}),
                    error: Box::new(|_| {}),
                },
            },
        )
        .unwrap();

        rt.execute("console.log('hello from sandbox')").unwrap();

        let captured = logs.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0], "hello from sandbox");
    }

    #[test]
    fn exposes_manifest() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        assert_eq!(rt.manifest().name, "test-app");
        assert_eq!(rt.manifest().xript, "0.1");
    }

    #[test]
    fn rejects_invalid_json() {
        let result = create_runtime(
            "not json",
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn enforces_timeout() {
        let rt = create_runtime(
            r#"{ "xript": "0.1", "name": "test", "limits": { "timeout_ms": 100 } }"#,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("while(true) {}");
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            XriptError::ExecutionLimit { .. }
        ));
    }

    #[test]
    fn calls_host_function() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "add": {
                    "description": "adds two numbers",
                    "params": [
                        { "name": "a", "type": "number" },
                        { "name": "b", "type": "number" }
                    ]
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_function("add", |args: &[serde_json::Value]| {
            let a = args.get(0).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let b = args.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
            Ok(serde_json::json!(a + b))
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("add(3, 4)").unwrap();
        assert_eq!(result.value, serde_json::json!(7.0));
    }

    #[test]
    fn host_function_errors_become_exceptions() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "fail": {
                    "description": "always fails"
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_function("fail", |_: &[serde_json::Value]| {
            Err("intentional error".into())
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("try { fail(); 'no error' } catch(e) { e.message }");
        assert!(result.is_ok());
        assert_eq!(result.unwrap().value, serde_json::json!("intentional error"));
    }

    #[test]
    fn denies_ungranated_capabilities() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "dangerousOp": {
                    "description": "requires permission",
                    "capability": "dangerous"
                }
            },
            "capabilities": {
                "dangerous": {
                    "description": "allows dangerous operations"
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_function("dangerousOp", |_: &[serde_json::Value]| {
            Ok(serde_json::json!("should not reach"))
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("try { dangerousOp(); 'no error' } catch(e) { e.message }");
        assert!(result.is_ok());
        let msg = result.unwrap().value.as_str().unwrap().to_string();
        assert!(msg.contains("capability"));
    }

    #[test]
    fn grants_capabilities() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "dangerousOp": {
                    "description": "requires permission",
                    "capability": "dangerous"
                }
            },
            "capabilities": {
                "dangerous": {
                    "description": "allows dangerous operations"
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_function("dangerousOp", |_: &[serde_json::Value]| {
            Ok(serde_json::json!("access granted"))
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec!["dangerous".into()],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("dangerousOp()").unwrap();
        assert_eq!(result.value, serde_json::json!("access granted"));
    }

    #[test]
    fn missing_binding_throws() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "notProvided": {
                    "description": "host didn't register this"
                }
            }
        }"#;

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("try { notProvided(); 'no error' } catch(e) { e.message }");
        assert!(result.is_ok());
        let msg = result.unwrap().value.as_str().unwrap().to_string();
        assert!(msg.contains("not provided"));
    }
}
