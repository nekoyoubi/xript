---
title: Adoption Tiers
description: xript's three-tier incremental adoption model, from safe eval replacement to full modding system.
---

xript is designed so that no application needs to go all-in. The three adoption tiers let you start simple and add complexity only when you need it. Each tier stands on its own as a valid integration point.

## The Three Tiers

| | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| **Name** | Expressions Only | Simple Bindings | Full Scripting |
| **Time to integrate** | Five minutes | An afternoon | A few days |
| **Bindings** | None or flat functions | Flat functions + namespaces | Rich namespaces |
| **Capabilities** | None | Optional | Required |
| **Custom types** | None | Optional | Yes |
| **Execution limits** | Optional | Optional | Yes |
| **Inline examples** | No | No | Yes |
| **Async bindings** | No | Optional | Yes |
| **Example** | [Expression Evaluator](/examples/expression-evaluator) | [Plugin System](/examples/plugin-system) | [Game Mod System](/examples/game-mod-system) |

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

## Tier 3: Full Scripting

**The complete modding system.** Your application exposes a rich API with multiple namespaces, fine-grained capabilities, complex types, inline code examples, async operations, and execution limits.

A tier 3 manifest uses everything the spec offers:

- **Multiple namespaces** organized by domain (`player`, `world`, `data`)
- **Capability tiers** from low-risk (`storage`) through medium (`modify-player`) to high (`modify-world`)
- **Object and enum types** that describe the full data model (`Position`, `Item`, `Enemy`, `ItemType`)
- **Async bindings** for I/O-bound operations (`world.getEnemies()`, `data.get()`)
- **Inline examples** showing extenders how to use each binding
- **Execution limits** tuned for the application's performance requirements

The manifest becomes the complete contract between your application and its modding community. From it, the toolchain generates TypeScript definitions, API documentation, and validation rules.

**Choose tier 3 when:**
- You are building a modding system or extensibility platform
- Your API surface is large enough to need careful organization
- You want generated docs and types that are always in sync with the API
- Extenders will write multi-line scripts, not just expressions
- You need async operations (database access, network calls, file I/O)

## Progressing Between Tiers

The tiers are not walls; they are waypoints. Moving from one tier to the next is additive:

**Tier 1 → Tier 2:** Add a `bindings` section with namespaces. Add `capabilities` for anything sensitive. Optionally add `types` to document your data structures. Your existing flat bindings (if any) continue to work unchanged.

**Tier 2 → Tier 3:** Add `examples` to bindings so extenders can see usage patterns. Add `async: true` to bindings that need it. Add `limits` tuned for your use case. Expand your type definitions to cover the full data model. The structure you already built in tier 2 is the foundation.

Nothing breaks when you add complexity. A tier 1 manifest is a valid tier 3 manifest: it just uses fewer features.

## The Manifest Drives Everything

Regardless of tier, the manifest is the single source of truth. The toolchain reads it and generates:

- **TypeScript definitions** via `xript typegen`: editor autocomplete and type checking for extenders
- **API documentation** via `xript docgen`: always in sync, always accurate
- **Validation** via `xript validate`: catch manifest errors before runtime

A tier 1 manifest generates simpler output. A tier 3 manifest generates richer output. But the workflow is the same at every level: declare your API in JSON, and let the tools do the rest.
