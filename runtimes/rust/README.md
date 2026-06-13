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
    "xript": "0.7",
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
- Supports capability-gated bindings, namespace bindings (sync and async), hooks, and resource limits
- Async namespaces via a `namespace_builder` combinator, `add_mixed_namespace` for property values alongside callable functions, and recursion into nested namespace members
- `XriptHandle`, a `Send`+`Sync` wrapper for driving a runtime across threads
- No `eval`, no `Function`, no access to the host environment

### v0.5.0

- `data:` URI subtype gate: `sanitize_html` now keeps only `data:image/{png,jpeg,gif,svg+xml}` and strips the rest, closing a `data:text/html` XSS hole that any embedding host inherited
- cooperative cancellation via a `CancellationToken` on `RuntimeOptions`; it interrupts in-flight execution at the next check point and surfaces a distinct cancellation error (not a timeout), with rquickjs interrupting mid-run
- opt-in capability audit channel: a hook reporting every allowed host-binding invocation as `{ binding, capability, at }`
- console severity: `ConsoleHandler` gained a severity enum (log/info/warn/error/debug) plus a trace channel
- sandbox hard caps: host ceilings on memory, CPU time, and stack depth
- manifest `extends` with deep-merge so a manifest can inherit and override host bindings; mod manifests gained an optional `family` field for grouping
- host-invoke exports: mods declare named exports the host calls by name and whose return value it honors
- ES module mods via `entry.format: "module"`, which evaluates the entry as a real ES module; top-level named exports auto-register as host-invokable, and external imports stay denied
- provider-role resolution: mods declare `contributions.provides` and the host calls `resolve_role(role)` (first-installed-wins, settings-overridable) to bind a logical role to a concrete export
- slot runtime resolver: ordering by priority, single/multiple cardinality, and capability enforcement on contributions
- DAP-shaped debug protocol: set/clear breakpoints by source position, pause/resume/step in/over/out, and inspect scopes, locals, and stack frames (rquickjs 0.10 exposes no per-line hook, so fidelity is documented)
- fixed async workflows swallowing uncaught throws; a rejected top-level promise now surfaces the real rejection instead of reading as a successful `undefined`

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
| Async bindings | Native (`namespace_builder`) | Via asyncify WASM | Native `async`/`await` |
| Best for | Rust apps, game engines, native tools | Cross-platform, browser, edge | Node.js servers, CLI tools |

Use this crate when your host application is written in Rust. Use `@xriptjs/runtime` for JavaScript environments that need universal portability. Use `@xriptjs/runtime-node` for Node.js-only applications.

## Documentation

[xript.dev](https://xript.dev): full docs, getting started guide, and live demos.

## License

MIT
