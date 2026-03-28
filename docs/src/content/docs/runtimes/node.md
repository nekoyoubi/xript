---
title: Node.js Runtime
description: Node.js-optimized xript runtime with file-based manifest loading.
---

The Node.js runtime (`@xriptjs/runtime-node`) executes user scripts inside a sandboxed Node.js `vm` context. It provides `createRuntimeFromFile` for loading manifests directly from disk. Use this runtime when your application runs exclusively on Node.js and you want file-based workflows.

For applications that need to run in browsers, Deno, Bun, or other environments, use the [JS/WASM Runtime](/runtimes/js-wasm) (`@xriptjs/runtime`) instead. For Rust host applications, see the [Rust Runtime](/runtimes/rust). For .NET applications, see the [C# Runtime](/runtimes/csharp). For a comparison of all runtimes, see [Choosing a Runtime](/runtimes/overview).

## Installation

```sh
npm install @xriptjs/runtime-node
```

## Creating a Runtime

### From a Manifest Object

```javascript
import { createRuntime } from "@xriptjs/runtime-node";

const runtime = createRuntime(manifest, {
  hostBindings: { greet: (name) => `Hello, ${name}!` },
});
```

`createRuntime` performs basic structural validation on the manifest (required fields, correct types) and returns a runtime immediately.

### From a Manifest File

```javascript
import { createRuntimeFromFile } from "@xriptjs/runtime-node";

const runtime = await createRuntimeFromFile("./manifest.json", {
  hostBindings: { greet: (name) => `Hello, ${name}!` },
});
```

`createRuntimeFromFile` reads the manifest from disk, performs structural validation, and creates a runtime. For full JSON Schema validation, use [`@xriptjs/validate`](/tools/cli#validate) before creating the runtime.

## Options

`createRuntime` and `createRuntimeFromFile` accept the same options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hostBindings` | `HostBindings` | (required) | Map of binding names to host functions |
| `capabilities` | `string[]` | `[]` | List of capabilities granted to this script |
| `console` | `{ log, warn, error }` | no-op functions | Console output routing |

## Executing Scripts

### Synchronous

```javascript
const result = runtime.execute("2 + 2");
// { value: 4, duration_ms: 0.5 }
```

### Asynchronous

```javascript
const result = await runtime.executeAsync("return await data.get('score');");
// { value: "42", duration_ms: 1.2 }
```

`executeAsync` wraps code in an async function. Use `return` and `await` as needed.

## Cleanup

Call `dispose()` when you are done with a runtime:

```javascript
runtime.dispose();
```

The Node.js runtime does not require explicit cleanup, but `dispose()` is provided for API parity with the universal runtime. Code written against one runtime works identically on the other.

## Error Types

The Node.js runtime exports the same error classes as the universal runtime:

| Error | When | Catchable in script? |
|-------|------|---------------------|
| `ManifestValidationError` | Manifest fails structural or schema validation | N/A (thrown at load time) |
| `BindingError` | Host function throws or is missing | Yes |
| `CapabilityDeniedError` | Calling a gated binding without the capability | Yes |
| `ExecutionLimitError` | Script exceeds timeout or resource limits | No |

```javascript
import {
  BindingError,
  CapabilityDeniedError,
  ExecutionLimitError,
} from "@xriptjs/runtime-node";
```

## Sandbox Details

The Node.js runtime creates a `vm.Context` with a restricted global environment:

- **Code generation disabled:** `vm.createContext` is configured with `codeGeneration: { strings: false, wasm: false }`. This blocks `eval()` and `new Function()` at the V8 level.
- **Standard globals available:** `Math`, `JSON`, `Date`, `Number`, `String`, `Boolean`, `Array`, `Object`, `Map`, `Set`, `Promise`, `RegExp`, `Symbol`, `Proxy`, `Reflect`, typed arrays, and standard error constructors
- **Blocked:** `process`, `require`, `import`, `fetch`, `setTimeout`, `setInterval`, `Buffer`, `__dirname`, `__filename`
- **Frozen namespaces:** Namespace objects are frozen with `Object.freeze`
- **Execution limits:** Timeout enforced via `vm.Script.runInContext` timeout option
