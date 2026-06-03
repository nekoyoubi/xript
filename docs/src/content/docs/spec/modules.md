---
title: Module-Format Mods
description: Authoring mods as ES modules — top-level exports, the host-invoke seam, and the no-CommonJS rule.
---

This document specifies the `entry.format: "module"` evaluation mode: the rules that govern ES-module mod entries across all conformant runtimes, and the authoring conventions that make a TypeScript mod compile to a module the runtime can actually load.

A mod entry is one of two things: a **classic script** (`format: "script"`, the default) or an **ES module** (`format: "module"`). Both evaluate a single self-contained entry source in the same sandbox realm. Module mode buys you top-level `export` syntax and automatic export harvesting; it does not buy you module loading.

## Evaluation Model

When a mod's `entry` block declares `format: "module"`:

- The entry source is evaluated as an **ES module**, one-shot, at `load_mod` / `loadMod` / `LoadMod` time; the same call site that evaluates a classic script in script mode.
- Evaluation happens in the **same sandbox realm and global** as a script-mode mod. Bindings, hooks, `console`, the `xript` global, the exports surface, and the fragment API are installed on `globalThis` **before** the module is evaluated. A module sees the identical ambient environment a script sees: the host bindings as globals/namespaces, `hooks`, `console`, and `xript`.
- Top-level code runs **exactly once**. Side-effecting registration (`hooks.fragment.update(...)`, `xript.exports.register(...)`) is legal inside a module and behaves identically to script mode.
- **Top-level `await` is permitted** where the runtime's module evaluator supports it. A module that never settles its top-level `await` is a load-time error, mirroring the existing "workflow promise never resolved" handling.
- A failed module instantiation or evaluation (syntax error, top-level throw, unresolved import) surfaces as the **same load-time error** the script path uses today, never a silent no-op.

Module-vs-script is a manifest fact (`entry.format`) read by the loader; the host calls the same load entry point in both modes. The single entry script (`entry.script`) is the v1 baseline: exactly one module source is evaluated. Multi-module / array entry is out of scope for module mode in v1.

### Runtime Evaluators

- **rust** (`xript-runtime`): rquickjs `Module` compile + eval; drive pending jobs to settle, then catch.
- **js** (`@xriptjs/runtime`): only the async sandbox (`createSandboxAsync`) supports module evaluation. The sync sandbox (`createSandboxSync`) must reject a module-format entry with a `ModuleUnsupportedError` ("module-format mods require the async sandbox") rather than silently evaluating it as a script.
- **node** (`@xriptjs/runtime-node`): `node:vm` `SourceTextModule` with a deny-all link callback, then `module.evaluate()`.
- **csharp** (`Xript.Runtime`): Jint `Engine.Modules.Add` + `Engine.Modules.Import`, with a module loader that rejects external specifiers.

## Top-Level Exports Become Host-Invokable Exports

After a module evaluates, the runtime reads its **top-level named function exports** and registers each into the same export registry that `xript.exports.register` feeds. A function exported as `transcribe` becomes invokable via the unchanged `invoke_export('transcribe', args)` / `invokeExport` / `InvokeExport` path. No `xript.exports.register` call is required in module mode.

- Script mode keeps using `xript.exports.register`. Both paths coexist and **merge into one registry**.
- **Collision rule:** if a top-level export and an explicit `register()` call share a name, **`register()` wins**; it is an explicit imperative act and runs after the export binding is established.
- Only **function-valued** named exports are harvested. Non-function named exports (`export const VERSION = "1.0"`) are ignored for invocation purposes (they are data, not callables) and do not error.
- The **default export is not harvested**; exports are addressed by name, and a default export has no stable invocation name.
- **Capability gating is unchanged:** `entry.exports[name].capability` gates `invoke_export` by name via the host-side export-capability map, regardless of whether the export came from a module binding or a `register()` call. Audit emission is identical for both origins.

`entry.exports` in the manifest **documents and capability-gates** these exports. It need not enumerate them for invocation to work (the runtime is authoritative for what actually registered), but it SHOULD enumerate them for typed authoring and docs.

Module mode governs only how the entry source is *evaluated*. What a mod *contributes* (fragments, provider roles, hook handlers) is declared separately through the mod manifest's [`fills`](/spec/mod-manifest/#fills) surface, keyed by host slot id, in either mode. The in-sandbox `hooks` global shown below is the runtime API for registering fragment-lifecycle handlers; it is distinct from the manifest-level standalone `hooks` surface, which is deprecated in favor of event-typed slot fills.

## No External Imports

A module-format mod is a single self-contained entry module with **no imports**. Every `import` specifier, whether bare (`"fs"`, `"lodash"`), absolute, URL, or (in v1) relative, is **rejected at link/instantiation time**, before any top-level code runs. This preserves [security guarantee #1](/spec/security/) (no sandbox escape) and the eval ban on dynamic `import()`.

- Static `import x from "..."` fails at link time.
- Dynamic `import("...")` fails at call time (already covered by the no-eval / dynamic-import ban; module mode does not re-enable it).
- The rejection is a **load-time error** with a stable, cross-runtime identity: error name `ImportDeniedError`, with `.specifier` set, and a message of the form: `import of "<specifier>" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)`.

Relative intra-mod imports are denied in v1: the single-entry self-contained module is the baseline, and deny-all is the only import semantics that is trivially identical across every runtime's module loader.

## CommonJS Is Never Supported

CommonJS is not a supported module format in any mode. Runtimes and the validator **must detect CommonJS artifacts** in a mod entry and fail loudly with a fix-it message, rather than producing a mod whose exports silently never register (the failure mode when a misconfigured `tsconfig` emits CJS: `require`/`module` are undefined in the sandbox and the top-level code throws an opaque `ReferenceError`, or an `exports.foo = ...` assignment mutates a stray global and registers nothing).

### Canonical Detector

The detector is conservative; it favors over-rejection over a silently-broken mod. It flags an entry source when any of the following appear at any position:

- `require(`: the CommonJS require call form.
- `module.exports`: the CommonJS module-exports assignment or reference.
- `exports.<ident> =` or `exports[`: a top-level CommonJS named-export assignment.

The reference match is the union of these case-sensitive patterns:

- `/\brequire\s*\(/`
- `/\bmodule\s*\.\s*exports\b/`
- `/\bexports\s*\.\s*[A-Za-z_$][\w$]*\s*=/`
- `/\bexports\s*\[/`

False positives inside string literals or comments are accepted. A mod wrongly flagged as CJS is a one-line author fix; a CJS mod that loads silently broken is the exact bug this guard kills. Runtimes MUST NOT build a full tokenizer to avoid over-rejection.

The check runs **before** module/script evaluation, in **both** script and module mode (a script-mode entry compiled to CJS is equally broken).

### Error Identity

Error name `CommonJSDetectedError`, with `.artifact` set to the matched form (`require()`, `module.exports`, or `exports.x`), and a message that points at the ESM/script-mode fix and the authoring guide:

```
CommonJS artifacts detected in mod entry (found: <artifact>). xript mods must be authored
as ES modules (entry.format: "module", top-level export) or as classic scripts using
xript.exports.register — never CommonJS. Fix your tsconfig to emit ESM (module: "esnext",
moduleResolution: "bundler"/"nodenext") or remove the require()/module.exports usage.
See https://xript.dev/spec/modules/.
```

### Two Enforcement Homes

Both ship, by design:

- **Validate-time (early, author/CI-facing):** when the entry source is reachable, the validator raises a hard error with keyword `commonjs-detected` on `/entry`; this is the primary fix-it surface, catching a misconfigured `tsconfig` at author time.
- **Runtime load-time (late, host-facing):** the runtime runs the same detector before evaluation as defense-in-depth, so a misconfigured `tsconfig` can never silently break, even for a mod the validator never saw.

## Authoring Mods in TypeScript

A TypeScript mod must compile to an **ES module** the runtime can evaluate. The rules:

1. **Compile to ESM.** Set `module: "ESNext"` (or `"NodeNext"`) and `moduleResolution: "Bundler"` (or `"NodeNext"`) in `tsconfig.json`. `module: "Node16"` with a default package can emit CJS-shaped output, the exact footgun the CommonJS guard exists to catch.
2. **Use top-level `export`s for invokable functions.** `export function transcribe(...)` is registered automatically; no `xript.exports.register` call is needed. Declare each export in the mod manifest's `entry.exports` for typed authoring, docs, and capability gating.
3. **No external imports.** A mod is a single self-contained entry module. Any `import` is rejected at load time. Use host bindings (available as ambient globals) instead of pulling in packages.
4. **Never CommonJS.** No `require(...)`, no `module.exports`, no `exports.x = ...`. These fail loudly at both validate and load time.
5. **Type against the ambient surface.** Generate an ambient declaration file with `xript typegen --ambient` from the mod (and optionally the host) manifest, and reference it from `tsconfig` `types` or a triple-slash directive. This types the `xript` global, the host bindings, `hooks`, and the mod's own `Exports`.

`xript init --mod --typescript` scaffolds a mod project with an ESM `tsconfig` and ambient types already wired up, so a fresh mod compiles to a loadable module without any manual configuration.

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

- **[Mod Manifest](/spec/mod-manifest/)**: declares a mod's `entry` block (including `entry.format`) and the [`fills`](/spec/mod-manifest/#fills) surface through which it contributes, independent of script-vs-module evaluation.
- **[Capability Model](/spec/capabilities/)**: how `entry.exports[name].capability` gates invocation, whether the export came from a module binding or an explicit `register()` call.
- **[Fragments](/spec/fragments/)**: the inert-fragment model that module-mode mods contribute to as fragment-format slot fills.
