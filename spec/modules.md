# Module-Format Mods

This document specifies the `entry.format: "module"` evaluation mode, the rules that govern ES-module mod entries across all conformant runtimes, and the authoring conventions that make a TypeScript mod compile to a module the runtime can load.

A mod entry is either a **classic script** (`format: "script"`, the default) or an **ES module** (`format: "module"`). Both modes evaluate a single self-contained entry source in the same sandbox realm. Module mode adds top-level `export` syntax and automatic export harvesting; it does not add module loading.

## Evaluation Model

When a mod's `entry` block declares `format: "module"`:

- The entry source is evaluated as an **ES module**, one-shot, at `load_mod` / `loadMod` / `LoadMod` time — the same call site that evaluates a classic script in script mode.
- Evaluation happens in the **same sandbox realm and global** as a script-mode mod. Bindings, hooks, `console`, the `xript` global, the exports surface, and the fragment API are installed on `globalThis` **before** the module is evaluated. A module sees the identical ambient environment a script sees: the host bindings as globals/namespaces, `hooks`, `console`, and `xript`.
- Top-level code runs **exactly once**. Side-effecting registration (`hooks.fragment.update(...)`, `xript.exports.register(...)`) is legal inside a module and behaves identically to script mode.
- **Top-level `await` is permitted** where the runtime's module evaluator supports it. A module that never settles its top-level `await` is a load-time error, mirroring the existing "workflow promise never resolved" handling.
- A failed module instantiation or evaluation (syntax error, top-level throw, unresolved import) surfaces as the **same load-time error** the script path uses today — never a silent no-op.

Module-vs-script is a manifest fact (`entry.format`) read by the loader; the host calls the same load entry point in both modes. The single entry script (`entry.script`) is the v1 baseline: exactly one module source is evaluated. Multi-module / array entry is out of scope for module mode in v1.

### Runtime evaluators

- **rust** (`xript-runtime`): rquickjs `Module` compile + eval; drive pending jobs to settle, then catch.
- **js** (`@xriptjs/runtime`): only the async sandbox (`createSandboxAsync`) supports module evaluation. The sync sandbox (`createSandboxSync`) must reject a module-format entry with a `ModuleUnsupportedError` ("module-format mods require the async sandbox") rather than silently evaluating it as a script.
- **node** (`@xriptjs/runtime-node`): `node:vm` `SourceTextModule` with a deny-all link callback, then `module.evaluate()`.
- **csharp** (`Xript.Runtime`): Jint `Engine.Modules.Add` + `Engine.Modules.Import`, with a module loader that rejects external specifiers.

## Top-Level Exports Become Host-Invokable Exports

After a module evaluates, the runtime reads its **top-level named function exports** and registers each into the same export registry that `xript.exports.register` feeds. A function exported as `transcribe` becomes invokable via the unchanged `invoke_export('transcribe', args)` / `invokeExport` / `InvokeExport` path. No `xript.exports.register` call is required in module mode.

- Script mode keeps using `xript.exports.register`. Both paths coexist and **merge into one registry**.
- **Collision rule:** if a top-level export and an explicit `register()` call share a name, **`register()` wins** — it is an explicit imperative act and runs after the export binding is established.
- Only **function-valued** named exports are harvested. Non-function named exports (`export const VERSION = "1.0"`) are ignored for invocation purposes (they are data, not callables) and do not error.
- The **default export is not harvested** — exports are addressed by name and a default export has no stable invocation name.
- **Capability gating is unchanged:** `entry.exports[name].capability` gates `invoke_export` by name via the host-side export-capability map, regardless of whether the export came from a module binding or a `register()` call. Audit emission is identical for both origins.

`entry.exports` in the manifest **documents and capability-gates** these exports. It need not enumerate them for invocation to work; the runtime is authoritative for what actually registered. It SHOULD still enumerate them for typed authoring and docs.

## Imports Are Default-Deny; Approved Libraries Lift It

A module-format mod is a self-contained entry module whose imports are **denied by default**. Every `import` specifier is **rejected at link/instantiation time**, before any top-level code runs, **unless** the specifier names a library the host has approved (see [Approved Libraries](#approved-libraries)). That covers bare specifiers (`"fs"`, `"lodash"`), absolute, URL, and (in v1) relative alike. This preserves [security guarantee #1](./security.md) (no sandbox escape) and the eval ban on dynamic `import()`.

- Static `import x from "..."` of an unapproved specifier fails at link time.
- Dynamic `import("...")` fails at call time regardless of approval (already covered by the no-eval / dynamic-import ban; module mode does not re-enable it, and the library lift applies only to static imports).
- The rejection is a **load-time error** with a stable, cross-runtime identity: error name `ImportDeniedError`, with `.specifier` set, and a message of the form: `import of "<specifier>" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)`.

Relative intra-mod imports are denied in v1: the single-entry self-contained module is the baseline.

## Approved Libraries

The host manifest's top-level `libraries` map is a **curated allow-list of importable libraries** — the capability model applied to modules. Default-deny is intact: the host curates *which* libraries exist, and a capability gates *which mods* may import each.

```jsonc
// host manifest
{
	"libraries": {
		"@example/doc": {
			"description": "Shared markdown + doc rendering.",
			"capability": "lib.doc",
			"version": "^1.0.0"
		}
	}
}
```

```ts
// host wiring — the host ships the implementation; xript provides the link path
createRuntime(manifest, { hostBindings, libraries: { "@example/doc": docModuleSource } });
```

```js
// mod entry — a real static import, linked in-sandbox
import { renderMarkdown } from "@example/doc";
export function render(md) { return renderMarkdown(md); }
```

### Semantics

- **Resolution order at link time:** the specifier must (1) be declared in the resolved host manifest's `libraries`, (2) have source registered by the host at runtime construction, and (3) pass the capability gate — the granted set must satisfy the library's `capability` under the v0.7 subsumption rules (`lib` ⊇ `lib.doc`). A miss at any step is a load-time error: undeclared → `ImportDeniedError`; declared-but-unregistered → `LibraryUnavailableError` (the host forgot to supply the source — a host bug, named as such); capability denied → `CapabilityDeniedError` naming the specifier and the missing capability. An ungated library (no `capability`) skips step (3).
- **In-sandbox execution:** an approved library evaluates **inside the sandbox, at the importing mod's own privilege**. It sees the same ambient environment the mod sees and crosses no marshalling boundary — imports are full-fidelity object/function references, not JSON. Approving a library grants the mod no new power; it is the host vouching "this is sandbox-safe shared code I choose to offer."
- **One instance per runtime:** a library module is instantiated once and shared by everything that imports it in that runtime, standard ES module semantics.
- **Import-clean rule:** an approved library must be a **self-contained, pre-bundled ES module with no imports of its own**. Library source is run through the same default-deny loader — a library importing an unapproved specifier fails exactly as a mod would, and runtimes MUST reject a registered library whose source contains static `import` / `export … from` / dynamic `import(` forms at registration time, using the same conservative-detector posture as the CommonJS guard (false positives in strings/comments are accepted). This stops the import-deny from being laundered through a library's dependency tree.
- **CommonJS guard applies:** registered library source is subject to the same `CommonJSDetectedError` detector as mod entries.
- **Capability declaration integrity:** a library's `capability` scope must be declared in the manifest's `capabilities` map, the same rule that governs binding and slot gates.

### Runtime requirements

Libraries link at module-entry evaluation, so they ride the module path end to end. In the universal JS runtime that means the **async sandbox**: `initXriptAsync` + `loadModAsync`. The sync sandbox rejects module-format entries outright (`ModuleUnsupportedError`), and there is no other import site — a host on the sync path adopts the async runtime first, then adds `libraries`. The Node, Rust, and C# runtimes evaluate modules on their standard load paths, so no equivalent split exists there.

### What stays host-side

The library lift is for **pure compute** — markdown rendering, date math, validation, formatting: code that needs no privilege beyond the sandbox. Anything touching host state, the filesystem, or the network stays a **host binding** (host-side execution, JSON boundary, per-function capability). The two columns are complementary, not competing; a host typically offers both.

## CommonJS Is Never Supported

CommonJS is not a supported module format in any mode. Runtimes and the validator **must detect CommonJS artifacts** in a mod entry and fail loudly with a fix-it message, rather than producing a mod whose exports silently never register (the failure mode when a misconfigured `tsconfig` emits CJS: `require`/`module` are undefined in the sandbox and the top-level code throws an opaque `ReferenceError`, or an `exports.foo = ...` assignment mutates a stray global and registers nothing).

### Canonical detector

The detector is conservative — it favors over-rejection over a silently-broken mod. It flags an entry source when any of the following appear at any position:

- `require(` — the CommonJS require call form.
- `module.exports` — the CommonJS module-exports assignment or reference.
- `exports.<ident> =` or `exports[` — a top-level CommonJS named-export assignment.

The reference match is the union of these case-sensitive patterns:

- `/\brequire\s*\(/`
- `/\bmodule\s*\.\s*exports\b/`
- `/\bexports\s*\.\s*[A-Za-z_$][\w$]*\s*=/`
- `/\bexports\s*\[/`

False positives inside string literals or comments are accepted: a mod flagged as CJS that was actually fine is a one-line author fix, whereas a CJS mod that loads silently broken is the exact bug this guard kills. Runtimes MUST NOT build a full tokenizer to avoid over-rejection.

The check runs **before** module/script evaluation, in **both** script and module mode (a script-mode entry compiled to CJS is equally broken).

### Error identity

Error name `CommonJSDetectedError`, with `.artifact` set to the matched form (`require()`, `module.exports`, or `exports.x`), and a message that points at the ESM/script-mode fix and the authoring guide:

```
CommonJS artifacts detected in mod entry (found: <artifact>). xript mods must be authored
as ES modules (entry.format: "module", top-level export) or as classic scripts using
xript.exports.register — never CommonJS. Fix your tsconfig to emit ESM (module: "esnext",
moduleResolution: "bundler"/"nodenext") or remove the require()/module.exports usage.
See https://xript.dev/spec/modules/.
```

### Two enforcement homes

Both ship, by design:

- **Validate-time (early, author/CI-facing):** when the entry source is reachable, the validator raises a hard error with keyword `commonjs-detected` on `/entry`. This is the primary fix-it surface — it catches a misconfigured `tsconfig` at author time.
- **Runtime load-time (late, host-facing):** the runtime runs the same detector before evaluation as defense-in-depth, so a misconfigured `tsconfig` can never silently break — even for a mod the validator never saw.

## Authoring Mods in TypeScript

A TypeScript mod must compile to an **ES module** the runtime can evaluate. The rules:

1. **Compile to ESM.** Set `module: "ESNext"` (or `"NodeNext"`) and `moduleResolution: "Bundler"` (or `"NodeNext"`) in `tsconfig.json`. `module: "Node16"` with a default package can emit CJS-shaped output — the exact footgun the CommonJS guard exists to catch.
2. **Use top-level `export`s for invokable functions.** `export function transcribe(...)` is registered automatically; no `xript.exports.register` call is needed. Declare each export in the mod manifest's `entry.exports` for typed authoring, docs, and capability gating.
3. **Import only approved libraries.** Imports are default-deny; the only specifiers that link are the ones in the host's `libraries` allow-list (gated by their declared capability). For everything else, use host bindings (available as ambient globals) instead of pulling in packages.
4. **Never CommonJS.** No `require(...)`, no `module.exports`, no `exports.x = ...`. These fail loudly at both validate and load time.
5. **Type against the ambient surface.** Generate an ambient declaration file with `xript typegen --ambient` from the mod (and optionally the host) manifest, and reference it from `tsconfig` `types` or a triple-slash directive. This types the `xript` global, the host bindings, `hooks`, and the mod's own `Exports`.

A minimal module-mode mod entry:

```ts
/// <reference path="./xript-env.d.ts" />

export function transcribe(audioUrl: string): string {
	log("transcribing " + audioUrl);
	return "transcript of " + audioUrl;
}

hooks.fragment.update("transcript-panel", (bindings, fragment) => {
	log("fragment updated with: " + JSON.stringify(bindings));
});
```

## Related Documents

- **[Security](./security.md)**: module syntax is allowed, but imports are denied and CommonJS is loudly rejected — guarantees #1 (no sandbox escape) and #4 (no eval) are strengthened, not weakened.
- **[Bindings](./bindings.md)**: defines the runtime error vocabulary, including `ImportDeniedError` and `CommonJSDetectedError`.
- **[Fragments](./fragments.md)**: the inert-fragment model that module-mode mods contribute to.
