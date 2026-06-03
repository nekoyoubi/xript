---
title: Adoption Tiers
description: "xript's four-tier incremental adoption model, from safe eval replacement to full-featured modding with UI."
---

No application has to go all-in on xript. The four adoption tiers let you start simple and add complexity only when you need it. Each tier stands on its own as a valid integration point.

## The Four Tiers

| | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| **Name** | Expressions Only | Simple Bindings | Advanced Scripting | Full Feature |
| **Bindings** | None or flat functions | Flat functions + namespaces | Rich namespaces | Rich namespaces |
| **Capabilities** | None | Optional | Required | Required |
| **Custom types** | None | Optional | Yes | Yes |
| **Execution limits** | Optional | Optional | Yes | Yes |
| **Inline examples** | No | No | Yes | Yes |
| **Async bindings** | No | Optional | Yes | Yes |
| **Slots** | No | No | No | Yes |
| **Mod manifests** | No | No | No | Yes |
| **Fills (fragments, roles, hook handlers)** | No | No | No | Yes |
| **Example** | [Expression Evaluator](/examples/expression-evaluator) | [Plugin System](/examples/plugin-system) | [Game Mod System](/examples/game-mod-system) | [UI Dashboard](/examples/ui-dashboard) |

## Tier 1: Expressions Only

**The safe eval replacement.** Your application needs to evaluate user-provided expressions: formula fields, template logic, calculated columns. You want a sandbox that guarantees safety.

The manifest is minimal:

```json
{
  "xript": "0.1",
  "name": "calculator"
}
```

No bindings, no capabilities, no types. Users get the JavaScript language itself inside a sandbox. They can write `2 + 2`, `[1,2,3].map(x => x * 2)`, or any pure expression. They cannot access `process`, `eval`, `fetch`, or anything outside standard JavaScript.

You can optionally expose flat helper functions (like `abs`, `round`, `upper`) to make expressions more useful. These are declared as bindings with no capability gates, so every function is always available.

**Choose tier 1 when:**
- You want a drop-in replacement for `eval()` that is actually safe
- All exposed functions are read-only with no side effects
- You do not need to gate any functionality behind permissions
- You want the smallest possible integration surface

**See it in action:** [Expression Evaluator example](/examples/expression-evaluator)

## Tier 2: Simple Bindings

**The plugin system.** Your application exposes a handful of functions organized into namespaces. Some operations are sensitive and need permission gating.

The manifest adds bindings, capabilities, and custom types:

```json
{
  "xript": "0.1",
  "name": "task-manager",
  "version": "1.0.0",
  "bindings": {
    "tasks": {
      "description": "Read and manage tasks.",
      "members": {
        "list":   { "description": "Returns all tasks.", "returns": { "array": "Task" } },
        "add":    { "description": "Creates a new task.", "params": [...], "capability": "manage-tasks" },
        "remove": { "description": "Removes a task.", "params": [...], "capability": "admin" }
      }
    }
  },
  "capabilities": {
    "manage-tasks": { "description": "Create and complete tasks.", "risk": "medium" },
    "admin": { "description": "Delete tasks and admin operations.", "risk": "high" }
  },
  "types": {
    "Task": { "description": "A task.", "fields": { "id": { "type": "string" }, ... } }
  }
}
```

Namespaces group related functions (`tasks.list()`, `tasks.add()`). Capabilities create a permission hierarchy: read-only operations are always available, writes require `manage-tasks`, destructive operations require `admin`. Custom types document the data structures extenders will work with.

**Choose tier 2 when:**
- You need to organize bindings into logical groups
- Some operations are destructive or sensitive and need permission gating
- You want to document data structures for script authors
- Different scripts need different permission levels

**See it in action:** [Plugin System example](/examples/plugin-system)

## Tier 3: Advanced Scripting

**The complete scripting system.** Your application exposes a rich API with multiple namespaces, fine-grained capabilities, complex types, inline code examples, async operations, and execution limits.

A tier 3 manifest uses the full scripting surface of the spec:

- **Multiple namespaces** organized by domain (`player`, `world`, `data`)
- **Capability tiers** from low-risk (`storage`) through medium (`modify-player`) to high (`modify-world`)
- **Object and enum types** that describe the full data model (`Position`, `Item`, `Enemy`, `ItemType`)
- **Async bindings** for I/O-bound operations (`world.getEnemies()`, `data.get()`)
- **Inline examples** showing extenders how to use each binding
- **Execution limits** tuned for the application's performance requirements

The manifest becomes the complete contract between your application and its scripting community. From it, the toolchain generates TypeScript definitions, API documentation, and validation rules.

**Choose tier 3 when:**
- You are building a scripting system or extensibility platform
- Your API surface is large enough to need careful organization
- You want generated docs and types that are always in sync with the API
- Extenders will write multi-line scripts, not just expressions
- You need async operations (database access, network calls, file I/O)

**See it in action:** [Game Mod System example](/examples/game-mod-system)

## Tier 4: Full Feature

**The modding platform.** Mods stop being invisible background logic and start having a visual presence in your application. Authors declare typed **slots**, named plug-points in their host, and mods **fill** them. A slot's `accepts` type governs what a valid fill looks like and what the host does with it: mount a fragment, call a renderer, resolve a provider role, or fire an event handler. Everything a mod contributes is a fill.

A tier 4 manifest builds on everything in tier 3 and adds `slots`:

```json
{
  "slots": [
    {
      "id": "sidebar.left",
      "accepts": ["text/html"],
      "capability": "ui-mount",
      "multiple": true,
      "style": "isolated"
    },
    {
      "id": "header.status",
      "accepts": ["text/html"],
      "style": "inherit"
    }
  ]
}
```

Mods declare themselves in a [mod manifest](/spec/mod-manifest/) and contribute through a single `fills` object, keyed by the host slot id. A fragment-format slot takes a fragment fill:

```json
{
  "xript": "0.6",
  "name": "health-panel",
  "version": "1.0.0",
  "capabilities": ["ui-mount"],
  "fills": {
    "sidebar.left": [
      {
        "format": "text/html",
        "source": "fragments/panel.html",
        "bindings": [{ "name": "health", "path": "player.health.val" }],
        "handlers": [{ "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }]
      }
    ]
  }
}
```

`fills` is the canonical contribution surface. A UI fragment, a provider role, and a lifecycle hook handler are not separate top-level concepts; each is a fill of a slot of a particular type. The value under each slot id is always an array, so a `multiple: true` slot can take more than one fill. (The earlier top-level `fragments[]` array and `contributions.provides` still validate but emit a deprecation warning; fold them into `fills`.)

Fragment markup uses `data-bind` for value binding and `data-if` for conditional visibility. DOM event handlers go in the `handlers` array (entries shaped `{ selector, on, handler }`; the old `events` key is a deprecated alias). The sandbox fragment API gives mods programmatic control through a command buffer: `toggle`, `addClass`, `setText`, `replaceChildren`, and more. Every fragment is sanitized before it reaches the host.

Scaffold a new mod project with `xript init --mod` to get a working template with a mod manifest, fragment HTML, and entry script.

**Choose tier 4 when:**
- You want mods to contribute visible UI, not just background logic
- Your application has natural extension points in its interface (sidebars, panels, overlays, status bars)
- You want mods to react to state changes and render live data
- You are building a platform where the community shapes the user experience

**See it in action:** [UI Dashboard example](/examples/ui-dashboard)

## Progressing Between Tiers

The tiers are not walls; they are waypoints. Moving from one tier to the next is additive:

**Tier 1 → Tier 2:** Add a `bindings` section with namespaces. Add `capabilities` for anything sensitive. Optionally add `types` to document your data structures. Your existing flat bindings (if any) continue to work unchanged.

**Tier 2 → Tier 3:** Add `examples` to bindings so extenders can see usage patterns. Add `async: true` to bindings that need it. Add `limits` tuned for your use case. Expand your type definitions to cover the full data model. The structure you already built in tier 2 is the foundation.

**Tier 3 → Tier 4:** Add `slots` to your app manifest to define where mods can plug in. Each slot declares an `accepts` type and an optional `payload` JSON Schema describing a valid fill. Mods create their own [mod manifests](/spec/mod-manifest/) and contribute through `fills` keyed by your slot ids. The runtime handles sanitization, data binding, and event routing. Your existing scripting API becomes the data layer that fragments bind to.

Nothing breaks when you add complexity. A tier 1 manifest is a valid tier 4 manifest: it just uses fewer features.

## The Manifest Drives Everything

Regardless of tier, the manifest is the single source of truth. The toolchain reads it and generates:

- **TypeScript definitions** via `xript typegen`: editor autocomplete and type checking for extenders
- **API documentation** via `xript docgen`: always in sync, always accurate
- **Validation** via `xript validate`: catch manifest errors before runtime
- **Moddability scoring** via `xript score`: rate how much extension surface your host exposes, with `xript score-diff` to track the delta against a baseline
- **Lint findings** via `xript lint`: the actionable list behind the score; dead slots, undeclared capabilities, legacy-shape mods
- **A plain-English summary** via `xript describe`: what bindings, hooks, slots, and capabilities a host manifest exposes

The same toolchain runs as a Model Context Protocol server via `xript mcp`, exposing every command one-to-one (`xript_validate`, `xript_typegen`, `xript_score`, and the rest) so an agent can read and reason about your manifest over stdio.

A tier 1 manifest generates simpler output. A tier 4 manifest generates richer output. But the workflow is the same at every level: declare your API in JSON, and let the tools do the rest.
