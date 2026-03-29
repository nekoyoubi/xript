# Rust Runtime Fixes + Init CLI Tier 4

## Problem

Three gaps in the Rust runtime (#86, #87, #88) and a missing tier 4 in the init CLI scaffolding.

## 1. Init CLI — Tier 4 Support

Add tier 4 ("Full Feature") to the init scaffolding tool. Tier 4 generates an app manifest with slots, a companion mod manifest, and fragment HTML alongside the standard host/demo files.

**Changes:**
- `tools/init/src/cli.ts` and `tools/cli/src/commands/init.ts`: update `parseTier()` to accept `4`, update prompt text to `"Tier — 2 (bindings), 3 (advanced scripting), or 4 (full feature)? (2): "`
- `tools/init/src/templates.ts`: update `TemplateOptions.tier` type to `2 | 3 | 4`, add tier 4 manifest/host/demo generators
- Tier 4 app manifest: bindings + capabilities + hooks + `slots` array with a sample slot
- Tier 4 scaffold also generates `mod-manifest.json` and `fragments/panel.html` as a starter mod
- Tier 4 host: implements bindings, fires hooks, demonstrates slot mounting
- Tier 4 demo: loads mod, processes fragments, shows data-bind in action

**Tests:**
- Tier 4 file structure (includes mod-manifest.json, fragments/)
- Tier 4 manifest has slots, bindings, hooks, and capabilities
- Tier 4 host loads mod and processes fragments
- Tier 4 demo uses loadMod

## 2. #87 — Entry Script Execution

`load_mod()` should execute entry scripts as part of the mod loading process.

**Changes:**
- `sandbox.rs`: `load_mod()` gains `entry_source: Option<&str>` parameter
- After fragment cross-validation, if entry source is provided, execute it in the sandbox context
- Entry runs after validation but before `load_mod()` returns — mod is fully initialized when host gets control back
- New error variant: `XriptError::ModEntry { mod_name, message }` distinguishes entry failures from validation failures

**Tests:**
- Entry script executes during load_mod
- Entry script can call host bindings
- Entry script failure returns ModEntry error (not Script error)
- load_mod without entry still works (backward compatible)
- Entry runs after fragment validation (validated fragments available when entry executes)

## 3. #86 — Async Host Bindings

Add async host binding support so desktop apps can expose I/O-bound operations without blocking.

**Changes:**
- New type alias: `AsyncHostFn = Arc<dyn Fn(&[Value]) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>`
- `HostBindings`: new methods `add_async_function()` and `add_async_namespace()`
- Async host functions surface as JS Promises via rquickjs promise API
- New `execute_async()` method on `XriptRuntime` that drives the promise event loop via `rt.idle()`
- Manifest `async: true` field enforced: async bindings must be registered with async host functions
- Timeout enforcement applies to async execution

**Tests:**
- Async binding returns a promise
- Awaiting async binding resolves to correct value
- Async binding errors reject the promise
- Timeout applies to async execution
- Sync bindings still work alongside async bindings
- Manifest async field enforcement (async binding registered as sync → error)

## 4. #88 — XriptHandle (Send + Sync Wrapper)

Provide a `Send + Sync` handle type for multi-threaded Rust apps (Tauri, Actix, Axum).

**Changes:**
- New module: `handle.rs`
- `XriptHandle`: owns an `XriptRuntime` on a dedicated `std::thread`, communicates via `std::sync::mpsc` channels
- Constructor: `XriptHandle::new(manifest_json, options)` spawns thread, creates runtime, returns handle
- Methods mirror `XriptRuntime`: `execute()`, `execute_async()`, `load_mod()`, `manifest()`, `process_fragment()`
- Commands are enums sent over the channel; results come back on a oneshot-style response channel
- `Drop` sends shutdown and joins the thread
- Re-exported from `lib.rs` as a public type

**Tests:**
- Compile-time `Send + Sync` assertion: `fn assert_send_sync<T: Send + Sync>() {} assert_send_sync::<XriptHandle>()`
- Execute through handle returns correct results
- Load mod through handle works
- Handle works after being moved to another thread (spawn + join)
- Errors propagate through handle correctly
- Handle drop cleans up thread

## Implementation Order

1. Init CLI tier 4 (no Rust dependency)
2. #87 entry scripts (smallest Rust change, no new dependencies)
3. #86 async bindings (medium complexity, foundation for handle's async support)
4. #88 XriptHandle (builds on everything above)
