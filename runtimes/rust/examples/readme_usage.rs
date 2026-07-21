//! Compiles and runs the `Usage` example from README.md, so the crate's front-page snippet can
//! never drift from the real API again — a new `RuntimeOptions` field broke it once. Keep this in
//! step with the README block.

use xript_runtime::{create_runtime, ConsoleHandler, HostBindings, RuntimeOptions};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = r#"{
        "xript": "0.8",
        "name": "my-app",
        "bindings": {
            "greet": {
                "description": "Returns a greeting.",
                "params": [{ "name": "name", "type": "string" }]
            }
        }
    }"#;

    let mut bindings = HostBindings::new();
    bindings.add_function("greet", |args: &[serde_json::Value]| {
        let name = args.first().and_then(|v| v.as_str()).unwrap_or("World");
        Ok(serde_json::json!(format!("Hello, {}!", name)))
    });

    let runtime = create_runtime(
        manifest,
        RuntimeOptions {
            host_bindings: bindings,
            capabilities: vec![],
            console: ConsoleHandler::default(),
            ..Default::default()
        },
    )?;

    let result = runtime.execute("greet(\"World\")")?;
    assert_eq!(result.value, serde_json::json!("Hello, World!"));
    println!("{}", result.value);
    Ok(())
}
