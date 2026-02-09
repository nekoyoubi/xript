---
title: Manifest Specification
description: The xript manifest format — how applications declare their scripting API.
---

The xript manifest is the single source of truth for an application's scripting API. It declares what functionality is exposed to scripts, how it is organized, what capabilities gate access, and what types are involved. From the manifest, everything else is derived: documentation, TypeScript definitions, and validation. Interactive playgrounds are planned as a future toolchain output.

## Overview

A manifest is a JSON file conforming to the [manifest JSON Schema](https://github.com/nekoyoubi/xript/blob/main/spec/manifest.schema.json). At minimum, a manifest declares a spec version and a name:

```json
{
  "xript": "0.1",
  "name": "my-app"
}
```

From there, complexity is layered on only as needed. Every field beyond `xript` and `name` is optional, and each additional section enables more functionality.

## Top-Level Fields

### `xript` (required)

The specification version this manifest conforms to. This is not the application's version — it's the version of the xript spec the manifest was written against.

Format: `major.minor` (e.g., `"0.1"`).

### `name` (required)

A machine-readable identifier for the application. Used in generated package names, documentation URLs, and tooling output.

Constraints: lowercase letters, numbers, and hyphens. Must start with a letter. Maximum 64 characters.

### `version`

The version of the application's scripting API, following semver. Tracks how the exposed bindings evolve over time.

### `title`

A human-readable display name. Used in documentation headers and UI.

### `description`

A brief description aimed at modders. Used in documentation landing pages and registry listings.

## Bindings

Bindings define the functions and namespaces that scripts can call.

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

Every function binding requires a `description`. Optional fields include `params`, `returns`, `async`, `capability`, `examples`, and `deprecated`.

### Namespace Bindings

Namespaces group related functions using the `members` field:

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

Namespaces can nest, but deep nesting is discouraged — two levels is usually plenty.

## Capabilities

Capabilities implement the default-deny security model. Every capability is a named permission that must be explicitly granted before scripts can use the functionality it protects.

```json
{
  "capabilities": {
    "filesystem": {
      "description": "Read and write files in the mod's data directory.",
      "risk": "medium"
    }
  }
}
```

Functions reference capabilities via the `capability` field. Functions without a `capability` are always available.

The `risk` field (`low`, `medium`, `high`) is advisory and helps users make informed decisions about granting capabilities.

## Types

Custom types describe complex data structures used in bindings.

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
- **Custom types**: `"Position"`, `"Direction"`
- **Array shorthand**: `"string[]"`, `"Position[]"`
- **Complex expressions**: `{ "array": "Position" }`, `{ "union": ["string", "number"] }`, `{ "map": "number" }`, `{ "optional": "string" }`

## Execution Limits

Default bounds for script execution:

```json
{
  "limits": {
    "timeout_ms": 5000,
    "memory_mb": 64,
    "max_stack_depth": 256
  }
}
```

These are defaults that runtimes enforce unless the host application overrides them.

## Adoption Tiers

The manifest supports three adoption tiers through progressive complexity.

### Tier 1: Expressions Only

```json
{
  "xript": "0.1",
  "name": "calculator"
}
```

Safe eval replacement. No bindings, no capabilities.

### Tier 2: Simple Bindings

```json
{
  "xript": "0.1",
  "name": "my-game",
  "version": "1.0.0",
  "bindings": {
    "getPlayerName": {
      "description": "Returns the current player's display name.",
      "returns": "string"
    },
    "getHealth": {
      "description": "Returns the player's current health (0-100).",
      "returns": "number"
    }
  }
}
```

A few functions, no capabilities needed.

### Tier 3: Full Scripting

Namespaces, capabilities, custom types, examples, and execution limits. See the [game mod system example](https://github.com/nekoyoubi/xript/blob/main/examples/game-mod-system.json) for a complete tier 3 manifest.

## Schema

The full JSON Schema is available at [`spec/manifest.schema.json`](https://github.com/nekoyoubi/xript/blob/main/spec/manifest.schema.json).
