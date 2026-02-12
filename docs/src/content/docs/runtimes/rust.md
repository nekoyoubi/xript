---
title: Rust Runtime
description: Native Rust runtime for sandboxed xript script execution via QuickJS.
---

The Rust runtime (`xript-runtime`) executes user scripts inside a native QuickJS sandbox powered by [rquickjs](https://github.com/niclas-aspect/rquickjs). It provides the same manifest-driven binding model and capability enforcement as the JS/WASM and Node.js runtimes, but as a Rust crate with no WASM overhead.

For applications that need to run in browsers or other JavaScript environments, use the [JS/WASM Runtime](/runtimes/js-wasm). For Node.js-only applications, see the [Node.js Runtime](/runtimes/node).

## When to Use Which Runtime

| | Universal (`@xriptjs/runtime`) | Node.js (`@xriptjs/runtime-node`) | Rust (`xript-runtime`) |
|---|---|---|---|
| **Sandbox** | QuickJS WASM | Node.js `vm` module | QuickJS via rquickjs (native) |
| **Environments** | Browser, Node, Deno, Bun, Workers | Node.js only | Any Rust application |
| **Manifest loading** | Pass manifest object directly | `createRuntimeFromFile` loads from disk | `create_runtime` (JSON string), `create_runtime_from_file` |
| **Validation** | Basic structural checks | Basic structural checks | Basic structural checks |
| **Async bindings** | Via `initXriptAsync()` (asyncify WASM) | Native `async`/`await` | Not yet (sync only) |
| **Memory isolation** | Separate WASM heap per runtime | Shared Node.js process memory | Separate QuickJS heap per runtime |
| **Best for** | Cross-platform apps, browser-based tools | Node.js servers, CLI tools, build pipelines | Rust applications, game engines, native tools |

All three runtimes implement the same xript specification and enforce the same security guarantees.

## Installation

Add `xript-runtime` to your `Cargo.toml`:

```toml
[dependencies]
xript-runtime = "0.1"
```

## Creating a Runtime

### From a JSON String

```rust
use xript_runtime::{create_runtime, RuntimeOptions, HostBindings, ConsoleHandler};

let manifest_json = r#"{
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
    let name = args.first()
        .and_then(|v| v.as_str())
        .unwrap_or("World");
    Ok(serde_json::json!(format!("Hello, {}!", name)))
});

let runtime = create_runtime(manifest_json, RuntimeOptions {
    host_bindings: bindings,
    capabilities: vec![],
    console: ConsoleHandler::default(),
})?;
```

### From a File

```rust
use std::path::Path;
use xript_runtime::{create_runtime_from_file, RuntimeOptions, HostBindings, ConsoleHandler};

let runtime = create_runtime_from_file(
    Path::new("manifest.json"),
    RuntimeOptions {
        host_bindings: HostBindings::new(),
        capabilities: vec![],
        console: ConsoleHandler::default(),
    },
)?;
```

### From a `serde_json::Value`

```rust
use xript_runtime::{create_runtime_from_value, RuntimeOptions, HostBindings, ConsoleHandler};

let manifest = serde_json::json!({
    "xript": "0.1",
    "name": "my-app"
});

let runtime = create_runtime_from_value(manifest, RuntimeOptions {
    host_bindings: HostBindings::new(),
    capabilities: vec![],
    console: ConsoleHandler::default(),
})?;
```

## Options

`RuntimeOptions` has three fields:

| Field | Type | Description |
|-------|------|-------------|
| `host_bindings` | `HostBindings` | Map of binding names to host functions |
| `capabilities` | `Vec<String>` | List of capabilities granted to this script |
| `console` | `ConsoleHandler` | Console output routing (`log`, `warn`, `error` callbacks) |

### Host Bindings

Host bindings map binding names to Rust closures. Each closure receives a slice of `serde_json::Value` arguments and returns `Result<serde_json::Value, String>`:

```rust
let mut bindings = HostBindings::new();

bindings.add_function("add", |args: &[serde_json::Value]| {
    let a = args.get(0).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let b = args.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
    Ok(serde_json::json!(a + b))
});
```

For namespace bindings, use `add_namespace` with a `HashMap` of member functions:

```rust
use std::collections::HashMap;
use std::sync::Arc;
use xript_runtime::HostFn;

let mut members: HashMap<String, HostFn> = HashMap::new();
members.insert("getName".into(), Arc::new(|_| Ok(serde_json::json!("Hero"))));
members.insert("getHealth".into(), Arc::new(|_| Ok(serde_json::json!(100))));

bindings.add_namespace("player", members);
```

### Console Handler

Route `console.log`, `console.warn`, and `console.error` from scripts to Rust callbacks:

```rust
use xript_runtime::ConsoleHandler;

let console = ConsoleHandler {
    log: Box::new(|msg| println!("[LOG] {}", msg)),
    warn: Box::new(|msg| eprintln!("[WARN] {}", msg)),
    error: Box::new(|msg| eprintln!("[ERROR] {}", msg)),
};
```

The default `ConsoleHandler` silently discards all output.

## Executing Scripts

```rust
let result = runtime.execute("2 + 2")?;
// result.value == serde_json::json!(4)
// result.duration_ms == 0.1 (approx)
```

`execute` runs the code synchronously and returns an `ExecutionResult`:

| Field | Type | Description |
|-------|------|-------------|
| `value` | `serde_json::Value` | The result of the last expression |
| `duration_ms` | `f64` | Wall-clock execution time in milliseconds |

## Error Types

All errors are variants of `XriptError`:

| Variant | When |
|---------|------|
| `ManifestValidation { issues }` | Manifest fails structural validation |
| `Binding { binding, message }` | Host function throws or is missing |
| `CapabilityDenied { binding, capability }` | Calling a gated binding without the required capability |
| `ExecutionLimit { limit }` | Script exceeds timeout or resource limits |
| `Script(String)` | Script throws an uncaught error |
| `Engine(String)` | QuickJS engine error |
| `Json(serde_json::Error)` | Manifest JSON parsing failed |
| `Io(std::io::Error)` | File I/O failed (for `create_runtime_from_file`) |

## Sandbox Details

The sandbox provides a restricted JavaScript environment powered by QuickJS (native, via rquickjs):

**Available:** `Math`, `JSON`, `Date`, `Number`, `String`, `Boolean`, `Array`, `Object`, `Map`, `Set`, `Promise`, `RegExp`, `Symbol`, `Proxy`, `Reflect`, typed arrays, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, and standard error constructors.

**Blocked:** `eval`, `new Function`, `process`, `require`, `import`, `fetch`, `setTimeout`, `setInterval`, and all Node.js/browser-specific globals.

**Frozen namespaces:** Namespace objects are frozen with `Object.freeze`. Scripts cannot add, remove, or reassign namespace members.

**Execution limits:** The `timeout_ms` field in the manifest's `limits` section controls how long a script can run (default 5000ms). The `memory_mb` field controls maximum heap size. The `max_stack_depth` field controls the maximum call stack size.

## Public Types

```rust
pub fn create_runtime(manifest_json: &str, options: RuntimeOptions) -> Result<XriptRuntime>;
pub fn create_runtime_from_file(path: &Path, options: RuntimeOptions) -> Result<XriptRuntime>;
pub fn create_runtime_from_value(manifest: Value, options: RuntimeOptions) -> Result<XriptRuntime>;

pub struct XriptRuntime { /* ... */ }
pub struct RuntimeOptions { /* host_bindings, capabilities, console */ }
pub struct HostBindings { /* ... */ }
pub struct ConsoleHandler { /* log, warn, error */ }
pub struct ExecutionResult { pub value: Value, pub duration_ms: f64 }
pub struct Manifest { pub xript: String, pub name: String, /* ... */ }
pub enum XriptError { /* ManifestValidation, Binding, CapabilityDenied, ... */ }
pub type HostFn = Arc<dyn Fn(&[Value]) -> Result<Value, String> + Send + Sync>;
pub type Result<T> = std::result::Result<T, XriptError>;
```
