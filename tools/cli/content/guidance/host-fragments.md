# Rendering fragments

A host renders a mod's UI by driving the runtime and applying what it returns. The split is the whole job: **the runtime does the processing; the host renders the runtime's inert output and routes interaction back in.** This is the host side of the [authoring](/guidance/authoring/) topic, and the canonical case of the [host/runtime boundary](/guidance/hosting/).

Rendering HTML needs nothing declared: the built-in HTML vocabulary is there and unchanged. Rendering anything else — components, terminal widgets, native controls — starts with [declaring the format](/guidance/host-formats/), which is what tells the runtime which nodes are legal and which prop values are dangerous.

## The seam

There is one public entry point: the runtime factory. A host never reaches into the runtime's internals; it drives the runtime and renders what comes back.

1. **Initialize the factory.** `const xript = await initXript()` (or `initXriptAsync()` for the async sandbox). This is the only import a host needs from `@xriptjs/runtime`.
2. **Create a runtime per app manifest.** `xript.createRuntime(manifest, { hostBindings, capabilities, console, onFragmentDiagnostic })`. The runtime is the unit of hosting — it owns sanitization, the format vocabulary, binding resolution, conditional visibility, hooks, capability enforcement, and the sandbox.
3. **Load mods into it.** `runtime.loadMod(modManifest, { fragmentSources })` returns a `ModInstance` describing the fragments, data fills, and exports the mod contributed. A fill whose `format` names no vocabulary the host declares fails here, loudly.
4. **Render inert output.** Push host data in with `modInstance.updateBindings({ ... })`, which returns one `FragmentUpdateResult` per fragment; fire lifecycle and update points with `runtime.fireFragmentHook(fragmentId, lifecycle, bindings)`, which returns a `FragmentOp[]` command buffer. The host applies that content, visibility, and op buffer to its UI, and nothing more.
5. **Route interaction back in.** When a rendered node fires an event, the host hands the matching handler *declaration* (`{ selector, target, on, handler }`) to a dispatch callback that calls `runtime.invokeExport(handler, args)`. The author's code runs in the sandbox, never in the page.

## What comes back

`updateBindings` and `getContent` return the same record, and it carries **both** projections of the fragment:

```ts
{
	contract: "xript-tree/1";            // refuse to render a contract you do not recognize
	fragmentId: string;
	format: string;
	contentType: "html" | "tree";
	html: string;                        // the bound HTML serialization; "" when contentType is "tree"
	tree: FragmentNode[];                // always present, for every format
	conditions: FragmentCondition[];     // every data-if, keyed by tree position
	visibility: Record<string, boolean>; // deprecated, keyed by expression text; collides
	diagnostics: FragmentDiagnostic[];
}
```

`contentType` says which projection is meaningful. An HTML host keeps reading `.html` and mounting it, byte for byte as before. A component host reads `.tree` and walks it:

```ts
type FragmentNode = { kind: "text"; value: string } | {
	kind: "element";
	name: string;                        // case preserved, exactly as the vocabulary declares it
	props: Record<string, PropValue>;    // typed: numbers, booleans, arrays, objects survive
	children: FragmentNode[];
};
```

`conditions` is every resolved `data-if`, one entry per node:

```ts
type FragmentCondition = {
	path: number[];                      // child-index path into the bound tree, e.g. [0, 2, 1]
	expression: string;
	visible: boolean;
};
```

The tree is **never pruned** — the host decides what "hidden" means for its renderer, because a fragment cannot know whether hiding is a CSS class, an unmount, or a zero-height constraint. Address the node to hide by `path`.

`visibility` is the deprecated predecessor, still populated. It is keyed by the `data-if` expression *text*, so two nodes carrying the same condition collapse into one entry, last write wins, and nothing maps an entry back to the node it came from. Read `conditions`.

`diagnostics` is everything the sanitizer dropped, cleaned, or refused. Surface them; a silent drop is the failure mode this contract exists to end. Op-time findings arrive separately, through the `onFragmentDiagnostic` runtime option.

## End to end, minimally

A host manifest declaring one fragment slot, a mod filling it with an inert template, and the host loop that renders it.

**Host manifest** (the slot is the contract):

```json
{
	"xript": "0.8",
	"name": "minimal-host",
	"slots": [
		{ "id": "panel", "accepts": ["text/html"], "description": "A status panel." }
	]
}
```

**Mod manifest + template** (`fills` keyed by slot id; the template is inert — `data-bind` for values, `data-if` for visibility, no script):

```json
{
	"xript": "0.8",
	"name": "status-mod",
	"version": "1.0.0",
	"fills": {
		"panel": [
			{
				"format": "text/html",
				"source": "panel.html",
				"bindings": [
					{ "name": "status", "path": "app.status" },
					{ "name": "warning", "path": "app.warning" }
				],
				"handlers": [
					{ "selector": "#retry", "on": "click", "handler": "onRetry" }
				]
			}
		]
	}
}
```

```html
<div>
	<p>Status: <span data-bind="status">…</span></p>
	<p data-if="warning">Check the logs.</p>
	<button id="retry">Retry</button>
</div>
```

**The host loop** — create, load, push data, apply what comes back:

```js
import { initXript } from "@xriptjs/runtime";
import { readFile } from "node:fs/promises";

const xript = await initXript();
const runtime = xript.createRuntime(hostManifest, {
	hostBindings: {},
	onFragmentDiagnostic: (d) => console.warn(`[${d.fragmentId}] ${d.code}: ${d.message}`),
});

const mod = runtime.loadMod(modManifest, {
	fragmentSources: { "panel.html": await readFile("panel.html", "utf-8") },
});

for (const result of mod.updateBindings({ app: { status: "online", warning: false } })) {
	for (const d of result.diagnostics) console.warn(`[${result.fragmentId}] ${d.code}: ${d.message}`);
	mount(result); // your render fn — apply, don't interpret
}

for (const fragment of mod.fragments) {
	for (const handler of fragment.getHandlers()) {
		bind(fragment.id, handler, (...args) => runtime.invokeExport(handler.handler, args));
	}
}

const ops = runtime.fireFragmentHook("panel-fill-0", "update", { status: "degraded" });
applyOps(ops); // walk the FragmentOp[] command buffer in order

runtime.dispose();
```

`mount` and `applyOps` are host-owned and apply data without executing any of it. `mount` branches once, on `contentType`:

```js
function mount(result) {
	if (result.contentType === "html") root.innerHTML = result.html;
	else root.replaceChildren(renderTree(result.tree)); // your renderer, walking name/props/children
	for (const { path, visible } of result.conditions) applyVisibility(path, visible);
}
```

`conditions` is keyed by **tree position** — each entry carries the child-index `path` into the bound tree, the `expression` it came from, and whether it is `visible`. Address the node by that path.

`result.visibility` is the deprecated predecessor and is still populated. Do not reach for it: it is keyed by the `data-if` expression *text*, so two nodes carrying the same condition collapse into one entry, last write wins, and there is no way to map an entry back to the node it belongs to. A page with two `data-if="warning"` nodes is enough to hit it.

The fill's `bindings` map each `data-bind`/`data-if` name to a path in the data you push (`status` ← `app.status`). The runtime resolved them into an inert tree, its HTML serialization, a per-node condition list, and ops. (An id-less fill gets a synthesized id, `<slot>-fill-<index>`; declare an explicit `id` on the fill when you'd rather name it.)

## The command buffer

`fireFragmentHook` returns an ordered `FragmentOp[]`. Every op carries a raw `selector` string and a parsed `target`; apply them in order and do not interpret them further.

| Op | Fields | Apply it as |
|----|--------|-------------|
| `toggle` | `value: boolean` | show or hide the target |
| `setText` | `value: string` | **text content, never markup** |
| `setProp` | `prop: string`, `value: PropValue` | set that prop on the target; the value keeps its type |
| `replaceChildren` | `value: string \| FragmentNode[]` | replace the target's children with the given content |
| `setAttr` | `attr`, `prop`, `value` | **deprecated** alias of `setProp`; read `prop` |
| `addClass` / `removeClass` | `value: string` | HTML-vocabulary sugar for a class-list change; dropped with an `unsupported-op` diagnostic on a tree format |

A single unknown op must not take a render down — keep a tolerant `default` branch and ignore what you do not recognize.

### Targeting

There is **one** targeting model, and it works in every vocabulary:

> A target string is an **ID reference** if it matches `^#[A-Za-z][A-Za-z0-9_.:-]*$`. It resolves to the node whose `id` prop equals that name, in any vocabulary. Any other string is a **CSS selector**, meaningful only for HTML vocabularies.

`op.selector` is the raw string; `op.target` is that string parsed into `{ by: "id", id }` or `{ by: "selector", selector }`. An HTML host that resolves `op.selector` with `querySelectorAll` keeps working unchanged — `#retry` is simultaneously a valid CSS ID selector. A component host reads `op.target` and matches on `id`. A CSS-selector target against a tree format is dropped with an `unsupported-target` diagnostic rather than guessed at.

The same grammar governs a fill's `handlers[].selector`, so a component fragment is mutated and wired by one reference model.

### Op values are sanitized

They were not, before v0.8, in any runtime — a mod could hand a host raw markup through `replaceChildren` or an `onclick` through `setAttr`, and the reference host injected it. Every op value now goes through the same [sink model](/guidance/host-formats/) the fragment's own source does: `href` and `src` values through the URI sanitizer, `style` through the style sanitizer, a `replaceChildren` string through the HTML sanitizer, a `replaceChildren` node list through the vocabulary. An `on*` prop is dropped outright.

This does not license a host to relax. `setText` is text, always. Apply the ops; do not reinterpret them.

## The two directions

- **In (host → fragment):** `updateBindings` resolves `data-bind` values and `data-if` visibility; `fireFragmentHook` returns command-buffer ops. Both hand back inert data for the host to apply.
- **Out (fragment → host):** the renderer knows only a handler *name*. The host decides that name maps to a sandbox export and calls `invokeExport`. No authored logic executes in the page; that is the inert-fragment guarantee, enforced at the boundary.

## What you get is inert by contract

The runtime hands the host four things, all data: a resolved `{ contentType, html, tree, visibility }` record, a `FragmentOp[]` command buffer, handler *declarations*, and `diagnostics`. The host mounts the content, toggles visibility, runs the ops in order, wires each declared handler to its dispatch callback, and reports the diagnostics. It honors the fill's [styling mode](/spec/fragments/#styling) (`inherit` / `isolated` / `scoped`) when it mounts. It does not branch on, compute from, or execute fragment content; that all already happened inside the sandbox.

## Do not reach past the boundary

The runtime's fragment processor and its helpers (`processFragment`, `processTree`, `createFragmentInstance`, `resolveBindings`) are **internal and deliberately not exported.** The sealed export surface is the design, not a gap. If you find yourself wanting to import the processor, or asking for it to be exported, you are trying to host the *processor* when the unit of hosting is the *runtime*. Load the mod and render `fireFragmentHook`'s ops instead; that is the supported seam, and it is the only one that keeps sanitization and the sandbox guarantee intact.

The reference host glue lives at `examples/svelte-fragment-renderer/`: `src/host/` drives the runtime, `src/lib/applyFragment.js` applies the inert output, and `src/host/dispatch.js` is the out-seam. Mirror it.

## Common mistakes

- **Vendoring a copy of the fragment processor into the host.** A copy is the host *reimplementing* the runtime, not hosting it. It drifts from the real sanitizer, vocabulary, binding, and visibility semantics, and it loses the sandbox guarantee entirely. Load the runtime; render its output.
- **Importing, or lobbying to export, an internal like `processFragment`.** The entry point is the runtime factory. The fragment seam is `fireFragmentHook` → `FragmentOp[]`. There is nothing else to import.
- **Mounting raw fragment source without applying the runtime's ops and visibility.** Raw markup is unresolved: you lose `data-bind` values, `data-if` toggles, and every command-buffer mutation. Apply the inert output the runtime returns.
- **Reading `.html` on a tree format.** It is `""` there, on purpose. Branch on `contentType`; a host that ignores it renders nothing and blames the mod.
- **Applying `setText` as markup, or spreading an unknown prop onto a DOM element.** The sink model is a contract about where values land; a host that lands them somewhere else has voided it.
- **Discarding diagnostics.** A dropped node nobody reported is the bug the vocabulary model was built to retire. Do not reintroduce it in the host.
- **Executing fragment markup or its handlers in the page.** The renderer only ever knows a handler *name*; the host maps it to `invokeExport`. Fragment content carries no logic of its own and must never run in the host context.
