# Hosting: rendering fragments

A host renders a mod's UI by driving the runtime and applying what it returns. The split is the whole job: **the runtime does the processing; the host renders the runtime's inert output and routes interaction back in.** This is the host side of the [authoring](/guidance/authoring/) topic, and the canonical case of the [host/runtime boundary](/guidance/hosting/).

## The seam

There is one public entry point: the runtime factory. A host never reaches into the runtime's internals; it drives the runtime and renders what comes back.

1. **Initialize the factory.** `const xript = await initXript()` (or `initXriptAsync()` for the async sandbox). This is the only import a host needs from `@xriptjs/runtime`.
2. **Create a runtime per app manifest.** `xript.createRuntime(manifest, { hostBindings, capabilities, console })`. The runtime is the unit of hosting — it owns sanitization, binding resolution, conditional visibility, hooks, capability enforcement, and the sandbox.
3. **Load mods into it.** `runtime.loadMod(modManifest, { fragmentSources })` returns a `ModInstance` describing the fragments and exports the mod contributed.
4. **Render inert output.** Push host data in with `modInstance.updateBindings({ ... })`, which returns `{ fragmentId, html, visibility }` per fragment; fire lifecycle and update points with `runtime.fireFragmentHook(fragmentId, lifecycle, bindings)`, which returns a `FragmentOp[]` command buffer. The host applies that html, visibility, and op buffer to its UI — and nothing more.
5. **Route interaction back in.** When a rendered element fires a DOM event, the host hands the matching handler *declaration* (`{ selector, on, handler }`) to a dispatch callback that calls `runtime.invokeExport(handler, args)`. The fragment author's code runs in the sandbox, never in the page.

## The two directions

- **In (host → fragment):** `updateBindings` resolves `data-bind` values and `data-if` visibility; `fireFragmentHook` returns command-buffer ops. Both hand back inert data for the host to apply.
- **Out (fragment → host):** the renderer knows only a handler *name*. The host decides that name maps to a sandbox export and calls `invokeExport`. No authored logic executes in the page; that is the inert-fragment guarantee, enforced at the boundary.

## What you get is inert by contract

The runtime hands the host three things, all data: resolved `{ html, visibility }`, a `FragmentOp[]` command buffer, and handler *declarations*. The host applies the html, toggles visibility, runs the ops in order, and wires each declared handler to its dispatch callback. It honors the fill's [styling mode](/spec/fragments/#styling) (`inherit` / `isolated` / `scoped`) when it mounts. It does not branch on, compute from, or execute fragment content — that all already happened inside the sandbox.

## Do not reach past the boundary

The runtime's fragment processor and its helpers (`processFragment`, `createFragmentInstance`, `resolveBindings`) are **internal and deliberately not exported.** The sealed export surface is the design, not a gap. If you find yourself wanting to import the processor — or asking for it to be exported — you are trying to host the *processor* when the unit of hosting is the *runtime*. Load the mod and render `fireFragmentHook`'s ops instead; that is the supported seam, and it is the only one that keeps sanitization and the sandbox guarantee intact.

The reference host glue lives at `examples/svelte-fragment-renderer/` — `src/host/` drives the runtime, `src/lib/applyFragment.js` applies the inert output, and `src/host/dispatch.js` is the out-seam. Mirror it.

## Common mistakes

- **Vendoring a copy of the fragment processor into the host.** A copy is the host *reimplementing* the runtime, not hosting it. It drifts from the real sanitizer, binding, and visibility semantics, and it loses the sandbox guarantee entirely. Load the runtime; render its output.
- **Importing — or lobbying to export — an internal like `processFragment`.** The entry point is the runtime factory. The fragment seam is `fireFragmentHook` → `FragmentOp[]`. There is nothing else to import.
- **Mounting raw fragment html without applying the runtime's ops and visibility.** Raw markup is unresolved: you lose `data-bind` values, `data-if` toggles, and every command-buffer mutation. Apply the inert output the runtime returns.
- **Executing fragment markup or its handlers in the page.** The renderer only ever knows a handler *name*; the host maps it to `invokeExport`. Fragment content carries no logic of its own and must never run in the host context.
