---
title: Getting Started
description: Add safe, sandboxed scripting to your application in five minutes.
---

This guide walks through adding xript to an application from scratch. By the end you'll have a working sandboxed expression evaluator that users can safely extend.

## Install the Runtime

The universal runtime uses QuickJS compiled to WebAssembly: it works in browsers, Node.js, Deno, and more.

```sh
npm install @xriptjs/runtime
```

## Write a Manifest

Create a `manifest.json` describing what your application exposes to scripts. Start with a few safe bindings:

```json
{
  "$schema": "https://xript.dev/schema/manifest/v0.6.json",
  "xript": "0.6",
  "name": "my-app",
  "version": "1.0.0",
  "bindings": {
    "greet": {
      "description": "Returns a greeting for the given name.",
      "params": [{ "name": "name", "type": "string" }],
      "returns": "string"
    },
    "add": {
      "description": "Adds two numbers.",
      "params": [
        { "name": "a", "type": "number" },
        { "name": "b", "type": "number" }
      ],
      "returns": "number"
    }
  }
}
```

Only `xript` and `name` are required. Everything else is optional and layered on as needed.

## Provide Host Bindings

Each binding in the manifest needs a host-side implementation. These are regular JavaScript functions:

```javascript
const hostBindings = {
  greet: (name) => `Hello, ${name}!`,
  add: (a, b) => a + b,
};
```

## Create a Runtime

Initialize the WASM sandbox, then wire the manifest and bindings together:

```javascript
import { initXript } from "@xriptjs/runtime";

const xript = await initXript();
const runtime = xript.createRuntime(manifest, {
  hostBindings,
  console: { log: console.log, warn: console.warn, error: console.error },
});
```

`initXript()` loads the QuickJS WASM module once. After that, `createRuntime()` is synchronous: create as many runtimes as you need.

## Execute Scripts

Now you can safely evaluate user expressions:

```javascript
runtime.execute('greet("World")');    // { value: "Hello, World!", duration_ms: ... }
runtime.execute('add(2, 3)');         // { value: 5, duration_ms: ... }
runtime.execute('add(1, add(2, 3))'); // { value: 6, duration_ms: ... }
```

Scripts can compose your bindings with standard JavaScript:

```javascript
runtime.execute('[1, 2, 3].map(n => add(n, 10))'); // { value: [11, 12, 13], ... }
```

## Clean Up

When you're done with a runtime, free its WASM resources:

```javascript
runtime.dispose();
```

## See the Sandbox in Action

Anything not declared in the manifest is inaccessible:

```javascript
runtime.execute('process.exit(1)');    // Error: process is not defined
runtime.execute('require("fs")');      // Error: require is not defined
runtime.execute('eval("1 + 1")');      // Error: eval() is not permitted
runtime.execute('fetch("https://x")'); // Error: fetch is not defined
```

The sandbox guarantees that user scripts cannot escape the boundaries you define.

## Next Steps

- **Scaffold a new project** with `npx xript init`. See [Init CLI](/tools/cli#init).
- **Add capabilities** to gate sensitive operations. See the [Capabilities](/spec/capabilities) spec.
- **Add namespaces** to organize related bindings. See the [Manifest](/spec/manifest) spec.
- **Expose extension points** by declaring typed slots that mods fill, and broadcast named events the host emits. Bindings are what mods call, slots are what they fill, events are what the host emits. See the [Manifest](/spec/manifest) and [Mod Manifest](/spec/mod-manifest) specs.
- **Inherit from a base manifest** with `extends`; fill a base's abstract holes, refine its concrete pieces. See the [Manifest](/spec/manifest) spec.
- **Measure moddability** with `xript score`, which rates how much extension surface your host exposes. See [Extensibility Score](/tools/score).
- **Drive the toolchain from an agent** by running the CLI as an MCP server with `xript mcp`. See [MCP Server](/tools/mcp).
- **Read the doctrine** behind xript's open-by-default posture with `xript guide`. See ["More extensible, not less"](/guidance/openness).
- **Generate TypeScript definitions** from your manifest with `xript typegen`. See [Type Generator](/tools/cli#typegen).
- **Generate documentation** from your manifest with `xript docgen`. See [Doc Generator](/tools/cli#docgen).
- **Use the Node.js runtime** for file-based workflows and native V8 performance. See [Node.js Runtime](/runtimes/node).
- **Explore the runtime API** in depth. See [JS/WASM Runtime](/runtimes/js-wasm).
- **Run the full example** in the repository: `examples/expression-evaluator/`.
