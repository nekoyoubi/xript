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

The runtime uses a factory pattern. Initialize the WASM module once, then create runtimes from it:

```javascript
import { initXript } from "@xriptjs/runtime";

const xript = await initXript();
const runtime = xript.createRuntime(manifest, {
  hostBindings: { greet: (name) => `Hello, ${name}!` },
});
```

`initXript()` loads the QuickJS WASM module asynchronously and returns a factory. `createRuntime()` on the factory is synchronous, so spin up as many runtimes as you need without paying the async cost again.

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
| `console` | `ConsoleHandler` | no-op functions | Console output routing (`log`/`info`/`warn`/`error`/`debug`/`trace`, or a single `onLog(severity, ...args)`) |
| `audit` | `(event: AuditEvent) => void` | none | Fire-and-forget hook called on every allowed binding invocation with `{ binding, capability, at }` |
| `hardLimits` | `HardLimits` | manifest `limits` | Host-side `timeout_ms` / `memory_mb` / `max_stack_depth` caps, applied on top of the manifest's `limits` |
| `cancellation` | `CancellationToken` | none | Cooperative cancellation token; cancelling interrupts in-flight execution and surfaces a `CancellationError` |
| `rolePreferences` | `Record<string, string>` | none | Per-role provider preference (`role` → mod name) consulted by `resolveRole` |
| `debug` | `DebugOptions` | none | Enables the DAP-shaped debug session reachable via `debugExecute` / `debugSession` |

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

### Cancellation

Pass a `CancellationToken` to interrupt long-running scripts. Cancelling the token surfaces a `CancellationError` (distinct from a timeout `ExecutionLimitError`) at the next interruption check point:

```javascript
import { initXriptAsync, CancellationToken, CancellationError } from "@xriptjs/runtime";

const cancellation = new CancellationToken();
const xript = await initXriptAsync();
const runtime = await xript.createRuntime(manifest, { hostBindings, cancellation });

setTimeout(() => cancellation.cancel(), 1000);
try {
  await runtime.executeAsync("while (true) {}");
} catch (e) {
  // e instanceof CancellationError
}
```

### Audit Channel

The optional `audit` callback fires once per allowed binding invocation, reporting `{ binding, capability, at }`. It is fire-and-forget; a throw from the callback never breaks script execution:

```javascript
const runtime = xript.createRuntime(manifest, {
  hostBindings,
  capabilities: ["storage"],
  audit: ({ binding, capability, at }) => {
    log.record(`${binding} (${capability ?? "ungated"}) @ ${at}`);
  },
});
```

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

### Debugging

When `createRuntime` is given a `debug` option, `runtime.debugExecute(code)` runs the script under the DAP-shaped debug protocol and `runtime.debugSession()` returns the live `DebugSession` (or `null` when debugging is off). The session lets the host set/clear breakpoints by source position, pause/resume/step, and inspect scopes, locals, and stack frames. See [Debugging](/runtimes/debugging) for the full protocol and per-engine fidelity notes.

## Invoking Mod Exports

A mod authored as an ES module (`entry.format: "module"`) auto-registers its top-level named function exports as host-invokable. The host calls them by name:

```javascript
const result = runtime.invokeExport("transcribe", ["input text"]);
const asyncResult = await runtime.invokeExportAsync("fetchAll", [query]);
```

`invokeExport(name, args)` runs synchronously; `invokeExportAsync(name, args)` returns a Promise. If a mod declared a capability on the export, the call is gated — invoking without that capability granted throws `CapabilityDeniedError`. A missing or throwing export surfaces an `InvokeError`.

## Firing Hooks

`runtime.fireHook(hookName, options?)` invokes every handler a mod registered for a named lifecycle hook and returns their results. `options` carries an optional `phase` and `data`:

```javascript
const results = runtime.fireHook("onTurnStart", { phase: "before", data: { turn: 3 } });
```

Standalone manifest `hooks` are deprecated in favor of event-typed slots (a slot whose `accepts` is the event-handler kind), but host-side firing through `fireHook` is unchanged.

## Resolving Slots and Roles

When mods fill host-declared slots, the host pulls the contributions back out by slot id:

```javascript
const contributions = runtime.resolveSlot("toolbar");      // priority-ordered SlotContribution[]
const primary = runtime.resolveSlotSingle("status-bar");   // first contribution, or null
```

Provider roles resolve the same way. A mod fills a role-typed slot, and the host asks for a logical provider by role name:

```javascript
const provider = runtime.resolveRole("formatter");   // { addon, fns } or null, honoring rolePreferences
const all = runtime.resolveRoleAll("formatter");      // every provider, for building a picker
```

Declaring a role grants nothing on its own; the named functions stay gated by their own capabilities.

## Cleanup

When you're done with a runtime, call `dispose()` to free the underlying WASM resources:

```javascript
runtime.dispose();
```

Failing to call `dispose()` leaks WASM memory. In long-running applications, dispose runtimes the moment they're no longer needed.

## Error Types

The runtime exports its error classes as named imports:

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

### CancellationError

Thrown when execution is interrupted by a cancelled `CancellationToken` (distinct from a timeout).

```javascript
import { CancellationError } from "@xriptjs/runtime";
// e.name === "CancellationError"
```

### InvokeError

Thrown when a host-invoked export is missing or throws.

```javascript
import { InvokeError } from "@xriptjs/runtime";
// e.name === "InvokeError"
// e.export === "transcribe"
```

### Module & Mod Errors

`loadMod` / `loadModAsync` and module-format mods surface a few more named classes:

- `ModManifestValidationError` — the mod manifest fails validation or cross-validation against the app's slots and capabilities; carries an `issues` array.
- `ModEntryError` — a mod entry script throws while loading; carries `modName`.
- `ModuleUnsupportedError` — a `entry.format: "module"` mod was loaded through the synchronous `loadMod`; module mods require `loadModAsync` (async sandbox).
- `ImportDeniedError` — a mod tried to `import` an external module; carries the offending `specifier`. The no-external-modules guarantee is unconditional.
- `CommonJSDetectedError` — a mod entry contains `require(`, `module.exports`, or top-level `exports.`; carries the detected `artifact` and a fix-it message pointing at the TypeScript authoring guide.

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

`runtime.loadMod(modManifest, options?)` validates a mod manifest against the app manifest, sanitizes any fragment HTML, and returns a `ModInstance`. A mod contributes through a single `fills` object keyed by host slot id. A fragment is a fill of a fragment-format slot, a provider role is a fill of a role-typed slot, and a lifecycle hook handler is a fill of an event-typed slot. (Legacy `fragments[]` and `contributions` still validate but emit a deprecation warning.) If the mod manifest declares an `entry` classic script, it runs during loading.

```javascript
const mod = runtime.loadMod(modManifest, { fragmentSources });
console.log(mod.name, mod.version);
console.log(mod.fragments.length);
```

`fragmentSources` is an object mapping fragment IDs to their raw HTML strings. The runtime sanitizes each source before attaching it to the mod.

Mods authored as ES modules (`entry.format: "module"`) must be loaded with the async variant, which runs on the asyncified sandbox:

```javascript
const xript = await initXriptAsync();
const runtime = await xript.createRuntime(manifest, { hostBindings });
const mod = await runtime.loadModAsync(modManifest, { fragmentSources });
```

Calling the synchronous `loadMod` on a module-format mod throws `ModuleUnsupportedError`. Top-level named function exports auto-register as host-invokable — call them with [`invokeExport`](#invoking-mod-exports).

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
