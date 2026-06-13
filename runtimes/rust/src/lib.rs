pub mod cap_match;
pub mod capability;
pub mod debug;
mod error;
pub mod fragment;
pub mod handle;
mod manifest;
pub mod module;
mod sandbox;

pub use capability::{
    CapabilityPrompt, DiscoveredMod, DiscoveryResult, InstallDescriptor, InstallSource,
    InstallSourceType, PromptMod, PromptState, RequestedScope,
};
pub use debug::{
    instrument_source, Breakpoint, DebugFidelity, DebugOptions, DebugSession, Scope, SourceBreakpoint,
    StackFrame, StopReason, StoppedEvent, Variable, DEBUG_THREAD_ID,
};
pub use cap_match::{granted_satisfies, satisfies};
pub use error::{Result, ValidationIssue, XriptError};
pub use fragment::{FragmentInstance, FragmentResult, ModInstance};
pub use manifest::{
    is_role_identifier, resolve_extends, Binding, Capability, Contributions, EntryBlock, EventDefinition,
    ExportDecl, Extends, FieldDefinition, FragmentBinding, FragmentDeclaration, FragmentEvent,
    FragmentHandler, FunctionBinding,
    HookDef, LibraryDef, Limits, Manifest, ModManifest, NamespaceBinding, Parameter, ProviderRole, Slot,
    TypeDefinition,
};
pub use handle::XriptHandle;
pub use sandbox::{
    AsyncHostFn, AuditEvent, AuditSink, CancellationToken, ConsoleHandler, ExecutionResult,
    HardLimits, HostBindings, HostFn, HostNamespaceMember, LogSeverity, NamespaceBuilder,
    RoleResolution, RuntimeOptions, SlotContribution, XriptRuntime,
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
    let raw: serde_json::Value = serde_json::from_str(&content)?;
    let base_dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let resolved = resolve_extends(&raw, base_dir)?;
    create_runtime_from_value(resolved, options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("Math.max(1, 5, 3)").unwrap();
        assert_eq!(result.value, serde_json::json!(5));

        let result = rt.execute("JSON.stringify({ a: 1 })").unwrap();
        assert_eq!(result.value, serde_json::json!("{\"a\":1}"));
    }

    #[test]
    fn returns_object_from_execute() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("({ a: 1, b: [2, 3] })").unwrap();
        assert_eq!(result.value, serde_json::json!({"a": 1, "b": [2, 3]}));
    }

    #[test]
    fn returns_array_from_execute() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("[1, 2, 3]").unwrap();
        assert_eq!(result.value, serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn returns_nested_object_from_execute() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("({ x: { y: 1 }, z: [true, null] })").unwrap();
        assert_eq!(result.value, serde_json::json!({"x": {"y": 1}, "z": [true, null]}));
    }

    #[test]
    fn blocks_eval() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                    on: None,
                },
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("dangerousOp()").unwrap();
        assert_eq!(result.value, serde_json::json!("access granted"));
    }

    #[test]
    fn execute_uncaught_throw_propagates_error_message() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("throw new Error('actual message here')");
        let err = result.expect_err("uncaught throw should produce an error");
        let rendered = err.to_string();
        assert!(
            rendered.contains("actual message here"),
            "expected the thrown message in the error, got: {rendered}"
        );
        assert!(
            !rendered.contains("undefined"),
            "the rescue snippet was returning 'undefined' instead of the real message: {rendered}"
        );
    }

    #[test]
    fn execute_thrown_string_propagates_value() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("throw 'bare string thrown'");
        let err = result.expect_err("bare-string throw should produce an error");
        let rendered = err.to_string();
        assert!(
            rendered.contains("bare string thrown"),
            "expected the thrown string in the error, got: {rendered}"
        );
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
                    "handlers": [
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
        assert_eq!(frag.handlers.as_ref().unwrap().len(), 1);
        assert_eq!(frag.resolved_handlers().unwrap().len(), 1);
    }

    #[test]
    fn accepts_deprecated_events_alias_for_fragment_handlers() {
        let json = r#"{
            "xript": "0.3",
            "name": "legacy-panel",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "legacy",
                    "slot": "sidebar.left",
                    "format": "text/html",
                    "source": "fragments/panel.html",
                    "events": [
                        { "selector": "[data-action='heal']", "on": "click", "handler": "onHeal" }
                    ]
                }
            ]
        }"#;

        let mod_manifest: ModManifest = serde_json::from_str(json).unwrap();
        let frag = &mod_manifest.fragments.as_ref().unwrap()[0];
        assert!(frag.handlers.is_none());
        assert_eq!(frag.events.as_ref().unwrap().len(), 1);
        assert_eq!(frag.resolved_handlers().unwrap()[0].handler, "onHeal");
    }

    #[test]
    fn fragment_handlers_wins_over_deprecated_events_alias() {
        let json = r##"{
            "xript": "0.3",
            "name": "both-panel",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "both",
                    "slot": "sidebar.left",
                    "format": "text/html",
                    "source": "fragments/panel.html",
                    "handlers": [
                        { "selector": "#a", "on": "click", "handler": "fromHandlers" }
                    ],
                    "events": [
                        { "selector": "#b", "on": "click", "handler": "fromEvents" }
                    ]
                }
            ]
        }"##;

        let mod_manifest: ModManifest = serde_json::from_str(json).unwrap();
        let frag = &mod_manifest.fragments.as_ref().unwrap()[0];
        let resolved = frag.resolved_handlers().unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].handler, "fromHandlers");
    }

    #[test]
    fn top_level_events_catalog_does_not_break_app_manifest() {
        let json = r#"{
            "xript": "0.3",
            "name": "host-app",
            "events": [
                { "id": "player.died", "description": "Fired when the player dies." }
            ]
        }"#;

        let manifest: manifest::Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "host-app");
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let no_caps = std::collections::HashSet::new();
        let result = rt.load_mod(mod_json, std::collections::HashMap::new(), &no_caps, None);
        assert!(result.is_err());

        let mut with_caps = std::collections::HashSet::new();
        with_caps.insert("ui-mount".to_string());
        let result = rt.load_mod(mod_json, std::collections::HashMap::new(), &with_caps, None);
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let mod_instance = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            None,
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
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
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
    fn load_mod_executes_entry_script() {
        use std::sync::{Arc, Mutex};

        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "bindings": {
                "log": { "description": "log a message" }
            },
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true }
            ]
        }"#;

        let mod_json = r#"{
            "xript": "0.3",
            "name": "entry-mod",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "entry-panel",
                    "slot": "sidebar.left",
                    "format": "text/html",
                    "source": "<p>hi</p>",
                    "inline": true
                }
            ]
        }"#;

        let captured: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = captured.clone();

        let mut bindings = HostBindings::new();
        bindings.add_function("log", move |args: &[serde_json::Value]| {
            let msg = args.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
            captured_clone.lock().unwrap().push(msg);
            Ok(serde_json::Value::Null)
        });

        let rt = create_runtime(
            app_manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            Some("log('entry executed')"),
        );
        assert!(result.is_ok());

        let logs = captured.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0], "entry executed");
    }

    #[test]
    fn load_mod_entry_failure_returns_mod_entry_error() {
        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true }
            ]
        }"#;

        let mod_json = r#"{
            "xript": "0.3",
            "name": "failing-mod",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "panel",
                    "slot": "sidebar.left",
                    "format": "text/html",
                    "source": "<p>hi</p>",
                    "inline": true
                }
            ]
        }"#;

        let rt = create_runtime(
            app_manifest,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            Some("throw new Error('entry failed')"),
        );
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), XriptError::ModEntry { .. }));
    }

    #[test]
    fn load_mod_without_entry_still_works() {
        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true }
            ]
        }"#;

        let mod_json = r#"{
            "xript": "0.3",
            "name": "no-entry-mod",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "panel",
                    "slot": "sidebar.left",
                    "format": "text/html",
                    "source": "<p>hi</p>",
                    "inline": true
                }
            ]
        }"#;

        let rt = create_runtime(
            app_manifest,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            None,
        );
        assert!(result.is_ok());
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

    #[test]
    fn handle_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<handle::XriptHandle>();
    }

    #[test]
    fn handle_executes_code() {
        let handle = handle::XriptHandle::new(
            minimal_manifest().to_string(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = handle.execute("2 + 2").unwrap();
        assert_eq!(result.value, serde_json::json!(4));
    }

    #[test]
    fn handle_returns_manifest_name() {
        let handle = handle::XriptHandle::new(
            minimal_manifest().to_string(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        assert_eq!(handle.manifest_name().unwrap(), "test-app");
    }

    #[test]
    fn handle_works_across_threads() {
        let handle = handle::XriptHandle::new(
            minimal_manifest().to_string(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = std::thread::spawn(move || handle.execute("1 + 1"))
            .join()
            .unwrap()
            .unwrap();

        assert_eq!(result.value, serde_json::json!(2));
    }

    #[test]
    fn handle_propagates_errors() {
        let handle = handle::XriptHandle::new(
            minimal_manifest().to_string(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = handle.execute("throw new Error('boom')");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), XriptError::Script(_)));
    }

    #[test]
    fn handle_load_mod_works() {
        let app_manifest = r#"{
            "xript": "0.3",
            "name": "test-app",
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"] }
            ]
        }"#;

        let handle = handle::XriptHandle::new(
            app_manifest.to_string(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let mod_json = r#"{
            "xript": "0.3",
            "name": "test-mod",
            "version": "1.0.0",
            "fragments": [
                { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
            ]
        }"#;

        let mod_instance = handle
            .load_mod(
                mod_json,
                std::collections::HashMap::new(),
                &std::collections::HashSet::new(),
                None,
            )
            .unwrap();

        assert_eq!(mod_instance.name, "test-mod");
    }

    #[test]
    fn calls_async_host_function() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "fetchData": {
                    "description": "fetches data asynchronously",
                    "async": true
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_async_function("fetchData", |args: &[serde_json::Value]| {
            let key = args
                .first()
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();
            async move { Ok(serde_json::json!(format!("data for {}", key))) }
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt
            .execute("(async () => await fetchData('users'))()")
            .unwrap();
        assert_eq!(result.value, serde_json::json!("data for users"));
    }

    #[test]
    fn async_host_function_errors_become_exceptions() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "failAsync": {
                    "description": "always fails asynchronously"
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_async_function("failAsync", |_: &[serde_json::Value]| {
            async { Err("async error occurred".into()) }
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt
            .execute("(async () => { try { await failAsync(); return 'no error'; } catch(e) { return e.message; } })()")
            .unwrap();
        assert_eq!(result.value, serde_json::json!("async error occurred"));
    }

    #[test]
    fn sync_and_async_bindings_coexist() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "syncAdd": {
                    "description": "adds two numbers synchronously",
                    "params": [
                        { "name": "a", "type": "number" },
                        { "name": "b", "type": "number" }
                    ]
                },
                "asyncFetch": {
                    "description": "fetches data asynchronously",
                    "async": true
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_function("syncAdd", |args: &[serde_json::Value]| {
            let a = args.first().and_then(|v| v.as_f64()).unwrap_or(0.0);
            let b = args.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
            Ok(serde_json::json!(a + b))
        });
        bindings.add_async_function("asyncFetch", |args: &[serde_json::Value]| {
            let key = args
                .first()
                .and_then(|v| v.as_str())
                .unwrap_or("none")
                .to_string();
            async move { Ok(serde_json::json!(format!("fetched {}", key))) }
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let sync_result = rt.execute("syncAdd(10, 20)").unwrap();
        assert_eq!(sync_result.value, serde_json::json!(30.0));

        let async_result = rt
            .execute("(async () => await asyncFetch('items'))()")
            .unwrap();
        assert_eq!(async_result.value, serde_json::json!("fetched items"));
    }

    #[test]
    fn mixed_namespace_exposes_properties_alongside_functions() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "run": {
                    "description": "test run namespace",
                    "members": {
                        "id": { "description": "the run id" },
                        "inputs": { "description": "frozen inputs" },
                        "tag": {
                            "description": "append a tag",
                            "params": [{ "name": "name", "type": "string" }]
                        }
                    }
                }
            }
        }"#;

        use std::collections::HashMap;
        use std::sync::Arc;

        let mut bindings = HostBindings::new();
        let mut props = serde_json::Map::new();
        props.insert(
            "id".to_string(),
            serde_json::Value::String("run-abc".into()),
        );
        props.insert(
            "inputs".to_string(),
            serde_json::json!({ "force": true, "name": "loop" }),
        );
        let mut funcs: HashMap<String, HostFn> = HashMap::new();
        funcs.insert(
            "tag".to_string(),
            Arc::new(|args: &[serde_json::Value]| {
                let name = args
                    .first()
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Ok(serde_json::json!({ "tagged": name }))
            }),
        );
        bindings.add_mixed_namespace("run", props, funcs);

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let id_result = rt.execute("run.id").unwrap();
        assert_eq!(id_result.value, serde_json::json!("run-abc"));

        let inputs_result = rt.execute("run.inputs.force").unwrap();
        assert_eq!(inputs_result.value, serde_json::json!(true));

        let inputs_name = rt.execute("run.inputs.name").unwrap();
        assert_eq!(inputs_name.value, serde_json::json!("loop"));

        let tag_result = rt.execute("run.tag('hello')").unwrap();
        assert_eq!(
            tag_result.value,
            serde_json::json!({ "tagged": "hello" })
        );
    }

    #[test]
    fn async_binding_returns_promise() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "asyncOp": {
                    "description": "async operation",
                    "async": true
                }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_async_function("asyncOp", |_: &[serde_json::Value]| {
            async { Ok(serde_json::json!(42)) }
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute("asyncOp() instanceof Promise").unwrap();
        assert_eq!(result.value, serde_json::json!(true));
    }

    #[test]
    fn async_await_chains_work() {
        let manifest = r#"{
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "fetchUser": { "description": "fetch user", "async": true },
                "fetchRole": { "description": "fetch role", "async": true }
            }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_async_function("fetchUser", |args: &[serde_json::Value]| {
            let id = args.first().and_then(|v| v.as_i64()).unwrap_or(0);
            async move { Ok(serde_json::json!({"id": id, "name": "Alice"})) }
        });
        bindings.add_async_function("fetchRole", |args: &[serde_json::Value]| {
            let name = args.first().and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            async move { Ok(serde_json::json!(format!("admin:{}", name))) }
        });

        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: bindings,
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();

        let result = rt.execute(r#"
            (async () => {
                const user = await fetchUser(1);
                const role = await fetchRole(user.name);
                return role;
            })()
        "#).unwrap();

        assert_eq!(result.value, serde_json::json!("admin:Alice"));
    }

    fn opts() -> RuntimeOptions {
        RuntimeOptions::default()
    }

    #[test]
    fn cancellation_arms_before_execute() {
        let token = CancellationToken::new();
        let mut o = opts();
        o.cancellation = Some(token.clone());
        let rt = create_runtime(minimal_manifest(), o).unwrap();

        token.cancel();
        let result = rt.execute("1 + 1");
        assert!(matches!(result, Err(XriptError::Cancelled)));
    }

    #[test]
    fn cancellation_interrupts_long_loop() {
        let token = CancellationToken::new();
        let mut o = opts();
        o.cancellation = Some(token.clone());
        let rt = create_runtime(
            r#"{ "xript": "0.1", "name": "t", "limits": { "timeout_ms": 60000 } }"#,
            o,
        )
        .unwrap();

        let token2 = token.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            token2.cancel();
        });
        let result = rt.execute("while(true) {}");
        handle.join().unwrap();
        assert!(matches!(result, Err(XriptError::Cancelled)));
    }

    #[test]
    fn cancellation_is_sticky_and_idempotent() {
        let token = CancellationToken::new();
        token.cancel();
        token.cancel();
        assert!(token.is_cancelled());
        let mut o = opts();
        o.cancellation = Some(token.clone());
        let rt = create_runtime(minimal_manifest(), o).unwrap();
        assert!(matches!(rt.execute("2"), Err(XriptError::Cancelled)));
        assert!(matches!(rt.execute("3"), Err(XriptError::Cancelled)));
    }

    #[test]
    fn timeout_kind_distinct_from_cancellation() {
        let rt = create_runtime(
            r#"{ "xript": "0.1", "name": "t", "limits": { "timeout_ms": 50 } }"#,
            opts(),
        )
        .unwrap();
        let result = rt.execute("while(true) {}");
        assert!(matches!(result, Err(XriptError::ExecutionLimit { .. })));
    }

    #[test]
    fn audit_fires_for_allowed_invocations() {
        use std::sync::mpsc;
        let manifest = r#"{
            "xript": "0.1", "name": "t",
            "bindings": {
                "gated": { "description": "x", "capability": "do-it" },
                "plain": { "description": "y" }
            },
            "capabilities": { "do-it": { "description": "z" } }
        }"#;

        let mut bindings = HostBindings::new();
        bindings.add_function("gated", |_| Ok(serde_json::json!("ok")));
        bindings.add_function("plain", |_| Ok(serde_json::json!("ok")));

        let (tx, rx) = mpsc::channel::<AuditEvent>();
        let o = RuntimeOptions {
            host_bindings: bindings,
            capabilities: vec!["do-it".into()],
            ..RuntimeOptions::default()
        }
        .with_audit_channel(tx);

        let rt = create_runtime(manifest, o).unwrap();
        rt.execute("gated(); plain()").unwrap();

        let events: Vec<AuditEvent> = rx.try_iter().collect();
        assert_eq!(events.len(), 2);
        let gated = events.iter().find(|e| e.binding == "gated").unwrap();
        assert_eq!(gated.capability.as_deref(), Some("do-it"));
        let plain = events.iter().find(|e| e.binding == "plain").unwrap();
        assert_eq!(plain.capability, None);
        assert!(gated.at_ms > 0.0);
    }

    #[test]
    fn audit_does_not_fire_for_denied_invocations() {
        use std::sync::mpsc;
        let manifest = r#"{
            "xript": "0.1", "name": "t",
            "bindings": { "gated": { "description": "x", "capability": "do-it" } },
            "capabilities": { "do-it": { "description": "z" } }
        }"#;
        let mut bindings = HostBindings::new();
        bindings.add_function("gated", |_| Ok(serde_json::json!("ok")));
        let (tx, rx) = mpsc::channel::<AuditEvent>();
        let o = RuntimeOptions {
            host_bindings: bindings,
            capabilities: vec![],
            ..RuntimeOptions::default()
        }
        .with_audit_channel(tx);
        let rt = create_runtime(manifest, o).unwrap();
        let _ = rt.execute("try { gated() } catch(e) {}");
        let events: Vec<AuditEvent> = rx.try_iter().collect();
        assert!(events.is_empty());
    }

    #[test]
    fn console_severity_routes_all_six_methods() {
        use std::sync::{Arc, Mutex};
        let captured: Arc<Mutex<Vec<(LogSeverity, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let cap2 = captured.clone();
        let mut o = opts();
        o.console = ConsoleHandler {
            on: Some(Box::new(move |sev, msg| {
                cap2.lock().unwrap().push((sev, msg.to_string()));
            })),
            ..ConsoleHandler::default()
        };
        let rt = create_runtime(minimal_manifest(), o).unwrap();
        rt.execute(
            "console.trace('t'); console.debug('d'); console.log('l'); console.info('i'); console.warn('w'); console.error('e');",
        )
        .unwrap();
        let logs = captured.lock().unwrap();
        assert_eq!(logs.len(), 6);
        assert_eq!(logs[0], (LogSeverity::Trace, "t".to_string()));
        assert_eq!(logs[1], (LogSeverity::Debug, "d".to_string()));
        assert_eq!(logs[2], (LogSeverity::Info, "l".to_string()));
        assert_eq!(logs[3], (LogSeverity::Info, "i".to_string()));
        assert_eq!(logs[4], (LogSeverity::Warn, "w".to_string()));
        assert_eq!(logs[5], (LogSeverity::Error, "e".to_string()));
    }

    #[test]
    fn console_legacy_boxes_still_work() {
        use std::sync::{Arc, Mutex};
        let warns: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let w2 = warns.clone();
        let mut o = opts();
        o.console = ConsoleHandler {
            warn: Box::new(move |m| w2.lock().unwrap().push(m.to_string())),
            ..ConsoleHandler::default()
        };
        let rt = create_runtime(minimal_manifest(), o).unwrap();
        rt.execute("console.warn('careful'); console.debug('quiet')").unwrap();
        assert_eq!(*warns.lock().unwrap(), vec!["careful".to_string()]);
    }

    #[test]
    fn hard_limit_clamps_timeout() {
        let mut o = opts();
        o.hard_limits = Some(HardLimits {
            timeout_ms: Some(50),
            ..HardLimits::default()
        });
        let rt = create_runtime(
            r#"{ "xript": "0.1", "name": "t", "limits": { "timeout_ms": 60000 } }"#,
            o,
        )
        .unwrap();
        let result = rt.execute("while(true) {}");
        assert!(matches!(result, Err(XriptError::ExecutionLimit { .. })));
    }

    #[test]
    fn binding_ergonomics_builder_registers_namespace() {
        let manifest = r#"{
            "xript": "0.1", "name": "t",
            "bindings": {
                "app": {
                    "description": "ns",
                    "members": {
                        "click": { "description": "async click" },
                        "id": { "description": "sync id" },
                        "version": { "description": "prop" }
                    }
                }
            }
        }"#;
        let mut bindings = HostBindings::new();
        bindings
            .namespace("app")
            .bind("click", |_| async { Ok(serde_json::json!("clicked")) })
            .bind_sync("id", |_| Ok(serde_json::json!("the-id")))
            .property("version", serde_json::json!("1.0"))
            .finish();

        let o = RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        };
        let rt = create_runtime(manifest, o).unwrap();
        assert_eq!(rt.execute("app.version").unwrap().value, serde_json::json!("1.0"));
        assert_eq!(rt.execute("app.id()").unwrap().value, serde_json::json!("the-id"));
        assert_eq!(
            rt.execute("(async () => await app.click())()").unwrap().value,
            serde_json::json!("clicked")
        );
    }

    #[test]
    fn nested_namespace_two_levels() {
        let manifest = r#"{
            "xript": "0.1", "name": "t",
            "bindings": {
                "app": {
                    "description": "ns",
                    "members": {
                        "widget": {
                            "description": "sub-ns",
                            "members": {
                                "list": { "description": "lists widgets" }
                            }
                        }
                    }
                }
            }
        }"#;

        let mut list_members: HashMap<String, HostNamespaceMember> = HashMap::new();
        list_members.insert(
            "list".to_string(),
            HostNamespaceMember::Function(Arc::new(|_| Ok(serde_json::json!(["a", "b"])))),
        );
        let mut app_members: HashMap<String, HostNamespaceMember> = HashMap::new();
        app_members.insert(
            "widget".to_string(),
            HostNamespaceMember::Namespace(list_members),
        );

        let mut bindings = HostBindings::new();
        bindings.add_nested_namespace("app", app_members);

        let o = RuntimeOptions {
            host_bindings: bindings,
            ..RuntimeOptions::default()
        };
        let rt = create_runtime(manifest, o).unwrap();
        assert_eq!(
            rt.execute("app.widget.list()").unwrap().value,
            serde_json::json!(["a", "b"])
        );
        assert_eq!(
            rt.execute("Object.isFrozen(app) && Object.isFrozen(app.widget)").unwrap().value,
            serde_json::json!(true)
        );
    }

    #[test]
    fn nested_namespace_three_levels() {
        let manifest = r#"{
            "xript": "0.1", "name": "t",
            "bindings": {
                "a": { "description": "ns", "members": {
                    "b": { "description": "ns", "members": {
                        "c": { "description": "ns", "members": {
                            "deep": { "description": "leaf" }
                        }}
                    }}
                }}
            }
        }"#;
        let mut deep: HashMap<String, HostNamespaceMember> = HashMap::new();
        deep.insert("deep".into(), HostNamespaceMember::Function(Arc::new(|_| Ok(serde_json::json!("found")))));
        let mut c: HashMap<String, HostNamespaceMember> = HashMap::new();
        c.insert("c".into(), HostNamespaceMember::Namespace(deep));
        let mut b: HashMap<String, HostNamespaceMember> = HashMap::new();
        b.insert("b".into(), HostNamespaceMember::Namespace(c));
        let mut bindings = HostBindings::new();
        bindings.add_nested_namespace("a", b);
        let o = RuntimeOptions { host_bindings: bindings, ..RuntimeOptions::default() };
        let rt = create_runtime(manifest, o).unwrap();
        assert_eq!(rt.execute("a.b.c.deep()").unwrap().value, serde_json::json!("found"));
    }

    #[test]
    fn nested_namespace_leaf_capability_gating() {
        let manifest = r#"{
            "xript": "0.1", "name": "t",
            "bindings": {
                "app": { "description": "ns", "members": {
                    "widget": { "description": "ns", "members": {
                        "remove": { "description": "leaf", "capability": "destructive" }
                    }}
                }}
            },
            "capabilities": { "destructive": { "description": "z" } }
        }"#;
        let mut inner: HashMap<String, HostNamespaceMember> = HashMap::new();
        inner.insert("remove".into(), HostNamespaceMember::Function(Arc::new(|_| Ok(serde_json::json!("removed")))));
        let mut widget: HashMap<String, HostNamespaceMember> = HashMap::new();
        widget.insert("widget".into(), HostNamespaceMember::Namespace(inner));
        let mut bindings = HostBindings::new();
        bindings.add_nested_namespace("app", widget);
        let o = RuntimeOptions { host_bindings: bindings, capabilities: vec![], ..RuntimeOptions::default() };
        let rt = create_runtime(manifest, o).unwrap();
        let msg = rt.execute("try { app.widget.remove(); 'no' } catch(e) { e.message }").unwrap();
        assert!(msg.value.as_str().unwrap().contains("capability"));
    }

    #[test]
    fn host_invoke_export_round_trip() {
        let app = r#"{ "xript": "0.3", "name": "app", "slots": [{ "id": "s", "accepts": ["text/html"], "multiple": true }] }"#;
        let mod_json = r#"{
            "xript": "0.3", "name": "m", "version": "1.0.0",
            "entry": { "script": "main.js", "format": "script", "exports": {
                "shout": { "description": "uppercases", "params": [{ "name": "s", "type": "string" }], "returns": "string" }
            }},
            "fragments": [{ "id": "f", "slot": "s", "format": "text/html", "source": "<p>x</p>", "inline": true }]
        }"#;
        let rt = create_runtime(app, opts()).unwrap();
        rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            Some("xript.exports.register('shout', function(s) { return s.toUpperCase(); })"),
        )
        .unwrap();

        let result = rt.invoke_export("shout", &[serde_json::json!("hi")]).unwrap();
        assert_eq!(result, serde_json::json!("HI"));
    }

    #[test]
    fn host_invoke_export_unregistered_errors() {
        let rt = create_runtime(minimal_manifest(), opts()).unwrap();
        let result = rt.invoke_export("nope", &[]);
        assert!(matches!(result, Err(XriptError::Invoke { .. })));
        if let Err(XriptError::Invoke { message, .. }) = result {
            assert!(message.contains("not found"));
        }
    }

    #[test]
    fn host_invoke_export_throwing_surfaces_invoke_error() {
        let app = r#"{ "xript": "0.3", "name": "app", "slots": [{ "id": "s", "accepts": ["text/html"], "multiple": true }] }"#;
        let mod_json = r#"{
            "xript": "0.3", "name": "m", "version": "1.0.0",
            "entry": { "script": "main.js", "exports": { "boom": { "description": "throws" } } },
            "fragments": [{ "id": "f", "slot": "s", "format": "text/html", "source": "<p>x</p>", "inline": true }]
        }"#;
        let rt = create_runtime(app, opts()).unwrap();
        rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            Some("xript.exports.register('boom', function() { throw new Error('kaboom'); })"),
        )
        .unwrap();
        let result = rt.invoke_export("boom", &[]);
        assert!(matches!(result, Err(XriptError::Invoke { .. })));
        if let Err(XriptError::Invoke { message, .. }) = result {
            assert!(message.contains("kaboom"));
        }
    }

    #[test]
    fn host_invoke_export_capability_denied() {
        let app = r#"{ "xript": "0.3", "name": "app", "slots": [{ "id": "s", "accepts": ["text/html"], "multiple": true }] }"#;
        let mod_json = r#"{
            "xript": "0.3", "name": "m", "version": "1.0.0",
            "entry": { "script": "main.js", "exports": { "secret": { "description": "gated", "capability": "audio-read" } } },
            "fragments": [{ "id": "f", "slot": "s", "format": "text/html", "source": "<p>x</p>", "inline": true }]
        }"#;
        let rt = create_runtime(app, opts()).unwrap();
        rt.load_mod(
            mod_json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            Some("xript.exports.register('secret', function() { return 'leaked'; })"),
        )
        .unwrap();
        let result = rt.invoke_export("secret", &[]);
        assert!(matches!(result, Err(XriptError::CapabilityDenied { .. })));
    }

    #[test]
    fn slots_resolver_orders_by_priority_then_id() {
        let app = r#"{ "xript": "0.3", "name": "app", "slots": [{ "id": "bar", "accepts": ["text/html"], "multiple": true }] }"#;
        let rt = create_runtime(app, opts()).unwrap();

        let mk = |name: &str, fid: &str, prio: i32| {
            format!(
                r#"{{ "xript": "0.3", "name": "{name}", "version": "1.0.0", "fragments": [{{ "id": "{fid}", "slot": "bar", "format": "text/html", "source": "<p>x</p>", "inline": true, "priority": {prio} }}] }}"#
            )
        };
        rt.load_mod(&mk("m1", "alpha", 10), std::collections::HashMap::new(), &std::collections::HashSet::new(), None).unwrap();
        rt.load_mod(&mk("m2", "zeta", 10), std::collections::HashMap::new(), &std::collections::HashSet::new(), None).unwrap();
        rt.load_mod(&mk("m3", "omega", 50), std::collections::HashMap::new(), &std::collections::HashSet::new(), None).unwrap();

        let contributions = rt.resolve_slot("bar");
        assert_eq!(contributions.len(), 3);
        assert_eq!(contributions[0].fragment_id, "omega");
        assert_eq!(contributions[1].fragment_id, "alpha");
        assert_eq!(contributions[2].fragment_id, "zeta");
    }

    #[test]
    fn slots_resolver_single_cardinality_returns_winner() {
        let app = r#"{ "xript": "0.3", "name": "app", "slots": [{ "id": "solo", "accepts": ["text/html"] }] }"#;
        let rt = create_runtime(app, opts()).unwrap();
        let mk = |name: &str, fid: &str, prio: i32| {
            format!(
                r#"{{ "xript": "0.3", "name": "{name}", "version": "1.0.0", "fragments": [{{ "id": "{fid}", "slot": "solo", "format": "text/html", "source": "<p>x</p>", "inline": true, "priority": {prio} }}] }}"#
            )
        };
        rt.load_mod(&mk("m1", "low", 1), std::collections::HashMap::new(), &std::collections::HashSet::new(), None).unwrap();
        rt.load_mod(&mk("m2", "high", 99), std::collections::HashMap::new(), &std::collections::HashSet::new(), None).unwrap();
        let contributions = rt.resolve_slot("solo");
        assert_eq!(contributions.len(), 1);
        assert_eq!(contributions[0].fragment_id, "high");
        assert_eq!(rt.resolve_slot_single("solo").unwrap().fragment_id, "high");
    }

    #[test]
    fn slots_resolver_undeclared_returns_empty() {
        let app = r#"{ "xript": "0.3", "name": "app", "slots": [{ "id": "real", "accepts": ["text/html"] }] }"#;
        let rt = create_runtime(app, opts()).unwrap();
        assert!(rt.resolve_slot("ghost").is_empty());
        assert!(rt.resolve_slot_single("ghost").is_none());
    }

    #[test]
    fn manifest_extends_merges_bindings_and_appends_slots() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("xript-extends-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let base_path = dir.join("base.json");
        let mut f = std::fs::File::create(&base_path).unwrap();
        write!(
            f,
            r#"{{ "xript": "0.3", "name": "base", "bindings": {{ "log": {{ "description": "log" }} }}, "slots": [{{ "id": "main", "accepts": ["text/html"] }}] }}"#
        )
        .unwrap();

        let child = serde_json::json!({
            "xript": "0.3",
            "name": "child",
            "extends": "base.json",
            "bindings": { "alert": { "description": "alert" } },
            "slots": [{ "id": "side", "accepts": ["text/html"] }]
        });
        let resolved = resolve_extends(&child, &dir).unwrap();
        let bindings = resolved.get("bindings").unwrap().as_object().unwrap();
        assert!(bindings.contains_key("log"));
        assert!(bindings.contains_key("alert"));
        assert_eq!(resolved.get("name").unwrap(), "child");
        let slots = resolved.get("slots").unwrap().as_array().unwrap();
        assert_eq!(slots.len(), 2);
        assert!(resolved.get("extends").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manifest_extends_conflicting_ids_error() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("xript-extends-conflict-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let base_path = dir.join("base.json");
        let mut f = std::fs::File::create(&base_path).unwrap();
        write!(
            f,
            r#"{{ "xript": "0.3", "name": "base", "bindings": {{ "dup": {{ "description": "base" }} }} }}"#
        )
        .unwrap();
        let child = serde_json::json!({
            "xript": "0.3", "name": "child", "extends": "base.json",
            "bindings": { "dup": { "description": "child" } }
        });
        let result = resolve_extends(&child, &dir);
        assert!(matches!(result, Err(XriptError::ManifestValidation { .. })));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manifest_extends_cycle_detection() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("xript-extends-cycle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        write!(std::fs::File::create(&a).unwrap(), r#"{{ "xript": "0.3", "name": "a", "extends": "b.json" }}"#).unwrap();
        write!(std::fs::File::create(&b).unwrap(), r#"{{ "xript": "0.3", "name": "b", "extends": "a.json" }}"#).unwrap();
        let child = serde_json::json!({ "xript": "0.3", "name": "c", "extends": "a.json" });
        let result = resolve_extends(&child, &dir);
        assert!(matches!(result, Err(XriptError::ManifestValidation { .. })));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mod_manifest_family_field_round_trips() {
        let json = r#"{ "xript": "0.3", "name": "acme-tools", "family": "acme", "version": "1.0.0" }"#;
        let m: ModManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.family.as_deref(), Some("acme"));
    }

    #[test]
    fn mod_manifest_family_optional() {
        let json = r#"{ "xript": "0.3", "name": "loner", "version": "1.0.0" }"#;
        let m: ModManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.family, None);
    }

    #[test]
    fn entry_block_parses_bare_string() {
        let json = r#"{ "xript": "0.3", "name": "m", "version": "1.0.0", "entry": "main.js" }"#;
        let m: ModManifest = serde_json::from_str(json).unwrap();
        let entry = m.entry_block().unwrap();
        assert_eq!(entry.script.as_deref(), Some("main.js"));
        assert_eq!(entry.format, "script");
        assert!(entry.exports.is_empty());
    }

    #[test]
    fn entry_block_parses_object_with_exports() {
        let json = r#"{ "xript": "0.3", "name": "m", "version": "1.0.0",
            "entry": { "script": "main.js", "format": "module", "exports": {
                "transcribe": { "description": "t", "capability": "audio-read", "streaming": true }
            }} }"#;
        let m: ModManifest = serde_json::from_str(json).unwrap();
        let entry = m.entry_block().unwrap();
        assert_eq!(entry.format, "module");
        let exp = entry.exports.get("transcribe").unwrap();
        assert_eq!(exp.capability.as_deref(), Some("audio-read"));
        assert_eq!(exp.streaming, Some(true));
    }

    fn role_app_manifest() -> &'static str {
        r#"{ "xript": "0.3", "name": "host-app" }"#
    }

    fn role_runtime(role_preferences: HashMap<String, String>) -> XriptRuntime {
        create_runtime(
            role_app_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences,
                debug: None,
            },
        )
        .unwrap()
    }

    fn clip_mod(name: &str, query_fn: &str) -> String {
        format!(
            r#"{{
                "xript": "0.3", "name": "{name}", "version": "1.0.0",
                "contributions": {{ "provides": [
                    {{ "role": "clipboard-history", "fns": {{
                        "query": "{query_fn}", "restore": "{name}_restore" }} }}
                ] }}
            }}"#
        )
    }

    fn load_role_mod(rt: &XriptRuntime, json: &str) {
        rt.load_mod(
            json,
            std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            None,
        )
        .unwrap();
    }

    #[test]
    fn parses_contributions_provides_object_fns() {
        let m: ModManifest = serde_json::from_str(&clip_mod("clip-a", "a_query")).unwrap();
        let provides = m.contributions.unwrap().provides;
        assert_eq!(provides.len(), 1);
        assert_eq!(provides[0].role, "clipboard-history");
        assert_eq!(provides[0].fns.get("query").map(String::as_str), Some("a_query"));
        assert_eq!(provides[0].fns.get("restore").map(String::as_str), Some("clip-a_restore"));
    }

    #[test]
    fn resolve_role_first_installed_wins() {
        let rt = role_runtime(HashMap::new());
        load_role_mod(&rt, &clip_mod("clip-a", "a_query"));
        load_role_mod(&rt, &clip_mod("clip-b", "b_query"));
        let winner = rt.resolve_role("clipboard-history").unwrap();
        assert_eq!(winner.addon, "clip-a");
        assert_eq!(winner.role, "clipboard-history");
        assert_eq!(winner.fns.get("query").map(String::as_str), Some("a_query"));
    }

    #[test]
    fn resolve_role_preference_overrides_winner() {
        let mut prefs = HashMap::new();
        prefs.insert("clipboard-history".to_string(), "clip-b".to_string());
        let rt = role_runtime(prefs);
        load_role_mod(&rt, &clip_mod("clip-a", "a_query"));
        load_role_mod(&rt, &clip_mod("clip-b", "b_query"));
        let winner = rt.resolve_role("clipboard-history").unwrap();
        assert_eq!(winner.addon, "clip-b");
    }

    #[test]
    fn resolve_role_preference_for_nonprovider_falls_through() {
        let mut prefs = HashMap::new();
        prefs.insert("clipboard-history".to_string(), "ghost-addon".to_string());
        let rt = role_runtime(prefs);
        load_role_mod(&rt, &clip_mod("clip-a", "a_query"));
        let winner = rt.resolve_role("clipboard-history").unwrap();
        assert_eq!(winner.addon, "clip-a");
    }

    #[test]
    fn resolve_role_all_returns_load_order() {
        let rt = role_runtime(HashMap::new());
        load_role_mod(&rt, &clip_mod("clip-a", "a_query"));
        load_role_mod(&rt, &clip_mod("clip-b", "b_query"));
        load_role_mod(&rt, &clip_mod("clip-c", "c_query"));
        let all = rt.resolve_role_all("clipboard-history");
        let names: Vec<&str> = all.iter().map(|r| r.addon.as_str()).collect();
        assert_eq!(names, vec!["clip-a", "clip-b", "clip-c"]);
    }

    #[test]
    fn resolve_role_unprovided_is_none() {
        let rt = role_runtime(HashMap::new());
        load_role_mod(&rt, &clip_mod("clip-a", "a_query"));
        assert!(rt.resolve_role("no-such-role").is_none());
        assert!(rt.resolve_role_all("no-such-role").is_empty());
    }

    #[test]
    fn rejects_duplicate_role_within_mod() {
        let json = r#"{
            "xript": "0.3", "name": "dup-mod", "version": "1.0.0",
            "contributions": { "provides": [
                { "role": "clipboard-history", "fns": { "query": "q1" } },
                { "role": "clipboard-history", "fns": { "query": "q2" } }
            ] }
        }"#;
        let m: ModManifest = serde_json::from_str(json).unwrap();
        let err = manifest::validate_mod_manifest(&m).unwrap_err();
        assert!(matches!(err, XriptError::ManifestValidation { .. }));
    }

    #[test]
    fn rejects_invalid_role_identifier() {
        let json = r#"{
            "xript": "0.3", "name": "bad-mod", "version": "1.0.0",
            "contributions": { "provides": [
                { "role": "Clipboard_History", "fns": { "query": "q1" } }
            ] }
        }"#;
        let m: ModManifest = serde_json::from_str(json).unwrap();
        assert!(manifest::validate_mod_manifest(&m).is_err());
    }

    #[test]
    fn rejects_empty_fns_map() {
        let json = r#"{
            "xript": "0.3", "name": "empty-mod", "version": "1.0.0",
            "contributions": { "provides": [
                { "role": "clipboard-history", "fns": {} }
            ] }
        }"#;
        let m: ModManifest = serde_json::from_str(json).unwrap();
        assert!(manifest::validate_mod_manifest(&m).is_err());
    }

    #[test]
    fn role_identifier_rules() {
        assert!(is_role_identifier("clipboard-history"));
        assert!(is_role_identifier("a"));
        assert!(is_role_identifier("a1-2-3"));
        assert!(!is_role_identifier("1abc"));
        assert!(!is_role_identifier("-abc"));
        assert!(!is_role_identifier("ABC"));
        assert!(!is_role_identifier(""));
        assert!(!is_role_identifier(&"a".repeat(65)));
    }

    #[test]
    fn record_field_schema_parses_default_and_enum() {
        let json = r#"{
            "xript": "0.3", "name": "rec-app",
            "types": {
                "BrickFiles": {
                    "fields": {
                        "path": { "type": "string", "optional": true },
                        "pathStyle": { "type": "string", "enum": ["posix", "hybrid", "native"], "default": "posix" },
                        "viewingEnabled": { "type": "boolean", "default": true }
                    }
                }
            }
        }"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        let types = m.types.unwrap();
        let bf = types.get("BrickFiles").unwrap();
        let fields = bf.fields.as_ref().unwrap();
        assert!(fields.get("path").unwrap().optional);
        let style = fields.get("pathStyle").unwrap();
        assert_eq!(style.default, Some(serde_json::json!("posix")));
        assert_eq!(style.r#enum.as_ref().unwrap().len(), 3);
        assert_eq!(
            fields.get("viewingEnabled").unwrap().default,
            Some(serde_json::json!(true))
        );
    }

    #[test]
    fn record_schema_runtime_tolerates_types_block() {
        let json = r#"{
            "xript": "0.3", "name": "rec-app",
            "types": { "Tag": { "values": ["red", "green"] } }
        }"#;
        let rt = create_runtime(
            json,
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        );
        assert!(rt.is_ok());
    }

    #[test]
    fn capability_prompt_round_trips() {
        let json = r#"{
            "capability": "clipboard-read",
            "description": "Read clipboard history",
            "risk": "medium",
            "mod": { "name": "clip-a", "version": "1.0.0" },
            "requestedScope": "session",
            "state": "first-time"
        }"#;
        let prompt: CapabilityPrompt = serde_json::from_str(json).unwrap();
        assert_eq!(prompt.requested_scope, RequestedScope::Session);
        assert_eq!(prompt.state, PromptState::FirstTime);
        prompt.validate().unwrap();
        let back = serde_json::to_value(&prompt).unwrap();
        assert_eq!(back.get("requestedScope").unwrap(), "session");
        assert_eq!(back.get("state").unwrap(), "first-time");
        assert_eq!(back.get("mod").unwrap().get("name").unwrap(), "clip-a");
    }

    #[test]
    fn capability_prompt_rejects_bad_risk() {
        let prompt = CapabilityPrompt {
            capability: "x".into(),
            description: "d".into(),
            risk: "extreme".into(),
            requesting_mod: PromptMod { name: "m".into(), version: "1".into(), title: None },
            requested_scope: RequestedScope::OneRun,
            state: PromptState::FirstTime,
            reason: None,
        };
        assert!(prompt.validate().is_err());
    }

    #[test]
    fn install_descriptor_round_trips_and_validates() {
        let json = r#"{
            "name": "clip-a", "version": "1.0.0",
            "source": { "type": "registry", "location": "xript:clip-a" },
            "integrity": "sha256-abc",
            "capabilities": ["clipboard-read"]
        }"#;
        let desc: InstallDescriptor = serde_json::from_str(json).unwrap();
        assert_eq!(desc.source.source_type, InstallSourceType::Registry);
        desc.validate().unwrap();
        let back = serde_json::to_value(&desc).unwrap();
        assert_eq!(back.get("source").unwrap().get("type").unwrap(), "registry");
        assert!(back.get("signature").is_none());
    }

    #[test]
    fn install_descriptor_rejects_bad_name() {
        let desc = InstallDescriptor {
            name: "Bad Name".into(),
            version: "1.0.0".into(),
            title: None,
            source: InstallSource { source_type: InstallSourceType::File, location: "x".into() },
            integrity: None,
            signature: None,
            capabilities: vec![],
            manifest: None,
        };
        assert!(desc.validate().is_err());
    }

    #[test]
    fn discovery_result_round_trips_with_provides() {
        let json = r#"{
            "mods": [
                { "name": "clip-a", "version": "1.0.0", "location": "/mods/clip-a",
                  "enabled": true, "capabilities": ["clipboard-read"],
                  "provides": ["clipboard-history"] }
            ],
            "scannedAt": 1717000000000
        }"#;
        let result: DiscoveryResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.mods.len(), 1);
        assert_eq!(result.mods[0].provides, vec!["clipboard-history"]);
        result.validate().unwrap();
        let back = serde_json::to_value(&result).unwrap();
        assert!(back.get("scannedAt").is_some());
    }

    #[test]
    fn discovery_result_rejects_bad_role() {
        let result = DiscoveryResult {
            mods: vec![DiscoveredMod {
                name: "clip-a".into(),
                version: "1.0.0".into(),
                title: None,
                location: "/x".into(),
                enabled: true,
                capabilities: vec![],
                provides: vec!["Bad Role".into()],
            }],
            scanned_at: 0.0,
        };
        assert!(result.validate().is_err());
    }

    fn debug_runtime(opts: DebugOptions) -> XriptRuntime {
        create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: Some(opts),
            },
        )
        .unwrap()
    }

    #[test]
    fn debug_absent_by_default() {
        let rt = create_runtime(
            minimal_manifest(),
            RuntimeOptions {
                host_bindings: HostBindings::new(),
                capabilities: vec![],
                console: ConsoleHandler::default(),
                cancellation: None,
                audit: None,
                hard_limits: None,
                libraries: HashMap::new(),
                role_preferences: HashMap::new(),
                debug: None,
            },
        )
        .unwrap();
        assert!(rt.debug_session().is_none());
    }

    #[test]
    fn debug_session_present_when_enabled() {
        let rt = debug_runtime(DebugOptions::default());
        let session = rt.debug_session().unwrap();
        assert_eq!(session.fidelity(), DebugFidelity::Instrumented);
    }

    #[test]
    fn dap_structs_serialize_with_canonical_field_names() {
        let stopped = StoppedEvent {
            reason: StopReason::Breakpoint,
            thread_id: DEBUG_THREAD_ID,
            hit_breakpoint_ids: Some(vec![1]),
            description: None,
        };
        let v = serde_json::to_value(&stopped).unwrap();
        assert_eq!(v.get("reason").unwrap(), "breakpoint");
        assert_eq!(v.get("threadId").unwrap(), 1);
        assert_eq!(v.get("hitBreakpointIds").unwrap(), &serde_json::json!([1]));

        let scope = Scope { name: "Local".into(), variables_reference: 7, expensive: false };
        let sv = serde_json::to_value(&scope).unwrap();
        assert_eq!(sv.get("variablesReference").unwrap(), 7);

        let var = Variable {
            name: "x".into(),
            value: "1".into(),
            r#type: Some("number".into()),
            variables_reference: 0,
        };
        let vv = serde_json::to_value(&var).unwrap();
        assert_eq!(vv.get("variablesReference").unwrap(), 0);
        assert_eq!(vv.get("type").unwrap(), "number");
    }

    #[test]
    fn set_breakpoints_replaces_and_verifies() {
        let rt = debug_runtime(DebugOptions::default());
        let session = rt.debug_session().unwrap();
        let bps = session.set_breakpoints(
            "main.js",
            &[
                SourceBreakpoint { line: 3, column: None, condition: None },
                SourceBreakpoint { line: 0, column: None, condition: None },
            ],
        );
        assert_eq!(bps.len(), 2);
        assert!(bps[0].verified);
        assert!(!bps[1].verified);
        assert_eq!(bps[0].source, "main.js");

        let replaced = session.set_breakpoints("main.js", &[SourceBreakpoint {
            line: 5, column: None, condition: None,
        }]);
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].line, 5);
    }

    #[test]
    fn instrument_source_injects_probes() {
        let src = "let a = 1;\n// comment\nlet b = 2;\n}";
        let out = instrument_source(src);
        assert!(out.contains("__xript_dbg(1, 1); let a = 1;"));
        assert!(out.contains("__xript_dbg(3, 1); let b = 2;"));
        assert!(!out.contains("__xript_dbg(2"));
        assert!(!out.contains("__xript_dbg(4"));
    }

    #[test]
    fn debug_breakpoint_pause_and_resume_cycle() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let stop_count = Arc::new(AtomicUsize::new(0));
        let stop_count_sink = stop_count.clone();

        let rt = std::sync::Arc::new(debug_runtime(DebugOptions {
            on_stopped: Some(Arc::new(move |event: StoppedEvent| {
                assert_eq!(event.thread_id, DEBUG_THREAD_ID);
                stop_count_sink.fetch_add(1, Ordering::SeqCst);
            })),
            ..Default::default()
        }));

        let session = rt.debug_session().unwrap().clone();
        session.set_breakpoints("inline", &[SourceBreakpoint {
            line: 2, column: None, condition: None,
        }]);

        let rt_exec = rt.clone();
        let exec = std::thread::spawn(move || {
            let code = instrument_source("var x = 1;\nvar y = x + 1;\ny;");
            rt_exec.execute(&code)
        });

        let resume_session = session.clone();
        let watchdog = std::thread::spawn(move || {
            for _ in 0..200 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                if !resume_session.stack_trace().is_empty() {
                    resume_session.resume();
                    return;
                }
            }
            resume_session.resume();
        });

        let result = exec.join().unwrap();
        watchdog.join().unwrap();
        assert!(result.is_ok(), "execution failed: {:?}", result.err());
        assert!(stop_count.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn debug_stack_trace_and_scopes_while_paused() {
        let rt = std::sync::Arc::new(debug_runtime(DebugOptions::default()));
        let session = rt.debug_session().unwrap().clone();
        session.set_breakpoints("inline", &[SourceBreakpoint {
            line: 1, column: None, condition: None,
        }]);

        let rt_exec = rt.clone();
        let exec = std::thread::spawn(move || {
            let code = instrument_source("var a = 41;\nvar b = a + 1;\nb;");
            rt_exec.execute(&code)
        });

        let probe_session = session.clone();
        let checker = std::thread::spawn(move || {
            for _ in 0..200 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                let frames = probe_session.stack_trace();
                if !frames.is_empty() {
                    assert_eq!(frames[0].source, "<entry>");
                    let scopes = probe_session.scopes(frames[0].id);
                    assert_eq!(scopes.len(), 2);
                    assert_eq!(scopes[0].name, "Local");
                    assert_eq!(scopes[1].name, "Global");
                    assert!(probe_session.variables(0).is_empty());
                    assert!(probe_session.variables(scopes[0].variables_reference).is_empty());
                    probe_session.resume();
                    return true;
                }
            }
            probe_session.resume();
            false
        });

        let result = exec.join().unwrap();
        let paused = checker.join().unwrap();
        assert!(result.is_ok());
        assert!(paused, "never observed a paused frame");
    }

    #[test]
    fn debug_evaluate_is_unsupported() {
        let rt = debug_runtime(DebugOptions::default());
        let session = rt.debug_session().unwrap();
        assert!(session.evaluate("1 + 1", None).is_err());
    }

    #[test]
    fn debug_no_breakpoint_runs_to_completion() {
        let rt = debug_runtime(DebugOptions::default());
        let code = instrument_source("var x = 2;\nvar y = x * 3;\ny;");
        let result = rt.execute(&code).unwrap();
        assert_eq!(result.value, serde_json::json!(6));
    }

    fn caps_runtime(manifest: &str, capabilities: Vec<String>) -> XriptRuntime {
        create_runtime(
            manifest,
            RuntimeOptions {
                capabilities,
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn binding_gate_honors_scope_subsumption() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "bindings": {
                "runCommand": { "description": "runs", "capability": "run.command" }
            },
            "capabilities": { "run.command": { "description": "run" } }
        }"#;

        let mut with = HostBindings::new();
        with.add_function("runCommand", |_: &[serde_json::Value]| {
            Ok(serde_json::json!("ran"))
        });
        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: with,
                capabilities: vec!["run".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rt.execute("runCommand()").unwrap().value, serde_json::json!("ran"));
    }

    #[test]
    fn binding_gate_denies_when_child_grant_does_not_cover_parent_require() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "bindings": {
                "run": { "description": "runs", "capability": "run" }
            },
            "capabilities": { "run": { "description": "run" } }
        }"#;

        let mut with = HostBindings::new();
        with.add_function("run", |_: &[serde_json::Value]| {
            Ok(serde_json::json!("ran"))
        });
        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: with,
                capabilities: vec!["run.command".into()],
                ..Default::default()
            },
        )
        .unwrap();
        let msg = rt
            .execute("try { run(); 'no error' } catch(e) { e.message }")
            .unwrap();
        assert!(msg.value.as_str().unwrap().contains("capability"));
    }

    #[test]
    fn binding_gate_mode_lattice_read_grant_denies_write_require() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "bindings": {
                "writeFs": { "description": "writes", "capability": "write:fs.addon" }
            },
            "capabilities": { "fs.addon": { "description": "fs" } }
        }"#;

        let mut with = HostBindings::new();
        with.add_function("writeFs", |_: &[serde_json::Value]| {
            Ok(serde_json::json!("wrote"))
        });
        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: with,
                capabilities: vec!["read:fs.addon".into()],
                ..Default::default()
            },
        )
        .unwrap();
        let msg = rt
            .execute("try { writeFs(); 'no error' } catch(e) { e.message }")
            .unwrap();
        assert!(msg.value.as_str().unwrap().contains("capability"));
    }

    #[test]
    fn binding_gate_mode_lattice_write_grant_satisfies_read_require() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "bindings": {
                "readFs": { "description": "reads", "capability": "read:fs.addon" }
            },
            "capabilities": { "fs.addon": { "description": "fs" } }
        }"#;

        let mut with = HostBindings::new();
        with.add_function("readFs", |_: &[serde_json::Value]| {
            Ok(serde_json::json!("read"))
        });
        let rt = create_runtime(
            manifest,
            RuntimeOptions {
                host_bindings: with,
                capabilities: vec!["fs.addon".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rt.execute("readFs()").unwrap().value, serde_json::json!("read"));
    }

    #[test]
    fn events_global_is_injected_for_declared_events() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "events": [ { "id": "player.died", "description": "fired on death" } ]
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        assert_eq!(
            rt.execute("typeof events.on").unwrap().value,
            serde_json::json!("function")
        );
        assert_eq!(
            rt.execute("typeof events.subscribe").unwrap().value,
            serde_json::json!("function")
        );
    }

    #[test]
    fn emit_delivers_object_payload_spread_to_subscriber() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "events": [ { "id": "player.hurt", "description": "fired on damage" } ]
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        rt.execute(
            "globalThis.__seen = null; events.on('player.hurt', function(amount, source) { globalThis.__seen = amount + ':' + source; });",
        )
        .unwrap();

        let results = rt
            .emit("player.hurt", &[serde_json::json!({ "amount": 7, "source": "fire" })])
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(
            rt.execute("globalThis.__seen").unwrap().value,
            serde_json::json!("7:fire")
        );
    }

    #[test]
    fn emit_collects_results_in_registration_order() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "events": [ { "id": "tick", "description": "a tick" } ]
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        rt.execute("events.on('tick', function(n) { return n + 1; });").unwrap();
        rt.execute("events.on('tick', function(n) { return n * 10; });").unwrap();

        let results = rt.emit("tick", &[serde_json::json!(5)]).unwrap();
        assert_eq!(results, vec![serde_json::json!(6), serde_json::json!(50)]);
    }

    #[test]
    fn emit_swallows_per_handler_errors_to_null() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "events": [ { "id": "boom", "description": "a boom" } ]
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        rt.execute("events.on('boom', function() { throw new Error('handler failed'); });").unwrap();
        rt.execute("events.on('boom', function() { return 'ok'; });").unwrap();

        let results = rt.emit("boom", &[]).unwrap();
        assert_eq!(results, vec![serde_json::Value::Null, serde_json::json!("ok")]);
    }

    #[test]
    fn emit_unknown_event_delivers_to_nobody() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "events": [ { "id": "known", "description": "known" } ]
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        let results = rt.emit("unknown", &[serde_json::json!(1)]).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn events_subscription_is_capability_gated() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "capabilities": { "spectate": { "description": "watch" } },
            "events": [ { "id": "secret", "description": "gated", "capability": "spectate" } ]
        }"#;

        let denied = caps_runtime(manifest, vec![]);
        let msg = denied
            .execute("try { events.on('secret', function() {}); 'admitted' } catch(e) { e.message }")
            .unwrap();
        assert!(msg.value.as_str().unwrap().contains("capability"));

        let allowed = caps_runtime(manifest, vec!["spectate".into()]);
        let admitted = allowed
            .execute("try { events.on('secret', function() {}); 'admitted' } catch(e) { e.message }")
            .unwrap();
        assert_eq!(admitted.value, serde_json::json!("admitted"));
    }

    #[test]
    fn events_subscription_gate_honors_mode_lattice() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "capabilities": { "world.events": { "description": "world" } },
            "events": [ { "id": "quake", "description": "gated", "capability": "read:world.events" } ]
        }"#;

        let granted = caps_runtime(manifest, vec!["write:world".into()]);
        let admitted = granted
            .execute("try { events.on('quake', function() {}); 'admitted' } catch(e) { e.message }")
            .unwrap();
        assert_eq!(admitted.value, serde_json::json!("admitted"));
    }

    #[test]
    fn fire_hook_delivers_to_registered_handlers() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "hooks": { "beforeSave": { "description": "before save" } }
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        rt.execute("hooks.beforeSave(function(doc) { return doc + '!'; });").unwrap();

        let results = rt.fire_hook("beforeSave", &[serde_json::json!("draft")]).unwrap();
        assert_eq!(results, vec![serde_json::json!("draft!")]);
    }

    #[test]
    fn fire_hook_dispatches_event_typed_slot() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "slots": [
                { "id": "playerDamage", "accepts": ["application/x-xript-hook"], "description": "took damage" }
            ]
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        rt.execute("globalThis.__hit = 0; hooks.playerDamage(function(amount) { globalThis.__hit = amount; });")
            .unwrap();

        let results = rt
            .fire_hook("playerDamage", &[serde_json::json!({ "amount": 25 })])
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(
            rt.execute("globalThis.__hit").unwrap().value.as_f64(),
            Some(25.0)
        );
    }

    #[test]
    fn event_typed_slot_hook_registration_is_capability_gated() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "capabilities": { "persistence": { "description": "save" } },
            "slots": [
                { "id": "save", "accepts": ["application/x-xript-hook"], "description": "save", "capability": "persistence.disk" }
            ]
        }"#;

        let denied = caps_runtime(manifest, vec![]);
        let msg = denied
            .execute("try { hooks.save(function() {}); 'ok' } catch(e) { e.message }")
            .unwrap();
        assert!(
            msg.value.as_str().unwrap().contains("capability"),
            "ungranted slot-hook should throw, got {:?}",
            msg.value
        );

        let granted = caps_runtime(manifest, vec!["persistence".into()]);
        let ok = granted
            .execute("try { hooks.save(function() {}); 'ok' } catch(e) { e.message }")
            .unwrap();
        assert_eq!(ok.value, serde_json::json!("ok"));
    }

    #[test]
    fn explicit_hook_wins_over_same_id_slot() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test",
            "hooks": { "save": { "description": "explicit", "phases": ["pre", "post"] } },
            "slots": [
                { "id": "save", "accepts": ["application/x-xript-hook"], "description": "slot" }
            ]
        }"#;
        let rt = caps_runtime(manifest, vec![]);
        let phased = rt
            .execute("typeof hooks.save === 'object' && typeof hooks.save.pre === 'function'")
            .unwrap();
        assert_eq!(phased.value, serde_json::json!(true));
    }

    #[test]
    fn handle_emit_delivers_event() {
        let manifest = r#"{
            "xript": "0.7",
            "name": "test-app",
            "events": [ { "id": "ready", "description": "ready" } ]
        }"#;
        let handle = handle::XriptHandle::new(
            manifest.to_string(),
            RuntimeOptions::default(),
        )
        .unwrap();
        handle
            .execute("globalThis.__ready = false; events.on('ready', function() { globalThis.__ready = true; });")
            .unwrap();
        let results = handle.emit("ready", &[]).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(
            handle.execute("globalThis.__ready").unwrap().value,
            serde_json::json!(true)
        );
    }
}
