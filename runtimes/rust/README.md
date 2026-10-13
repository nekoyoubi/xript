# xript-runtime

Native Rust runtime for [xript](https://github.com/nekoyoubi/xript): sandboxed JavaScript execution via QuickJS (rquickjs).

[![Crates.io](https://img.shields.io/crates/v/xript-runtime)](https://crates.io/crates/xript-runtime)

## Install

```toml
[dependencies]
xript-runtime = "0.8"
```

## Usage

```rust
use xript_runtime::{create_runtime, RuntimeOptions, HostBindings, ConsoleHandler};

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

let runtime = create_runtime(manifest, RuntimeOptions {
    host_bindings: bindings,
    capabilities: vec![],
    console: ConsoleHandler::default(),
    ..Default::default()
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
- `XriptHandle`, a `Send`+`Sync` wrapper for driving a runtime across threads, whose every verb returns a `Pending<T>` rather than blocking the caller
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

### `XriptHandle` — driving a runtime without blocking the caller

One runtime owns one interpreter on one thread. `XriptHandle` owns that thread, takes commands from anywhere, and returns a `Pending<T>` immediately.

```rust
#[tauri::command]
async fn run_mod(state: State<'_, XriptHandle>, src: String) -> Result<Value, String> {
    state.execute(&src).await.map(|r| r.value).map_err(|e| e.to_string())
}
```

A `Pending<T>` can be consumed four ways, and only the last one blocks:

```rust
handle.execute(src).await?;                     // Future — any executor, or none
if let Some(r) = pending.try_take() { .. }      // immediate-mode loop, once per frame
handle.execute(src).on_complete(|r| { .. });    // callback host
handle.execute(src).wait()?;                    // explicit opt-in to blocking
handle.blocking().execute(src)?;                // the same, handle-wide
```

Three behaviors to know:

- **Dropping a `Pending` cancels its call.** `let _ = handle.execute(..);` compiles and cancels; bind the result or call `.detach()`. Cancellation is per-call and non-sticky — it never poisons the runtime for the next call.
- **Slot and role resolution and every manifest read answer on the calling thread.** `resolve_slot`, `resolve_slot_single`, `resolve_role`, `resolve_role_all`, `manifest` and `manifest_name` read shared state behind an `RwLock` instead of queueing behind whatever the runtime is executing.
- **Dropping a handle detaches its thread rather than joining it.** `join()` is the explicit opt-in; `shutdown()` drains the queue and stops; `kill()` sheds the queue and cancels the in-flight call.

`XriptHandle::spawn` returns before construction finishes, for a host that cannot block even that long; commands sent in the meantime are queued.

**What cancellation and timeouts actually bound.** QuickJS's interrupt handler only fires while bytecode is executing. A call sitting inside a blocking host binding observes no cancellation, no timeout, and no drop-cancel until that binding returns. That includes an async binding on a sync-mode runtime, which is driven to completion in line. `Pending::wait_timeout` bounds *the caller's wait*, never the call: `Err(XriptError::Timeout { still_running: true })` means "stopped waiting," not "it stopped." A host binding that may block is the host's own responsibility to bound. In [async mode](#async-mode-yielding-host-bindings), a call awaiting an async binding is parked rather than blocked, and the timeout, cancellation and drop-cancel all reach it.

### `XriptPool` — many runtimes, two lanes, one home per mod

A pool is a router over N handles, not a new concurrency primitive. Every worker is a whole `XriptHandle` with its own interpreter on its own thread, so everything above holds inside the pool, and `pool.on(id)` drops back to a single handle whenever the host knows better than the router.

```rust
let (pool, ready) = XriptPool::spawn(manifest_json, |_worker| build_options(), PoolConfig::default());
ready.await?;

let placed = pool.load_mod(mod_json, sources, &granted, Some(entry)).await?;   // one home worker
pool.invoke_export(&placed.mod_id, "crunch", &[]).await?;                       // always its home
pool.fire_hook("onTick", &[]).await?;                                          // fanned out, merged in order
```

Workers are built from a **factory** rather than one `RuntimeOptions`, both because the options types are deliberately not `Clone` and because per-worker construction is what keeps each worker's library registry its own — sharing one would let one worker's open load phase authorize another worker's concurrent dynamic `import(..)`.

Three rules carry the design:

- **A mod lives on exactly one runtime.** Its exports, hook handlers, event handlers and module-scope state all reside on its home worker, and every call into it is dispatched there. That is what makes a handler run exactly once, as it does on a single runtime; loading a mod onto every worker would fan `emit`/`fire_hook` to N copies and perform every side effect N times. The cost is that one mod gets no parallelism from the pool — parallelism across *different* mods does. Pool-wide handler order is `(mod.load_seq, intra-mod registration index)`, which reproduces single-runtime order exactly, and the merge is deterministic regardless of which worker replies first. `HookDispatch::Sequential` additionally restores cross-worker happens-before, at the cost of the parallelism.
- **Host bindings are called from N threads.** A binding registered with a pool **must be reentrant and thread-safe**. xript does not and cannot serialize calls into host code: the pool never holds a binding it could wrap, and a per-binding lock would let a long-lane call block an interactive-lane one — the exact inversion the pool exists to prevent. This is a documented contract, not a mechanism.
- **A wedged worker is detected, quarantined, and reported — never reclaimed.** Detection requires **both** an in-flight call past its threshold **and** a stalled heartbeat, where the heartbeat is bumped by the interrupt handler and therefore advances only while bytecode runs. A script legitimately grinding for a minute keeps ticking and is never marked wedged; only a thread parked inside host code stalls it. Once marked, the worker leaves routing, its queued calls are answered `WorkerWedged` by the pool itself, and `stats().wedged` names the binding. `retire_worker` abandons the thread — a thread blocked in host code cannot be safely killed and its runtime's memory cannot be reclaimed, so `PoolShutdownReport` reports what was abandoned and estimates the bytes that are not coming back.

`Route::Dedicated` is **execute-only**: a dedicated runtime has no mods loaded, so it cannot serve an export, a hook, or an event. The default `IntentRouter` clamps such a call to the mod's home and records it; a custom `PoolRouter` that asks for it explicitly gets `XriptError::RouteUnsupported`.

Routing reads declared `execution` intent from the manifest — `duration` (`instant`/`brief`/`long`/`unbounded`) and `affinity` (`any`/`pinned`/`isolated`). Both are advisory: nothing is enforced, no capability is consulted, and enforcement lives in `limits`. Where intent pays off most is **placement**: a mod that declares a `long` export never homes on the interactive lane.

### Async mode: yielding host bindings

By default (`RuntimeMode::Sync`) an async host binding does **not** yield: the runtime drives its future with `pollster::block_on` on the interpreter thread and hands the script an already-settled promise. `await` never suspends, and one slow binding holds the interpreter for every other call.

`RuntimeMode::Async` is the opt-in alternative, parallel to the JS runtime's `initXriptAsync`. It runs on rquickjs's `AsyncRuntime`; an async binding returns a genuinely pending promise, its host future runs on the runtime's own executor, and a script awaiting it yields so other calls on the same runtime proceed.

```rust
use xript_runtime::{create_async_runtime, RuntimeOptions};

let rt = create_async_runtime(manifest, RuntimeOptions { host_bindings, ..Default::default() })?;
let (slow, quick) = futures::join!(
    rt.execute_async("(async () => await fetchData('users'))()"),
    rt.execute_async("40 + 2"),   // finishes while the first call awaits
);
```

Every call has an `*_async` twin: `execute_async`, `execute_within_async`, `load_mod_async`, `invoke_export_async`, `invoke_mod_export_async`, `invoke_mod_export_within_async`, `invoke_command_async`, `fire_hook_async`, `fire_hook_tagged_async`, `emit_async`, `emit_tagged_async`, `fire_fragment_hook_async`, plus `idle()` to settle work a script started without awaiting. The plain methods keep working and drive one call to completion on the calling thread. On a sync-mode runtime the `*_async` methods complete on first poll.

`XriptHandle` and `XriptPool` built from async-mode options run calls concurrently on their runtime thread. A call is started, and polled once, in queue order, so everything it does before its first `await` happens in send order; after that, whichever host future settles first continues first. `load_mod` stays a barrier. `in_flight()` reports the oldest parked call and `in_flight_all()` every one, `kill()` cancels them all, and `shutdown()` waits for them. The pool's wedge detector does not count a call parked on an async binding as wedged: a yielding worker is wedged only when its thread is inside a sync binding.

What holds and what differs in async mode:

- **Limits**: `timeout_ms` bounds the whole call, time spent awaiting included. Memory and stack limits are unchanged.
- **Cancellation**: the runtime's `CancellationToken`, a handle's per-call token, and dropping an in-flight future all reach a parked call within a few milliseconds. A dropped call is driven to its cancellation point rather than torn down, so its JS values are released under the runtime lock.
- **Capabilities, hooks, events, fragments, exports, commands, slots and roles** behave as in sync mode. Exports and command handlers that return promises are awaited; hook and event handler results are collected unawaited, matching the JS runtime.
- **Executor-agnostic host futures**: futures are polled by whichever thread drives the call. A future that needs a particular reactor (a `tokio` timer, for example) must be driven from inside that executor.
- **Interleaved budgets**: promise jobs belonging to one call can run while another call is being polled, and are charged to that call for that slice. Every budget stays bounded; per-call attribution across interleaved calls is approximate.
- **Sync bindings and debugging** still hold the thread: a sync binding runs in line, and a paused debug session blocks the interpreter as it does in sync mode.

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
