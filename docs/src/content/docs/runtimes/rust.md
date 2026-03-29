---
title: Rust Runtime
description: Native Rust runtime for sandboxed xript script execution via QuickJS.
---

The Rust runtime (`xript-runtime`) executes user scripts inside a native QuickJS sandbox powered by [rquickjs](https://github.com/niclas-aspect/rquickjs). It provides the same manifest-driven binding model and capability enforcement as the JS/WASM and Node.js runtimes, but as a Rust crate with no WASM overhead.

For applications that need to run in browsers or other JavaScript environments, use the [JS/WASM Runtime](/runtimes/js-wasm). For Node.js-only applications, see the [Node.js Runtime](/runtimes/node). For .NET applications, see the [C# Runtime](/runtimes/csharp). For a comparison of all runtimes, see [Choosing a Runtime](/runtimes/overview).

## Installation

Add `xript-runtime` to your `Cargo.toml`:

```toml
[dependencies]
xript-runtime = "0.1"
```

## Creating a Runtime

:::note
`XriptRuntime` is `!Send` — it must stay on the thread that created it. For multi-threaded hosts (Tauri, Axum, Actix), use [`XriptHandle`](#xripthandle-send--sync), which wraps the runtime on a dedicated thread and exposes the same API over channels.
:::

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
pub type AsyncHostFn = Arc<dyn Fn(&[Value]) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;
pub type Result<T> = std::result::Result<T, XriptError>;

pub struct XriptHandle { /* ... */ }  // Send + Sync wrapper; see below
pub struct ModInstance { pub fragments: Vec<SanitizedFragment> }
```

## Threading

`XriptRuntime` holds a QuickJS context that is `!Send`. It can only be used from the thread that created it. For multi-threaded hosts (Tauri, Actix, Axum, etc.), use `XriptHandle` instead — it owns the runtime on a dedicated thread and exposes the same API over channels. See [XriptHandle](#xripthandle-send--sync) below.

## Async Host Bindings

`add_async_function()` registers an async host function. From the script's perspective the binding returns a `Promise`, so scripts can `await` it. The bridge uses `pollster::block_on()` internally to drive the future.

```rust
use xript_runtime::{HostBindings};

let mut bindings = HostBindings::new();

bindings.add_async_function("fetchData", |args: &[serde_json::Value]| {
    let key = args.get(0).and_then(|v| v.as_str()).unwrap_or("default").to_string();
    async move { Ok(serde_json::json!(format!("data for {}", key))) }
});
```

Script side:

```js
const data = await fetchData("users");
```

`Promise` is available in the sandbox — standard QuickJS async/await works without any extra setup.

## Loading Mods

`load_mod()` validates a mod manifest against the app manifest, sanitizes any fragment HTML, and optionally executes the mod's entry script before returning.

```rust
let mod_instance = rt.load_mod(
    mod_manifest_json,           // &str — mod manifest JSON
    fragment_sources,            // &[(&str, &str)] — (fragment_id, raw_html) pairs
    &granted_capabilities,       // &[String] — capabilities approved for this mod
    entry_source,                // Option<&str> — entry script, or None
)?;
```

`entry_source` is run after validation but before `load_mod` returns. If the script throws, `load_mod` returns `XriptError::ModEntry`. The returned `ModInstance` contains the sanitized fragments.

`XriptError` gains one new variant for this:

| Variant | When |
|---------|------|
| `ModEntry(String)` | Mod entry script threw an uncaught error |

## Fragment Hooks

`fire_fragment_hook()` fires a lifecycle event for a mounted fragment and returns the command buffer operations the mod script emitted in response.

```rust
let commands = rt.fire_fragment_hook(fragment_id, hook_name, &args)?;
```

`hook_name` is one of `"mount"`, `"unmount"`, `"update"`, `"suspend"`, or `"resume"`. Each command in the returned `Vec` is an enum variant describing a mutation the host should apply:

```rust
match &commands[0] {
    FragmentCommand::Toggle { id, visible } => { /* show/hide element */ }
    FragmentCommand::AddClass { id, class } => { /* add CSS class */ }
    FragmentCommand::RemoveClass { id, class } => { /* remove CSS class */ }
    FragmentCommand::SetText { id, text } => { /* update text content */ }
    FragmentCommand::SetAttr { id, attr, value } => { /* set attribute */ }
    _ => {}
}
```

The host walks the vec and applies each mutation to its own UI layer.

## XriptHandle (Send + Sync)

`XriptRuntime` is `!Send`. For Tauri commands, Actix handlers, Axum routes, or any context where the runtime crosses thread boundaries, use `XriptHandle`:

```rust
use xript_runtime::XriptHandle;

let handle = XriptHandle::new(manifest_json, options)?;
// XriptHandle is Send + Sync — safe to put in Arc<Mutex<T>>, tauri::State, etc.

let result = handle.execute("2 + 2")?;
```

`XriptHandle` starts a dedicated owner thread, moves the `XriptRuntime` onto it, and forwards every call through a channel pair. All methods mirror `XriptRuntime` — `execute`, `load_mod`, `fire_fragment_hook`, etc. The channel overhead is negligible for typical scripting workloads.

Tauri example:

```rust
use std::sync::Mutex;
use tauri::State;
use xript_runtime::XriptHandle;

struct AppState {
    xript: Mutex<XriptHandle>,
}

#[tauri::command]
fn run_script(state: State<AppState>, code: &str) -> Result<serde_json::Value, String> {
    let handle = state.xript.lock().unwrap();
    handle.execute(code)
        .map(|r| r.value)
        .map_err(|e| e.to_string())
}
```
