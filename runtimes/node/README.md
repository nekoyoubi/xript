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
