---
title: Rust Runtime
description: Native Rust runtime for sandboxed xript script execution via QuickJS.
---

The Rust runtime (`xript-runtime`) executes user scripts inside a native QuickJS sandbox powered by [rquickjs](https://crates.io/crates/rquickjs). It provides the same manifest-driven binding model and capability enforcement as the JS/WASM and Node.js runtimes, but as a Rust crate with no WASM overhead.

For applications that need to run in browsers or other JavaScript environments, use the [JS/WASM Runtime](/runtimes/js-wasm). For Node.js-only applications, see the [Node.js Runtime](/runtimes/node). For .NET applications, see the [C# Runtime](/runtimes/csharp). For a comparison of all runtimes, see [Choosing a Runtime](/runtimes/overview).

## Installation

Add `xript-runtime` to your `Cargo.toml`:

```toml
[dependencies]
xript-runtime = "0.6"
```

## Creating a Runtime

:::note
`XriptRuntime` is `!Send`; it must stay on the thread that created it. For multi-threaded hosts (Tauri, Axum, Actix), use [`XriptHandle`](#xripthandle-send--sync), which wraps the runtime on a dedicated thread and exposes the same API over channels.
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
    ..Default::default()
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
        ..Default::default()
    },
)?;
```

`create_runtime_from_file` resolves the manifest's `extends` chain relative to the file's directory before constructing the runtime, so an inheriting manifest loads as its fully merged form.

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
    ..Default::default()
})?;
```

## Options

`RuntimeOptions` derives `Default`, so only the fields you care about need to be set; spread `..Default::default()` for the rest. The full set:

| Field | Type | Description |
|-------|------|-------------|
| `host_bindings` | `HostBindings` | Map of binding names to host functions |
| `capabilities` | `Vec<String>` | List of capabilities granted to this script |
| `console` | `ConsoleHandler` | Console output routing (`log`, `warn`, `error`, plus an optional severity sink) |
| `cancellation` | `Option<CancellationToken>` | Host-driven cooperative cancellation token; `None` to disable |
| `audit` | `Option<AuditSink>` | Per-capability audit channel fired once per allowed binding invocation; `None` to disable |
| `hard_limits` | `Option<HardLimits>` | Host-imposed ceilings clamping the manifest's `limits`; `None` for manifest-only limits |
| `role_preferences` | `HashMap<String, String>` | Per-role provider preference (`role` → preferred mod name) for `resolve_role` |
| `debug` | `Option<DebugOptions>` | DAP-shaped debug session options; `None` for zero-overhead off |

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
    on: None,
};
```

The default `ConsoleHandler` silently discards all output.

For finer-grained routing, set the `on` field to a single severity sink that receives a `LogSeverity` (`Trace`, `Debug`, `Info`, `Warn`, `Error`) for every console call. When `on` is `Some`, it supersedes the legacy `log`/`warn`/`error` boxes; when it is `None`, the runtime falls back to them (`Info`/`Debug`/`Trace` → `log`, `Warn` → `warn`, `Error` → `error`):

```rust
use xript_runtime::{ConsoleHandler, LogSeverity};

let console = ConsoleHandler {
    on: Some(Box::new(|severity: LogSeverity, msg: &str| {
        eprintln!("[{:?}] {}", severity, msg);
    })),
    ..ConsoleHandler::default()
};
```

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
| `CapabilityDenied { binding, capability }` | Calling a gated binding (or invoking a gated export) without the required capability |
| `ExecutionLimit { limit }` | Script exceeds timeout or resource limits |
| `Cancelled` | Host cancelled execution via the `CancellationToken` (distinct from a timeout) |
| `Invoke { export, message }` | A host-invoked export was missing/unregistered or threw |
| `Script(String)` | Script throws an uncaught error |
| `ModEntry { mod_name, message }` | Mod entry script (classic or module) threw an uncaught error |
| `ImportDenied { mod_name, specifier }` | A mod attempted to import an external module |
| `CommonJsDetected { mod_name, artifact }` | A mod entry used CommonJS (`require` / `module.exports`) instead of ES modules |
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
pub struct RuntimeOptions { /* host_bindings, capabilities, console, cancellation, audit, hard_limits, role_preferences, debug */ }
pub struct HostBindings { /* ... */ }
pub struct ConsoleHandler { /* log, warn, error, on */ }
pub struct ExecutionResult { pub value: Value, pub duration_ms: f64 }
pub struct Manifest { pub xript: String, pub name: String, /* ... */ }
pub enum XriptError { /* ManifestValidation, Binding, CapabilityDenied, Cancelled, Invoke, ModEntry, ImportDenied, CommonJsDetected, ... */ }
pub type HostFn = Arc<dyn Fn(&[Value]) -> Result<Value, String> + Send + Sync>;
pub type AsyncHostFn = Arc<dyn Fn(&[Value]) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;
pub type Result<T> = std::result::Result<T, XriptError>;

// Lifecycle, audit, and limits
pub struct CancellationToken { /* new(), cancel(), is_cancelled() */ }
pub struct AuditEvent { pub binding: String, pub capability: Option<String>, pub at_ms: f64 }
pub type AuditSink = Arc<dyn Fn(AuditEvent) + Send + Sync>;
pub enum LogSeverity { Trace, Debug, Info, Warn, Error }
pub struct HardLimits { pub timeout_ms: Option<u64>, pub memory_mb: Option<u64>, pub max_stack_depth: Option<usize> }

// Slot and provider-role resolution
pub struct SlotContribution { pub mod_name: String, pub fragment_id: String, pub slot: String, pub format: String, pub priority: i32 }
pub struct RoleResolution { pub addon: String, pub role: String, pub fns: std::collections::BTreeMap<String, String> }

pub struct XriptHandle { /* ... */ }  // Send + Sync wrapper; see below
pub struct FragmentInstance { pub id: String, pub slot: String, pub format: String, pub priority: i32, /* ... */ }
pub struct ModInstance {
    pub id: String,
    pub name: String,
    pub version: String,
    pub fragments: Vec<FragmentInstance>,
    pub provides: Vec<ProviderRole>,
}
```

## Threading

`XriptRuntime` holds a QuickJS context that is `!Send`. It can only be used from the thread that created it. For multi-threaded hosts (Tauri, Actix, Axum, etc.), use `XriptHandle` instead; it owns the runtime on a dedicated thread and exposes the same API over channels. See [XriptHandle](#xripthandle-send--sync) below.

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

`Promise` is available in the sandbox; standard QuickJS async/await works without any extra setup.

## Loading Mods

`load_mod()` validates a mod manifest against the app manifest, sanitizes any fragment HTML, and optionally executes the mod's entry script before returning.

```rust
use std::collections::{HashMap, HashSet};

let fragment_sources: HashMap<String, String> = HashMap::new();   // source path -> raw HTML
let mut granted: HashSet<String> = HashSet::new();                // capabilities approved for this mod
granted.insert("ui-mount".into());

let mod_instance = rt.load_mod(
    mod_manifest_json,           // &str — mod manifest JSON
    fragment_sources,            // HashMap<String, String> — fragment source path -> raw HTML
    &granted,                    // &HashSet<String> — capabilities approved for this mod
    None,                        // Option<&str> — entry script, or None
)?;
```

Fragments declared `inline: true` carry their HTML in the manifest directly; non-inline fragments resolve their `source` path against the `fragment_sources` map. `entry_source` runs after validation but before `load_mod` returns; if it throws, `load_mod` returns `XriptError::ModEntry { mod_name, message }`. The returned `ModInstance` exposes the mod's `id`, `name`, `version`, sanitized `fragments`, and any `provides` (provider-role declarations; see [Slot & Role Resolution](#slot--role-resolution)).

A mod entry may be a classic script (using `xript.exports.register(...)`) or an ES module (`entry.format: "module"`); top-level named function exports auto-register as host-invokable. A mod that attempts an external `import` fails with `XriptError::ImportDenied`, and a mod entry carrying CommonJS (`require` / `module.exports`) fails with `XriptError::CommonJsDetected`.

## Fragment Hooks

`fire_fragment_hook()` fires a lifecycle event for a mounted fragment and returns the command-buffer operations the mod's registered handlers emitted in response.

```rust
let ops_per_handler = rt.fire_fragment_hook(
    fragment_id,                       // &str
    lifecycle,                         // &str — "mount", "unmount", "update", "suspend", or "resume"
    Some(&serde_json::json!({ "health": 30 })),  // Option<&serde_json::Value> — current bindings
)?;
```

`lifecycle` is one of `"mount"`, `"unmount"`, `"update"`, `"suspend"`, or `"resume"`. The return is a `Vec<serde_json::Value>`: one entry per registered handler, each entry an array of command objects that handler emitted. Each command is a plain JSON object keyed by `op`:

```rust
for handler_ops in &ops_per_handler {
    for op in handler_ops.as_array().into_iter().flatten() {
        match op["op"].as_str() {
            Some("toggle")          => { /* op["selector"], op["value"] (bool) */ }
            Some("addClass")        => { /* op["selector"], op["value"] (class) */ }
            Some("removeClass")     => { /* op["selector"], op["value"] (class) */ }
            Some("setText")         => { /* op["selector"], op["value"] (text) */ }
            Some("setAttr")         => { /* op["selector"], op["attr"], op["value"] */ }
            Some("replaceChildren") => { /* op["selector"], op["value"] (html) */ }
            _ => {}
        }
    }
}
```

The host walks the operations and applies each mutation to its own UI layer.

## Host-Invoke Exports

A mod's entry can register host-invokable functions two ways: by calling `xript.exports.register(name, fn)` in a classic-script entry, or by declaring top-level named function exports in a module-format entry (`entry.format: "module"`). The host calls them through `invoke_export`:

```rust
let result = rt.invoke_export("computeDamage", &[
    serde_json::json!(10),
    serde_json::json!("fire"),
])?;
```

Args are JSON-serializable and the return value is honored. An undeclared/unregistered export, or one that throws, surfaces as `XriptError::Invoke`. If the export declares a gating capability the runtime was not granted, the call surfaces as `XriptError::CapabilityDenied` before the function runs.

## Slot & Role Resolution

When a host declares typed `slots`, loaded mods fill them with fragment contributions. `resolve_slot` returns the contributions targeting a slot, ordered by `priority` descending then fragment id ascending; single-cardinality slots (the default, with `multiple` unset) return at most the winner:

```rust
let contributions = rt.resolve_slot("sidebar.left");      // Vec<SlotContribution>
let winner = rt.resolve_slot_single("main.overlay");      // Option<SlotContribution>
```

Provider roles are resolved the same way. A mod that declares `contributions.provides` offers a logical role with a logical→concrete fn map; the host picks a winner with `resolve_role` (first-installed-wins, unless `role_preferences` names a present candidate) or enumerates every candidate with `resolve_role_all` to build its own picker:

```rust
let provider = rt.resolve_role("storage");                // Option<RoleResolution>
let all = rt.resolve_role_all("storage");                 // Vec<RoleResolution>
```

The runtime never invokes the named fns itself; it returns the mapping, and the host calls them through its own export/binding path, so each named fn stays gated by its own capability.

## Cooperative Cancellation

A `CancellationToken` on `RuntimeOptions` lets a host interrupt an in-flight execution at the next interrupt-check point. Cancellation is sticky and idempotent, and surfaces as `XriptError::Cancelled` (distinct from an `ExecutionLimit` timeout):

```rust
use xript_runtime::CancellationToken;

let token = CancellationToken::new();

let rt = create_runtime(manifest_json, RuntimeOptions {
    cancellation: Some(token.clone()),
    ..Default::default()
})?;

// from another thread / a timer / a UI cancel button:
token.cancel();
```

## Audit Channel

An opt-in `AuditSink` fires once per allowed host-binding invocation, before the host function runs, reporting `{ binding, capability, at_ms }`. Emission is best-effort and never propagates errors into the sandbox:

```rust
use std::sync::Arc;
use xript_runtime::{AuditEvent, AuditSink};

let sink: AuditSink = Arc::new(|event: AuditEvent| {
    eprintln!("called {} (cap: {:?}) at {}", event.binding, event.capability, event.at_ms);
});

let rt = create_runtime(manifest_json, RuntimeOptions {
    audit: Some(sink),
    ..Default::default()
})?;
```

`RuntimeOptions::with_audit_channel(tx)` is a convenience that wraps an `mpsc::Sender<AuditEvent>` as a sink.

## Hard Limits

A host can impose ceilings the manifest's `limits` cannot exceed. The effective value per field is `min(manifest, hard)`; an over-requesting manifest is clamped silently rather than rejected:

```rust
use xript_runtime::HardLimits;

let rt = create_runtime(manifest_json, RuntimeOptions {
    hard_limits: Some(HardLimits {
        timeout_ms: Some(2000),
        memory_mb: Some(64),
        max_stack_depth: Some(256),
    }),
    ..Default::default()
})?;
```

## Debugging

When `RuntimeOptions::debug` is set, the runtime attaches a DAP-shaped debug session reachable via `rt.debug_session()` (`None` when debug is off, zero overhead when absent). The session uses Debug Adapter Protocol vocabulary (breakpoints, stack frames, scopes, variables, stop reasons) shared across all four runtimes; per-engine fidelity is surfaced through `DebugFidelity` rather than papered over. See the [Debugging](/spec/debugging) spec for the protocol shape.

## XriptHandle (Send + Sync)

`XriptRuntime` is `!Send`. For Tauri commands, Actix handlers, Axum routes, or any context where the runtime crosses thread boundaries, use `XriptHandle`:

```rust
use xript_runtime::XriptHandle;

let handle = XriptHandle::new(manifest_json, options)?;
// XriptHandle is Send + Sync — safe to put in Arc<Mutex<T>>, tauri::State, etc.

let result = handle.execute("2 + 2")?;
```

`XriptHandle` starts a dedicated owner thread, moves the `XriptRuntime` onto it, and forwards every call through a channel pair. All methods mirror `XriptRuntime` (`execute`, `load_mod`, `fire_fragment_hook`, and so on). The channel overhead is negligible for typical scripting workloads.

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
