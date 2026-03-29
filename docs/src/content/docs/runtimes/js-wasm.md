---
title: JS/WASM Runtime
description: Universal JavaScript runtime for sandboxed script execution with manifest-driven bindings.
---

The universal runtime (`@xriptjs/runtime`) executes user scripts inside a secure QuickJS WASM sandbox. It reads a manifest to determine which bindings to expose, enforces capability gates, and prevents access to anything outside the declared surface. It runs in any JavaScript environment: browser, Node.js, Deno, Bun, and Cloudflare Workers.

For Node.js-only applications that need `createRuntimeFromFile` or native V8 performance, see the [Node.js Runtime](/runtimes/node). For Rust host applications, see the [Rust Runtime](/runtimes/rust). For .NET applications, see the [C# Runtime](/runtimes/csharp). For a comparison of all runtimes, see [Choosing a Runtime](/runtimes/overview).

## Installation

```sh
npm install @xriptjs/runtime
```

The runtime uses QuickJS compiled to WebAssembly for sandboxing. No native dependencies.

## Creating a Runtime

The runtime uses a factory pattern. First, initialize the WASM module (done once), then create runtimes from it:

```javascript
import { initXript } from "@xriptjs/runtime";

const xript = await initXript();
const runtime = xript.createRuntime(manifest, {
  hostBindings: { greet: (name) => `Hello, ${name}!` },
});
```

`initXript()` loads the QuickJS WASM module asynchronously and returns a factory. `createRuntime()` on the factory is synchronous: create as many runtimes as you need without additional async overhead.

For applications with async host bindings, use the async variant:

```javascript
import { initXriptAsync } from "@xriptjs/runtime";

const xript = await initXriptAsync();
const runtime = await xript.createRuntime(manifest, {
  hostBindings: {
    getData: async (key) => await db.get(key),
  },
});
```

`initXriptAsync()` uses the asyncified WASM build, which allows host functions to return Promises that scripts can `await`.

## Options

`createRuntime()` accepts a `RuntimeOptions` object:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hostBindings` | `HostBindings` | (required) | Map of binding names to host functions |
| `capabilities` | `string[]` | `[]` | List of capabilities granted to this script |
| `console` | `{ log, warn, error }` | no-op functions | Console output routing |

### Host Bindings

Host bindings are a flat object mapping binding names to functions, or namespace names to objects of functions:

```javascript
const hostBindings = {
  log: (msg) => console.log(msg),
  player: {
    getName: () => "Hero",
    getHealth: () => 80,
    setHealth: (value) => { health = value; },
  },
};
```

Every binding declared in the manifest should have a corresponding host function. If a manifest binding has no host function, calling it throws a `BindingError`.

### Capabilities

Capabilities are an opt-in security layer. By default, no capabilities are granted. Pass the capability names the script should have access to:

```javascript
const runtime = xript.createRuntime(manifest, {
  hostBindings,
  capabilities: ["modify-player", "storage"],
});
```

Any call to a binding gated by a capability not in this list throws a `CapabilityDeniedError`.

## Executing Scripts

### Synchronous

```javascript
const result = runtime.execute("2 + 2");
// { value: 4, duration_ms: 0.5 }
```

`execute(code)` runs the code synchronously and returns an `ExecutionResult`:

| Field | Type | Description |
|-------|------|-------------|
| `value` | `unknown` | The result of the last expression |
| `duration_ms` | `number` | Wall-clock execution time in milliseconds |

### Asynchronous

```javascript
const result = await runtime.executeAsync("return await data.get('score');");
// { value: "42", duration_ms: 1.2 }
```

`executeAsync(code)` wraps the code in an async function. Use `return` and `await` as needed. Returns a Promise resolving to an `ExecutionResult`.

## Cleanup

When you're done with a runtime, call `dispose()` to free the underlying WASM resources:

```javascript
runtime.dispose();
```

Failing to call `dispose()` will leak WASM memory. In long-running applications, always dispose runtimes when they're no longer needed.

## Error Types

The runtime exports four error classes, all available as named imports:

### ManifestValidationError

Thrown when the manifest fails structural validation.

```javascript
import { ManifestValidationError } from "@xriptjs/runtime";

try {
  xript.createRuntime({}, { hostBindings: {} });
} catch (e) {
  // e.name === "ManifestValidationError"
  // e.issues === [{ path: "/xript", message: "required field..." }, ...]
}
```

The `issues` array contains every problem found, with a `path` and `message` for each.

### BindingError

Thrown when a host function throws or is not provided.

```javascript
import { BindingError } from "@xriptjs/runtime";
// e.name === "BindingError"
// e.binding === "player.getHealth"
// e.message includes the original error message
```

### CapabilityDeniedError

Thrown when calling a capability-gated binding without the required capability.

```javascript
import { CapabilityDeniedError } from "@xriptjs/runtime";
// e.name === "CapabilityDeniedError"
// e.capability === "modify-player"
// e.binding === "player.setHealth"
```

### ExecutionLimitError

Thrown when the script exceeds configured execution limits (timeout, memory).

```javascript
import { ExecutionLimitError } from "@xriptjs/runtime";
// e.name === "ExecutionLimitError"
// e.limit === "timeout_ms"
```

## Sandbox Details

The sandbox provides a restricted JavaScript environment powered by QuickJS compiled to WebAssembly:

**Available:** `Math`, `JSON`, `Date`, `Number`, `String`, `Boolean`, `Array`, `Object`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Promise`, `RegExp`, `Symbol`, `Proxy`, `Reflect`, typed arrays, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, and all standard error constructors.

**Blocked:** `eval`, `new Function`, `process`, `require`, `import`, `fetch`, `setTimeout`, `setInterval`, `Buffer`, `__dirname`, `__filename`, and all Node.js-specific globals.

**Frozen namespaces:** Namespace objects are frozen with `Object.freeze`. Scripts cannot add, remove, or reassign namespace members.

**Execution limits:** The `timeout_ms` field in the manifest's `limits` section controls how long a script can run. Default is 5000ms. The `memory_mb` field controls maximum memory usage.

## Browser Usage

Since the runtime uses QuickJS WASM, it works in browsers without any Node.js-specific APIs:

```javascript
import { initXript } from "@xriptjs/runtime";

const xript = await initXript();
const runtime = xript.createRuntime(manifest, { hostBindings });
const result = runtime.execute("greet('World')");
runtime.dispose();
```

Bundle with any standard bundler (Vite, webpack, esbuild, Rollup). The WASM binary is loaded automatically by `quickjs-emscripten`.

## Loading Mods

`runtime.loadMod(modManifest, options?)` validates a mod manifest against the app manifest, sanitizes any fragment HTML, and returns a `ModInstance`. If the mod manifest declares an `entry` script, that script runs during loading.

```javascript
const mod = runtime.loadMod(modManifest, { sources: fragmentSources });
console.log(mod.name, mod.version);
console.log(mod.fragments.length);
```

`fragmentSources` is an object mapping fragment IDs to their raw HTML strings. The runtime sanitizes each source before attaching it to the mod.

## Fragment Lifecycle Hooks

`runtime.fireFragmentHook(fragmentId, lifecycle, bindings?)` fires a lifecycle hook registered by the active mod script and returns any command buffer operations the script issued. Supported lifecycles: `mount`, `unmount`, `update`, `suspend`, `resume`.

```javascript
const ops = runtime.fireFragmentHook("health-bar", "update", { health: 75 });
// ops is an array of command arrays: [["setText", ".hp", "75"], ...]
```

Each entry in `ops` is a command array whose first element is the command name followed by its arguments. The host applies these operations to the rendered fragment.

## Fragment Processing

`runtime.processFragment(fragmentId, source, bindings)` evaluates `data-bind` and `data-if` attributes in the fragment HTML against the provided binding data and returns the resolved output.

```javascript
const { html, visibility } = runtime.processFragment("health-bar", source, {
  health: 75,
  maxHealth: 100,
});
```

`html` is the processed HTML string with `data-bind` values substituted. `visibility` is a map of element selectors to boolean values derived from `data-if` expressions.
