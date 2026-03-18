mod error;
pub mod fragment;
mod manifest;
mod sandbox;

pub use error::{Result, ValidationIssue, XriptError};
pub use fragment::{FragmentInstance, FragmentResult, ModInstance};
pub use manifest::{
    Binding, Capability, FragmentBinding, FragmentDeclaration, FragmentEvent, FunctionBinding,
    HookDef, Limits, Manifest, ModManifest, NamespaceBinding, Parameter, Slot,
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

    #[test]
    fn parses_mod_manifest() {
        let json = r#"{
            "xript": "0.3",
            "name": "health-panel",
            "version": "1.0.0",
            "title": "Health Panel",
            "author": "Test Author",
            "capabilities": ["ui-mount"],
            "fragments": [
                {
                    "id": "health-bar",
                    "slot": "sidebar.left",
                    "format": "text/html",
                    "source": "fragments/panel.html",
                    "bindings": [
                        { "name": "health", "path": "player.health" }
                    ],
                    "events": [
                        { "selector": "[data-action='heal']", "on": "click", "handler": "onHeal" }
                    ],
                    "priority": 10
                }
            ]
        }"#;

        let mod_manifest: ModManifest = serde_json::from_str(json).unwrap();
        assert_eq!(mod_manifest.name, "health-panel");
        assert_eq!(mod_manifest.version, "1.0.0");
        assert_eq!(mod_manifest.fragments.as_ref().unwrap().len(), 1);

        let frag = &mod_manifest.fragments.as_ref().unwrap()[0];
        assert_eq!(frag.id, "health-bar");
        assert_eq!(frag.slot, "sidebar.left");
        assert_eq!(frag.priority, Some(10));
        assert_eq!(frag.bindings.as_ref().unwrap().len(), 1);
        assert_eq!(frag.events.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn validates_mod_manifest_required_fields() {
        let invalid = r#"{
            "xript": "",
            "name": "",
            "version": ""
        }"#;

        let mod_manifest: ModManifest = serde_json::from_str(invalid).unwrap();
        let result = manifest::validate_mod_manifest(&mod_manifest);
        assert!(result.is_err());
        if let Err(XriptError::ManifestValidation { issues }) = result {
            assert!(issues.len() >= 3);
        }
    }

    #[test]
    fn sanitizes_script_tags() {
        let input = r#"<script>alert('xss')</script><p>safe</p>"#;
        let output = fragment::sanitize_html(input);
        assert!(!output.contains("<script>"));
        assert!(output.contains("<p>safe</p>"));
    }

    #[test]
    fn sanitizes_event_attributes() {
        let input = r#"<div onclick="alert('xss')">test</div>"#;
        let output = fragment::sanitize_html(input);
        assert!(!output.contains("onclick"));
        assert!(output.contains("test"));
    }

    #[test]
    fn preserves_safe_content() {
        let input = r#"<div class="panel" data-bind="health" aria-label="hp" role="progressbar"><span>100</span></div>"#;
        let output = fragment::sanitize_html(input);
        assert!(output.contains("class=\"panel\""));
        assert!(output.contains("data-bind=\"health\""));
        assert!(output.contains("aria-label=\"hp\""));
        assert!(output.contains("role=\"progressbar\""));
        assert!(output.contains("<span>100</span>"));
    }

    #[test]
    fn resolves_data_bind() {
        let source = r#"<span data-bind="health">0</span>"#;
        let mut bindings = std::collections::HashMap::new();
        bindings.insert("health".to_string(), serde_json::json!(75));

        let result = fragment::process_fragment("test-frag", source, &bindings);
        assert!(result.html.contains("75"));
        assert!(!result.html.contains(">0<"));
    }

    #[test]
    fn evaluates_data_if() {
        let source = r#"<div data-if="health < 50" class="warning">low!</div>"#;
        let mut bindings = std::collections::HashMap::new();
        bindings.insert("health".to_string(), serde_json::json!(30));

        let result = fragment::process_fragment("test-frag", source, &bindings);
        assert_eq!(result.visibility.get("health < 50"), Some(&true));

        bindings.insert("health".to_string(), serde_json::json!(80));
        let result = fragment::process_fragment("test-frag", source, &bindings);
        assert_eq!(result.visibility.get("health < 50"), Some(&false));
    }

    #[test]
    fn cross_validates_slot_exists() {
        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"] }
            ]
        }"#;

        let mod_json = r#"{
            "xript": "0.3",
            "name": "test-mod",
            "version": "1.0.0",
            "fragments": [
                { "id": "panel", "slot": "nonexistent", "format": "text/html", "source": "panel.html" }
            ]
        }"#;

        let rt = create_runtime(
            app_manifest,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn cross_validates_format_accepted() {
        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"] }
            ]
        }"#;

        let mod_json = r#"{
            "xript": "0.3",
            "name": "test-mod",
            "version": "1.0.0",
            "fragments": [
                { "id": "panel", "slot": "sidebar.left", "format": "text/plain", "source": "panel.txt" }
            ]
        }"#;

        let rt = create_runtime(
            app_manifest,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn cross_validates_capability_gating() {
        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "slots": [
                { "id": "main.overlay", "accepts": ["text/html"], "capability": "ui-mount" }
            ]
        }"#;

        let mod_json = r#"{
            "xript": "0.3",
            "name": "test-mod",
            "version": "1.0.0",
            "fragments": [
                { "id": "overlay", "slot": "main.overlay", "format": "text/html", "source": "<p>hi</p>", "inline": true }
            ]
        }"#;

        let rt = create_runtime(
            app_manifest,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let no_caps = std::collections::HashSet::new();
        let result = rt.load_mod(mod_json, std::collections::HashMap::new(), &no_caps);
        assert!(result.is_err());

        let mut with_caps = std::collections::HashSet::new();
        with_caps.insert("ui-mount".to_string());
        let result = rt.load_mod(mod_json, std::collections::HashMap::new(), &with_caps);
        assert!(result.is_ok());
    }

    #[test]
    fn load_mod_integration() {
        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true }
            ]
        }"#;

        let mod_json = r#"{
            "xript": "0.3",
            "name": "health-panel",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "health-bar",
                    "slot": "sidebar.left",
                    "format": "text/html",
                    "source": "<div data-bind=\"health\"><span>0</span></div>",
                    "inline": true,
                    "bindings": [
                        { "name": "health", "path": "player.health" }
                    ]
                }
            ]
        }"#;

        let rt = create_runtime(
            app_manifest,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let mod_instance = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
        )
        .unwrap();

        assert_eq!(mod_instance.name, "health-panel");
        assert_eq!(mod_instance.fragments.len(), 1);
        assert_eq!(mod_instance.fragments[0].id, "health-bar");

        let data = serde_json::json!({ "player": { "health": 75 } });
        let results = mod_instance.update_bindings(&data);
        assert_eq!(results.len(), 1);
        assert!(results[0].html.contains("75"));
    }

    #[test]
    fn fragment_hook_registration() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
            },
        )
        .unwrap();

        let result = rt.execute("typeof hooks.fragment.mount").unwrap();
        assert_eq!(result.value, serde_json::json!("function"));

        let result = rt.execute("typeof hooks.fragment.unmount").unwrap();
        assert_eq!(result.value, serde_json::json!("function"));

        let result = rt.execute("typeof hooks.fragment.update").unwrap();
        assert_eq!(result.value, serde_json::json!("function"));

        let result = rt.execute("typeof hooks.fragment.suspend").unwrap();
        assert_eq!(result.value, serde_json::json!("function"));

        let result = rt.execute("typeof hooks.fragment.resume").unwrap();
        assert_eq!(result.value, serde_json::json!("function"));
    }

    #[test]
    fn strips_javascript_uris() {
        let input = r#"<a href="javascript:alert('xss')">click</a>"#;
        let output = fragment::sanitize_html(input);
        assert!(!output.contains("javascript:"));
        assert!(output.contains("click"));
    }

    #[test]
    fn strips_iframe_elements() {
        let input = r#"<iframe src="evil.com"></iframe><p>ok</p>"#;
        let output = fragment::sanitize_html(input);
        assert!(!output.contains("<iframe"));
        assert!(output.contains("<p>ok</p>"));
    }
}
