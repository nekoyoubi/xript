# xript-runtime

Native Rust runtime for [xript](https://github.com/nekoyoubi/xript): sandboxed JavaScript execution via QuickJS (rquickjs).

[![Crates.io](https://img.shields.io/crates/v/xript-runtime)](https://crates.io/crates/xript-runtime)

## Install

```toml
[dependencies]
xript-runtime = "0.1"
```

## Usage

```rust
use xript_runtime::{create_runtime, RuntimeOptions, HostBindings, ConsoleHandler};

let manifest = r#"{
    "xript": "0.1",
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

let runtime = create_runtime(manifest, RuntimeOptions {
    host_bindings: bindings,
    capabilities: vec![],
    console: ConsoleHandler::default(),
})?;

let result = runtime.execute("greet(\"World\")")?;
// result.value == "Hello, World!"
// result.duration_ms == 0.1 (approx)
```

## What it does

- Runs user-provided JavaScript inside a native QuickJS sandbox (via rquickjs)
- Only functions declared in the manifest are available to scripts; everything else is blocked
- Supports capability-gated bindings, namespace bindings, hooks, and resource limits
- No `eval`, no `Function`, no access to the host environment

## API

### `create_runtime(manifest_json, options) -> Result<XriptRuntime>`

Creates a sandboxed runtime from a JSON manifest string and options.

### `create_runtime_from_file(path, options) -> Result<XriptRuntime>`

Reads a manifest JSON file from disk and creates a runtime.

### `create_runtime_from_value(manifest, options) -> Result<XriptRuntime>`

Creates a runtime from a `serde_json::Value` manifest.

### `runtime.execute(code) -> Result<ExecutionResult>`

Executes JavaScript code in the sandbox. Returns `ExecutionResult { value, duration_ms }`.

### `runtime.manifest() -> &Manifest`

Returns a reference to the parsed manifest.

## When to use this vs `@xriptjs/runtime`

| | `xript-runtime` | `@xriptjs/runtime` | `@xriptjs/runtime-node` |
|---|---|---|---|
| Language | Rust | JavaScript/TypeScript | JavaScript/TypeScript |
| Runs in browser | No | Yes | No |
| Sandbox mechanism | QuickJS (native) | QuickJS WASM | Node.js `vm` module |
| Async bindings | Not yet | Via asyncify WASM | Native `async`/`await` |
| Best for | Rust apps, game engines, native tools | Cross-platform, browser, edge | Node.js servers, CLI tools |

Use this crate when your host application is written in Rust. Use `@xriptjs/runtime` for JavaScript environments that need universal portability. Use `@xriptjs/runtime-node` for Node.js-only applications.

## Documentation

[xript.dev](https://xript.dev): full docs, getting started guide, and live demos.

## License

MIT
