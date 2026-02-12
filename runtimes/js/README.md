# @xriptjs/runtime

Universal JavaScript runtime for [xript](https://github.com/nekoyoubi/xript). This is a QuickJS WASM sandbox that runs in the browser, Node.js, Deno, Bun, and anywhere else JavaScript runs.

[![npm](https://img.shields.io/npm/v/@xriptjs/runtime)](https://www.npmjs.com/package/@xriptjs/runtime)

## Install

```sh
npm install @xriptjs/runtime
```

## Usage

```javascript
import { initXript } from "@xriptjs/runtime";

const xript = await initXript();
const runtime = xript.createRuntime(
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
runtime.dispose();
```

## What it does

- Runs user-provided JavaScript inside a QuickJS WASM sandbox
- Only functions declared in the manifest are available to scripts; everything else is blocked
- Supports capability-gated bindings, namespace bindings, hooks, and resource limits
- No `eval`, no `Function`, no access to the host environment

## API

### `initXript(): Promise<XriptFactory>`

Loads the QuickJS WASM module and returns a factory for creating runtimes.

### `initXriptAsync(): Promise<AsyncXriptFactory>`

Same as `initXript`, but creates runtimes that support async host bindings (uses the asyncify WASM build).

### `factory.createRuntime(manifest, options): XriptRuntime`

Creates a sandboxed runtime from a manifest object and host binding implementations.

**Options:**
- `hostBindings`: object mapping binding names to host functions
- `capabilities`: array of capability names to grant
- `console`: `{ log, warn, error }` for script console output

### `runtime.execute(code): ExecutionResult`

Executes JavaScript code in the sandbox. Returns `{ value, duration_ms }`.

### `runtime.fireHook(name, options?): unknown[]`

Fires a hook by name, calling all registered handlers. Returns an array of handler return values.

### `runtime.dispose()`

Frees the WASM sandbox resources.

## When to use this vs other runtimes

| | `@xriptjs/runtime` | `@xriptjs/runtime-node` | `xript-runtime` (Rust) |
|---|---|---|---|
| Runs in browser | Yes | No | No |
| Runs in Node.js | Yes | Yes | No |
| Sandbox mechanism | QuickJS WASM | Node.js `vm` module | QuickJS (native) |
| Zero dependencies on Node | Yes | Requires Node.js | Rust crate |
| Performance | Good (WASM overhead) | Native V8 speed | Native QuickJS speed |
| Async bindings | Via asyncify WASM | Native `async`/`await` | Not yet |

Use this package when you need **universal portability** (browser, edge, serverless). Use `@xriptjs/runtime-node` when you're Node.js-only and want native V8 performance. Use `xript-runtime` when your host application is written in Rust.

## Documentation

[xript.dev](https://xript.dev): full docs, getting started guide, and live demos.

## License

MIT
