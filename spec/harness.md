# Host Harness

A **harness** is a synthetic host: a host manifest executed with stub bindings instead of a live application. It exists so a mod, a fill, an event subscription, or a hook can be exercised end-to-end, without the host application running. Sandbox, capability gates, dispatch, the lot.

Two data shapes define it, and they are the whole contract:

- [`harness.schema.json`](harness.schema.json) — the **harness descriptor**: stub implementations for declared bindings, plus the capability grants in force.
- [`harness-steps.schema.json`](harness-steps.schema.json) — a **steps file**: an ordered scenario (load mods, invoke exports, emit events, fire hooks, read the journal).

The session itself is not an API surface. A batch runner (`xript run --harness … --steps …`) and an interactive session host (the MCP server's `xript_host_*` tools) execute the same descriptor and the same step vocabulary; one holds the runtime across calls, the other replays a file. Anything expressible interactively is expressible as a steps file, and vice versa.

## The harness descriptor

```json
{
	"capabilities": ["read:fs", "net"],
	"bindings": {
		"*": { "mode": "record" },
		"fs.read": { "returns": "stubbed file content" },
		"net.fetch": { "sequence": [{ "returns": { "status": 200 } }, { "throws": "timeout" }] },
		"clock.now": { "script": "return calls === 0 ? 1000 : 2000;" }
	}
}
```

### Binding stubs

Every binding the host manifest declares gets a stub, resolved in order:

1. an exact key match (`fs.read` — namespace members are addressed by dotted path),
2. the `*` default,
3. a recording stub (journal the call, return `undefined`).

A stub answers one of four ways:

| Shape | Behavior |
|---|---|
| `{ "mode": "record" }` (or `{}`) | journal the call, return `undefined` |
| `{ "returns": value }` | fixed value every call |
| `{ "throws": "message" }` | throw every call |
| `{ "sequence": [{ "returns": … }, { "throws": … }] }` | per-call outcomes in order; the last entry repeats once exhausted |
| `{ "script": "…function body…" }` | run the body host-side with `args` (the call's arguments) and `calls` (prior call count); return its result |

Every call is journaled regardless of shape — arguments, outcome, and order.

**Scripts are host code.** A `script` stub runs in the trusted harness process, not in the sandbox. It stands in for the host application's own binding implementation and carries the same trust. Harness descriptors are test fixtures authored by the host developer; they are never mod-supplied content.

### Capability grants

`capabilities` lists the grants in force for the session, using ordinary capability references (mode prefixes and subsumption apply, per [capabilities.md](capabilities.md)). When omitted, **every capability scope the host manifest declares is granted in full** — the frictionless default for a test rig. Capability-denial testing sets the array explicitly.

### Library sources

`libraries` supplies the module source for the host manifest's approved libraries (see [Modules — Approved Libraries](modules.md#approved-libraries)), standing in for the host's registration step:

```json
{
	"libraries": {
		"@example/doc": { "path": "./doc-lib.bundle.js" },
		"open-lib": { "source": "export function id(x){ return x; }" }
	}
}
```

The manifest's allow-list and capability gates still govern what a mod may import; a declared library with no harness source fails a mod's import exactly as it would against a host that forgot to register it.

## The steps file

```json
{
	"steps": [
		{ "action": "load-mod", "manifest": "./mod.json", "source": "./mod.js" },
		{ "action": "invoke", "export": "transform", "args": ["hello"] },
		{ "action": "emit", "event": "tick", "payload": { "count": 1 } },
		{ "action": "fire-hook", "hook": "on-save", "data": { "path": "/tmp/x" } },
		{ "action": "journal" }
	]
}
```

Steps execute in order against one session. `load-mod` may appear any number of times — multiple mods share the host, so slot fills, provider-role resolution, and event fan-out across mods are all testable. Relative `manifest` and `source` paths resolve against the steps file's own directory. A mod whose fills reference file-sourced fragments lists them under `sources`, keyed by the path the manifest names: `"sources": { "fragments/panel.html": "../fragments/panel.html" }`.

A failing step is captured as that step's result (`ok: false` plus the error) and execution continues — a scenario can assert an expected denial mid-run. Batch runners report failure overall when any step failed.

| Action | Does |
|---|---|
| `load-mod` | load a mod manifest + entry script into the session |
| `invoke` | call a mod export |
| `emit` | broadcast a host event to subscribers |
| `fire-hook` | fire a declared hook or event-typed slot |
| `execute` | evaluate script source in the sandbox |
| `resolve-slot` | resolve a slot's contributions |
| `resolve-role` | resolve a provider role |
| `journal` | read (and optionally `clear`) the journal |

## The journal

The session records, in order: every stubbed binding call (name, arguments, outcome), every capability audit event the runtime emits, and every sandbox console log. A scenario's assertion surface is the step results plus the journal — "the mod called `fs.read` once with this path, was denied `net`, and logged twice" is readable directly from the output.

## Portability

The descriptor and steps shapes are runtime-agnostic data, like the conformance corpora ([`capability-tests.json`](capability-tests.json), [`extends-tests.json`](extends-tests.json)). The reference implementation lives in `@xriptjs/cli` against the universal runtime; any runtime can implement the same shapes to harness its own hosts, and a steps file plus expected journal is the seed of a cross-runtime behavioral test.
