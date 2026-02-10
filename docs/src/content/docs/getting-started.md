---
title: Getting Started
description: Add safe, sandboxed scripting to your application in five minutes.
---

This guide walks through adding xript to an application from scratch. By the end, you will have a working sandboxed expression evaluator that users can extend safely.

## Install the Runtime

The universal runtime uses QuickJS compiled to WebAssembly — it works in browsers, Node.js, Deno, and more.

```sh
npm install @xript/runtime
```

## Write a Manifest

Create a `manifest.json` describing what your application exposes to scripts. Start with a few safe bindings:

```json
{
  "xript": "0.1",
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
import { initXript } from "@xript/runtime";

const xript = await initXript();
const runtime = xript.createRuntime(manifest, {
  hostBindings,
  console: { log: console.log, warn: console.warn, error: console.error },
});
```

`initXript()` loads the QuickJS WASM module once. After that, `createRuntime()` is synchronous — create as many runtimes as you need.

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

- **Add capabilities** to gate sensitive operations. See the [Capabilities](/spec/capabilities) spec.
- **Add namespaces** to organize related bindings. See the [Manifest](/spec/manifest) spec.
- **Generate TypeScript definitions** from your manifest with `xript-typegen`. See [Type Generator](/tools/typegen).
- **Generate documentation** from your manifest with `xript-docgen`. See [Doc Generator](/tools/docgen).
- **Run the full example** in the repository: `examples/expression-evaluator/`.
