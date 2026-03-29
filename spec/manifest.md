# xript Manifest Specification

The xript manifest is the single source of truth for an application's scripting API. It declares what functionality is exposed to scripts, how it is organized, what capabilities gate access, and what types are involved. From the manifest, everything else is derived: documentation, TypeScript definitions, and validation. Interactive playgrounds are also supported as a toolchain output.

This document explains the structure of the manifest, the rationale behind key decisions, and how the manifest supports xript's four adoption tiers.

## Overview

A manifest is a JSON file conforming to the [manifest JSON Schema](./manifest.schema.json). At minimum, a manifest declares a spec version and a name:

```json
{
  "xript": "0.1",
  "name": "my-app"
}
```

From there, complexity is layered on only as needed. The schema is designed so that every field beyond `xript` and `name` is optional, and each additional section enables more functionality.

## Top-Level Fields

### `xript` (required)

The specification version this manifest conforms to. This is not the application's version — it's the version of the xript spec the manifest was written against. Runtimes use this to determine which features and validation rules apply.

Format: `major.minor` (e.g., `"0.1"`). Patch versions are intentionally excluded — the spec level doesn't change for non-breaking fixes.

### `name` (required)

A machine-readable identifier for the application. Used in generated package names (`@xriptjs/<name>-types`), documentation URLs, and tooling output.

Constraints: lowercase letters, numbers, and hyphens. Must start with a letter. Maximum 64 characters. This mirrors npm package naming conventions because the generated types will live in that ecosystem.

### `version`

The version of the application's scripting API, following semver. This is distinct from `xript` — it tracks how the application's exposed bindings evolve over time.

When a binding is added, the minor version increments. When a binding's signature changes in a breaking way, the major version increments. This versioning drives compatibility checks and generated type package versioning.

### `title`

A human-readable display name. While `name` is `"skyrim-modkit"`, `title` might be `"Skyrim Mod Toolkit"`. Used in documentation headers and UI.

### `description`

A brief description aimed at modders. Tells them what the application does and what they can extend. Used in documentation landing pages and registry listings.

## Bindings

Bindings are the core of the manifest. They define the functions and namespaces that scripts can call.

### Function Bindings

A function binding declares a callable function:

```json
{
  "bindings": {
    "getHealth": {
      "description": "Returns the player's current health points.",
      "returns": "number"
    }
  }
}
```

Every function binding requires a `description`. This is not optional because if a modder can't understand what a function does, it may as well not exist. The description appears in generated docs, TypeScript JSDoc comments, and editor tooltips.

Optional fields on function bindings:

- **`params`** — an ordered array of parameters, each with a `name`, `type`, and optional `description` and `default`
- **`returns`** — the return type (omit for void functions)
- **`async`** — whether the function returns a promise (defaults to `false`)
- **`capability`** — the capability required to call this function
- **`examples`** — usage examples for documentation
- **`deprecated`** — marks the function as deprecated with a migration message

### Namespace Bindings

Namespaces group related functions. They create the `namespace.function()` calling convention:

```json
{
  "bindings": {
    "player": {
      "description": "Functions related to the player character.",
      "members": {
        "getHealth": {
          "description": "Returns the player's current health points.",
          "returns": "number"
        },
        "setHealth": {
          "description": "Sets the player's health points.",
          "params": [
            { "name": "value", "type": "number", "description": "The new health value." }
          ]
        }
      }
    }
  }
}
```

Namespaces can nest arbitrarily (`game.world.weather.setRain()`), but deep nesting is discouraged — two levels is usually plenty.

A binding is distinguished as a namespace by the presence of `members`. A binding with both `members` and `params` is invalid.

### Why Bindings Are a Flat Object, Not Nested by Default

Bindings are declared as a flat key-value map at the top level (`"getHealth": {...}`) rather than being implicitly grouped. Namespaces exist as an explicit opt-in via `members`. This keeps the simple case simple (one function = one key) while allowing organization when needed.

## Capabilities

Capabilities implement the default-deny security model. Every capability is a named permission that must be explicitly granted before scripts can use the functionality it protects.

```json
{
  "capabilities": {
    "filesystem": {
      "description": "Read and write files in the mod's data directory.",
      "risk": "medium"
    },
    "network": {
      "description": "Make HTTP requests to allowed domains.",
      "risk": "high"
    }
  }
}
```

Capabilities are referenced by name in function bindings via the `capability` field. A function with `"capability": "filesystem"` is only callable if the script has been granted the `filesystem` capability.

The `risk` field is advisory — it helps users make informed decisions about what to grant. It does not affect runtime behavior. Runtimes may use it to display warnings or require additional confirmation for `high` risk capabilities.

Functions without a `capability` field are always available to any script. This is intentional: the common case is that most bindings are safe read-only operations that don't need gating.

## Types

Custom types let the manifest describe complex data structures used in bindings.

### Object Types

```json
{
  "types": {
    "Position": {
      "description": "A 2D position in world coordinates.",
      "fields": {
        "x": { "type": "number", "description": "Horizontal position." },
        "y": { "type": "number", "description": "Vertical position." }
      }
    }
  }
}
```

### Enum Types

```json
{
  "types": {
    "Direction": {
      "description": "A cardinal direction.",
      "values": ["north", "south", "east", "west"]
    }
  }
}
```

### Type References

Anywhere a type is expected, you can use:

- **Primitives**: `"string"`, `"number"`, `"boolean"`, `"void"`, `"null"`
- **Custom types**: `"Position"`, `"Direction"` (references to the `types` section)
- **Array shorthand**: `"string[]"`, `"Position[]"`
- **Complex expressions**: `{ "array": "Position" }`, `{ "union": ["string", "number"] }`, `{ "map": "number" }`, `{ "optional": "string" }`

The shorthand `"string[]"` is equivalent to `{ "array": "string" }`. Both are valid. The shorthand exists because array types are common and the verbose form is noisy for simple cases.

## Hooks

Hooks are the reverse of bindings. While bindings let scripts call the host, hooks let the host call scripts. They enable the event-driven programming model that real modding requires: "when the player takes damage," "before the game saves," "after a level loads."

### Simple Hooks

A hook without lifecycle phases is a simple notification:

```json
{
  "hooks": {
    "playerDamage": {
      "description": "Fired when the player takes damage.",
      "params": [
        { "name": "amount", "type": "number", "description": "Damage amount." },
        { "name": "source", "type": "string", "description": "What caused the damage." }
      ]
    }
  }
}
```

Scripts register handlers: `hooks.playerDamage((amount, source) => { ... })`. The host fires the hook via `runtime.fireHook("playerDamage", { amount: 25, source: "trap" })`.

### Phased Hooks

Hooks can declare lifecycle phases for structured interception:

```json
{
  "hooks": {
    "save": {
      "description": "Fired during the save lifecycle.",
      "phases": ["pre", "post", "done", "error"],
      "capability": "persistence",
      "params": [
        { "name": "data", "type": "SaveData" }
      ]
    }
  }
}
```

Scripts register per-phase: `hooks.save.pre((data) => { ... })`. Multiple handlers per phase run in registration order.

The four standard phases are `pre` (before execution), `post` (after execution, can modify), `done` (after all post-processing, sealed), and `error` (after failure). Hosts declare which phases apply and control firing order.

### Hook Properties

Optional fields on hooks mirror bindings where appropriate:

- **`phases`** — lifecycle phases (`pre`, `post`, `done`, `error`). Omit for simple hooks.
- **`params`** — parameters passed to handlers when the hook fires
- **`capability`** — capability required to register for this hook
- **`async`** — whether handlers run asynchronously (host-controlled, defaults to `false`)
- **`limits`** — per-handler execution limits, overriding manifest defaults
- **`examples`** — usage examples for documentation
- **`deprecated`** — marks the hook as deprecated with a migration message

See [hooks.md](./hooks.md) for the full hook conventions, error handling, and TypeScript mapping.

## Execution Limits

The `limits` section sets default bounds for script execution:

```json
{
  "limits": {
    "timeout_ms": 5000,
    "memory_mb": 64,
    "max_stack_depth": 256
  }
}
```

These are defaults that runtimes enforce unless the host application overrides them at runtime. They exist in the manifest so that the application author can declare sensible defaults for their use case — a game mod system might allow 100ms per frame tick, while a data processing tool might allow 30 seconds.

## Adoption Tiers

The manifest supports xript's four adoption tiers through progressive complexity.

### Tier 1: Expressions Only

The simplest manifest. No bindings, no capabilities. The application uses xript purely as a safe eval replacement for user-provided expressions.

```json
{
  "xript": "0.1",
  "name": "calculator"
}
```

The runtime provides only the JavaScript language itself — no host bindings. This is useful for formula fields, template expressions, and user-defined calculations.

### Tier 2: Simple Bindings

The application exposes a few functions. No capabilities needed because everything exposed is inherently safe.

```json
{
  "xript": "0.1",
  "name": "my-game",
  "version": "1.0.0",
  "title": "My Game",
  "bindings": {
    "getPlayerName": {
      "description": "Returns the current player's display name.",
      "returns": "string"
    },
    "getHealth": {
      "description": "Returns the player's current health (0-100).",
      "returns": "number"
    },
    "log": {
      "description": "Logs a message to the mod console.",
      "params": [
        { "name": "message", "type": "string" }
      ]
    }
  }
}
```

### Tier 3: Advanced Scripting

Namespaces organize a rich API. Capabilities gate sensitive operations. Custom types describe complex data. Examples document usage.

See the [game mod system example](../examples/game-mod-system/) for a full tier 3 manifest and walkthrough.

### Tier 4: Full Feature

Slots, mod manifests, and fragments. Mods contribute UI that binds to host state and handles interaction.

See the [UI dashboard example](../examples/ui-dashboard/) for a full tier 4 integration.

## Schema Evolution

The manifest schema will evolve as xript matures. The `xript` field enables runtime compatibility:

- **0.x** versions may introduce breaking changes between minors
- **1.0** and beyond will follow semver: minors add, majors break

Runtimes should validate the `xript` field first and reject manifests with unsupported spec versions with a clear error message.
