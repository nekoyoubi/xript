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

`createRuntimeFromFile` also resolves manifest `extends` before constructing the runtime. A manifest that names one or more base manifests inherits and deep-merges them (base-then-child, transitively, with cycle detection) so inherited bindings, slots, and capabilities are present before validation. Base paths resolve relative to the manifest file on disk. See [Manifest Inheritance](/spec/manifest#manifest-inheritance-extends) for the full add-new / fill / refine model.

## Options

`createRuntime` and `createRuntimeFromFile` accept the same `RuntimeOptions`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hostBindings` | `HostBindings` | (required) | Map of binding names to host functions |
| `capabilities` | `string[]` | `[]` | List of capabilities granted to this script |
| `console` | `ConsoleHandler` | no-op functions | Console output routing (severity-aware) |
| `audit` | `(event: AuditEvent) => void` | none | Per-capability audit channel; fired on every allowed binding invocation and on every capability-denied hook fill |
| `hardLimits` | `HardLimits` | none | Hard caps for memory, CPU time, and stack depth |
| `cancellation` | `CancellationToken` | none | Host-driven cooperative cancellation |
| `rolePreferences` | `Record<string, string>` | none | Preferred provider per role for `resolveRole` |
| `commandPreferences` | `Record<string, string>` | none | Preferred mod per command id or slot id for `resolveCommand` |
| `validateInput` | `CommandInputValidator` | none | Opt-in argument checking at command invoke; the runtime bundles no JSON Schema validator, so a host wanting full `input` validation passes its own predicate |
| `debug` | `DebugOptions` | none | Attaches a DAP-shaped debug session to the runtime |

### Audit channel

Pass an `audit` callback to observe every allowed binding invocation. It's fire-and-forget; an emit that throws never interrupts script execution:

```javascript
const runtime = createRuntime(manifest, {
  hostBindings,
  capabilities: ["storage"],
  audit: ({ binding, capability, at }) => {
    log.info({ binding, capability, at });
  },
});
```

Each `AuditEvent` carries `binding` (the invoked name), `capability` (the gating capability, or `null` if the binding is ungated), `at` (a `Date.now()` timestamp), and `decision` (`"invoke"` or `"denied"`). A `"denied"` event also carries `mod` and `hook`, naming the mod whose hook fill was refused.

### Cooperative cancellation

A `CancellationToken` lets the host interrupt in-flight work. Node's `vm` has no mid-run interrupt hook, so the token is checked at execute/invoke entry rather than mid-execution; a cancelled run surfaces a distinct `CancellationError`, not an `ExecutionLimitError`:

```javascript
import { createRuntime, CancellationToken } from "@xriptjs/runtime-node";

const cancellation = new CancellationToken();
const runtime = createRuntime(manifest, { hostBindings, cancellation });

// later, from the host:
cancellation.cancel();
```

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

## Host-Invoke Exports

A mod can declare named exports the host calls directly. After loading the mod, invoke an export by name; the runtime gates the call against any capability the export declares and honors the return value:

```javascript
const value = runtime.invokeExport("transcribe", ["hello"]);
const valueAsync = await runtime.invokeExportAsync("transcribe", ["hello"]);
```

Module-format mods expose their top-level named function exports automatically: `export function transcribe()` becomes host-invokable with no `xript.exports.register` call. Calling an export gated by an ungranted capability throws `CapabilityDeniedError`.

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
| `CapabilityDeniedError` | Calling a gated binding (or export) without the capability | Yes |
| `ExecutionLimitError` | Script exceeds timeout or resource limits | No |
| `CancellationError` | Host cancelled execution via the `CancellationToken` | No |
| `InvokeError` | A host-invoke export fails or is missing | Yes |
| `ModEntryError` | A mod entry script fails to load | N/A (thrown at load time) |
| `ImportDeniedError` | A mod attempts to import an external module | N/A (thrown at load time) |
| `CommonJSDetectedError` | A mod entry contains `require`/`module.exports`/top-level `exports.` | N/A (thrown at load time) |
| `ModuleUnsupportedError` | A module-format mod is loaded via the synchronous `loadMod` | N/A (use `loadModAsync`) |

```javascript
import {
  BindingError,
  CapabilityDeniedError,
  ExecutionLimitError,
  CancellationError,
  InvokeError,
  ModEntryError,
  ImportDeniedError,
  CommonJSDetectedError,
  ModuleUnsupportedError,
} from "@xriptjs/runtime-node";
```

## Sandbox Details

The Node.js runtime creates a `vm.Context` with a restricted global environment:

- **Code generation disabled:** `vm.createContext` is configured with `codeGeneration: { strings: false, wasm: false }`. This blocks `eval()` and `new Function()` at the V8 level.
- **Standard globals available:** `Math`, `JSON`, `Date`, `Number`, `String`, `Boolean`, `Array`, `Object`, `Map`, `Set`, `Promise`, `RegExp`, `Symbol`, `Proxy`, `Reflect`, typed arrays, and standard error constructors
- **Blocked:** `process`, `require`, `import`, `fetch`, `setTimeout`, `setInterval`, `Buffer`, `__dirname`, `__filename`
- **Frozen namespaces:** Namespace objects are frozen with `Object.freeze`
- **Execution limits:** Timeout enforced via `vm.Script.runInContext` timeout option

## Loading Mods

`runtime.loadMod(modManifest, options?)` validates a mod manifest against the app manifest, sanitizes any fragment HTML, and returns a `ModInstance`. If the mod manifest declares a classic-script `entry`, that script runs during loading.

```javascript
const mod = runtime.loadMod(modManifest, { fragmentSources });
console.log(mod.name, mod.version);
console.log(mod.fragments.length);
```

`fragmentSources` maps file names to their contents: every entry script the mod's `entry` names (`modEntryScripts(modManifest.entry)` lists them) and every non-inline fragment `source`. The runtime sanitizes each fragment source before attaching it to the mod.

An entry script missing from `fragmentSources` throws `MissingEntryScriptError`, and an entry that throws while loading throws `ModEntryError`. A host that would rather load the mod anyway passes `entryErrors: "report"` to `createRuntime`; the failure then lands on `mod.diagnostics` instead. Every load-time finding, including warnings such as markup in a `source` that is not marked `inline`, also reaches the optional `onModDiagnostic` callback:

```javascript
const runtime = createRuntime(manifest, {
  hostBindings,
  entryErrors: "report",
  onModDiagnostic: (d) => console.warn(`[${d.mod}] ${d.code}: ${d.message}`),
});
```

A mod contributes through a single `fills` object keyed by host slot id. A fragment is a fill of a fragment-format slot, a provider role is a fill of a role-typed slot, and a lifecycle-hook handler is a fill of an event-typed slot. The runtime checks that each filled slot exists and that the mod holds the slot's capability, and leaves the inner fill shape to the slot's type. Legacy `fragments[]` and `contributions` shapes still load (with a deprecation warning) for migration.

### Module-format mods

A mod whose `entry.format` is `"module"` is a real ES module and must be loaded with the async variant, since module evaluation is asynchronous:

```javascript
const mod = await runtime.loadModAsync(modManifest, { fragmentSources });
```

Top-level named function exports auto-register as host-invokable (see [Host-Invoke Exports](#host-invoke-exports)). External imports stay denied; `import x from "fs"` throws `ImportDeniedError` at load. CommonJS artifacts (`require`, `module.exports`, top-level `exports.`) throw `CommonJSDetectedError` with a fix-it message. Calling `loadMod` (sync) on a module-format mod throws `ModuleUnsupportedError`; use `loadModAsync`. See [Module-Format Mods](/spec/modules) for the authoring canon.

## Slots and Provider Roles

After loading mods, resolve the contributions a host slot collected, ordered by priority and cardinality:

```javascript
const all = runtime.resolveSlot("main-panel");        // SlotContribution[]
const one = runtime.resolveSlotSingle("toolbar-icon"); // SlotContribution | null
```

Provider roles let mods supply named functions a host looks up by logical role rather than by hardcoded global. A mod fills a role-typed slot; the host resolves it (candidates ordered by mod name, overridable via `rolePreferences`):

```javascript
const provider = runtime.resolveRole("transcriber");   // RoleResolution | null
const providers = runtime.resolveRoleAll("transcriber"); // RoleResolution[]
```

Declaring a role grants nothing; the named functions stay gated by their own capabilities. Resolution used to return whichever provider was loaded first, so reordering the host's mod array silently changed the winner; it no longer does.

Command-typed slots collect named, invocable actions, resolved and invoked the same way:

```javascript
const palette = runtime.resolveCommands("palette.commands");    // ordered ResolvedCommand[]
const one = runtime.resolveCommand("wrap.double");              // bare id or "mod:id", or null
const result = runtime.invokeCommand(one, { close: ")" });
const async = await runtime.invokeCommandAsync(one, { close: ")" });
```

Ordering is `priority` descending, then command `id`, then owning mod name, so it does not depend on load order, and a `multiple: false` command slot resolves to exactly one command across all mods. `invokeCommand` merges the fill's bound `args` under the caller's (shallow, caller wins) and routes through the addressed per-mod export path, re-checking the handler's export capability at call time. A throwing handler propagates its error, unlike a hook handler. Command fills arrive on `mod.commandFills`; before v0.8.0 they arrived untyped in `mod.dataFills[slotId]`.

## Fragment Lifecycle Hooks

`runtime.fireFragmentHook(fragmentId, lifecycle, bindings?)` fires a lifecycle hook registered by the active mod script and returns any command buffer operations the script issued. Supported lifecycles: `mount`, `unmount`, `update`, `suspend`, `resume`.

```javascript
const ops = runtime.fireFragmentHook("health-bar", "update", { health: 75 });
// ops is an array of command arrays: [["setText", ".hp", "75"], ...]
```

Each entry in `ops` is a command array whose first element is the command name followed by its arguments. The host applies these operations to the rendered fragment.

A fragment fill declares its DOM event handlers in a `handlers` array (each entry is `{ selector, on, handler }`). The older `events` key is accepted as a deprecated alias; `handlers` wins if both are present. This is distinct from the top-level `events` catalog, which declares what the *host* broadcasts: bindings are what you call, slots and handlers are what handles, `events` is what the host emits.

## Lifecycle Hooks

`runtime.fireHook(hookName, options?)` fires a host lifecycle hook and returns the values its handlers produced. Standalone `hooks` is deprecated in favor of event-typed slots; a hook is a slot whose `accepts` is the event-handler kind, and firing it calls that slot's fills. Host-side hook firing is unchanged. See the [Hooks](/spec/hooks) spec for the slot-fill model.

## Debugging

The Node.js runtime ships a DAP-shaped debug protocol. Pass `debug` in the options to attach a session, then drive it with `debugExecute` and `debugSession`:

```javascript
const runtime = createRuntime(manifest, { hostBindings, debug: {} });
const session = runtime.debugSession();
session.setBreakpoints("xript-script.js", [{ line: 3 }]);
await runtime.debugExecute("const x = compute();\nreturn x;");
```

The session exposes set/clear breakpoints by source position, pause/resume/step in/over/out, and scope/local/stack-frame inspection. Node's `vm` runtime instruments the source AST to support per-line breakpoints. Engine fidelity differs across runtimes and is surfaced via `DebugFidelity` rather than papered over. See [Debugging](/spec/debugging) for the protocol.
