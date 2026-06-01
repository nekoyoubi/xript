# @xriptjs/runtime-node

Node.js-optimized runtime for [xript](https://github.com/nekoyoubi/xript): sandboxed script execution via the Node.js `vm` module with native V8 performance.

[![npm](https://img.shields.io/npm/v/@xriptjs/runtime-node)](https://www.npmjs.com/package/@xriptjs/runtime-node)

## Install

```sh
npm install @xriptjs/runtime-node
```

## Usage

```javascript
import { createRuntime } from "@xriptjs/runtime-node";

const runtime = createRuntime(
  {
    xript: "0.1",
    name: "my-app",
    bindings: {
      greet: {
        description: "Returns a greeting.",
        params: [{ name: "name", type: "string" }],
        returns: "string",
      },
    },
  },
  {
    hostBindings: { greet: (name) => `Hello, ${name}!` },
    console: { log: console.log, warn: console.warn, error: console.error },
  },
);

runtime.execute('greet("World")'); // => { value: "Hello, World!", duration_ms: ... }
```

### Load from file

```javascript
import { createRuntimeFromFile } from "@xriptjs/runtime-node";

const runtime = await createRuntimeFromFile("./manifest.json", {
  hostBindings: { greet: (name) => `Hello, ${name}!` },
  console: { log: console.log, warn: console.warn, error: console.error },
});
```

## What it does

- Runs user-provided JavaScript in a Node.js `vm` sandbox with `codeGeneration: { strings: false, wasm: false }`
- Only functions declared in the manifest are available to scripts
- Supports capability-gated bindings, namespace bindings, hooks, and resource limits
- No `eval`, no `Function`, no dynamic code generation

### v0.5.0

- cooperative cancellation via a `CancellationToken` on the runtime options; it surfaces a distinct cancellation error (not a timeout), and since `vm` has no mid-run interrupt hook the token is checked at execute/invoke entry
- opt-in capability audit channel: a hook reporting every allowed host-binding invocation as `{ binding, capability, at }`
- console severity: log/info/warn/error/debug plus a trace channel
- sandbox hard caps: host ceilings on memory, CPU time, and stack depth
- manifest `extends` with deep-merge so a manifest can inherit and override host bindings; mod manifests gained an optional `family` field for grouping
- host-invoke exports: mods declare named exports the host calls by name and whose return value it honors
- ES module mods via `entry.format: "module"`, which evaluates the entry as a real ES module through `vm.SourceTextModule`; top-level named exports auto-register as host-invokable, and external imports stay denied
- provider-role resolution: mods declare `contributions.provides` and the host calls `resolveRole(role)` (first-installed-wins, settings-overridable) to bind a logical role to a concrete export
- slot runtime resolver: ordering by priority, single/multiple cardinality, and capability enforcement on contributions
- DAP-shaped debug protocol: set/clear breakpoints by source position, pause/resume/step in/over/out, and inspect scopes, locals, and stack frames (AST instrumentation)

## API

### `createRuntime(manifest, options): XriptRuntime`

Creates a sandboxed runtime from a manifest object and host binding implementations. No async initialization needed; this is synchronous.

### `createRuntimeFromFile(path, options): Promise<XriptRuntime>`

Reads a manifest JSON file from disk and creates a runtime.

**Options (both functions):**
- `hostBindings`: object mapping binding names to host functions
- `capabilities`: array of capability names to grant
- `console`: `{ log, warn, error }` for script console output

### `runtime.execute(code): ExecutionResult`

Executes JavaScript code in the sandbox. Returns `{ value, duration_ms }`.

### `runtime.fireHook(name, options?): unknown[]`

Fires a hook by name, calling all registered handlers.

## When to use this vs other runtimes

Use this package when you're running **Node.js only** and want native V8 performance without WASM overhead. Use `@xriptjs/runtime` when you need to run in the browser, edge workers, or other non-Node environments. Use `xript-runtime` when your host application is written in Rust.

## Documentation

[xript.dev](https://xript.dev): full docs, getting started guide, and examples.

## License

MIT
