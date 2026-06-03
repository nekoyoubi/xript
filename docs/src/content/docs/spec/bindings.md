---
title: Binding Conventions
description: "Runtime conventions for xript bindings: error handling, versioning, and TypeScript type mapping."
---

Bindings are the bridge between the host application and extender scripts. The [manifest schema](/spec/manifest) defines how bindings are declared. This document covers the runtime conventions that govern binding behavior: error handling, versioning, and the mapping from manifest declarations to generated TypeScript types.

## Error Handling

### Host-Side Errors

When a binding function throws an error inside the host application, the runtime must:

1. **Catch the error** before it propagates to the script
2. **Wrap it** in a `BindingError` with:
   - The original error message
   - The binding name (e.g., `"player.setHealth"`)
   - No stack trace from the host (this would leak implementation details)
3. **Throw the `BindingError`** into the script context so the extender can catch and handle it

Example from the extender's perspective:

```javascript
try {
  player.setHealth(-1);
} catch (e) {
  // e.name === "BindingError"
  // e.message === "player.setHealth: health value must be non-negative"
  // e.binding === "player.setHealth"
  log(e.message);
}
```

### Script-Side Error Handling

Extenders can wrap binding calls in try/catch. Uncaught errors from bindings terminate the script with the error message logged to the host's mod console.

### Error Types

The runtime provides these error types to scripts:

| Error | When Thrown |
|-------|------------|
| `BindingError` | A binding function failed during execution |
| `CapabilityDeniedError` | A gated function was called without the required capability |
| `TypeError` | Arguments don't match the binding's declared parameter types |
| `ImportDeniedError` | A module-format mod entry attempted to `import` any specifier (rejected at link time; carries `.specifier`) |
| `CommonJSDetectedError` | A mod entry contained `require()`, `module.exports`, or `exports.x` artifacts (rejected at load time; carries `.artifact`) |

Runtimes may add additional error types, but these must be present. `ImportDeniedError` and `CommonJSDetectedError` are load-time errors raised by the mod loader when a [module-format mod](/spec/modules) breaks the no-external-imports / no-CommonJS guarantee.

### Type Validation

Runtimes should validate argument types before invoking the host binding. If a binding declares `params: [{ "name": "value", "type": "number" }]` and the extender passes a string, the runtime should throw a `TypeError` without calling the host function. This prevents unexpected values from reaching the host and provides clear feedback to the extender.

Type validation is recommended but not strictly required. Some runtimes may defer to the host's own type checking for performance reasons.

## Versioning

### API Versioning Through the Manifest

The manifest's `version` field tracks the scripting API version using semver:

- **Patch** (1.0.x): Bug fixes in binding behavior. No signature changes.
- **Minor** (1.x.0): New bindings added. Existing bindings unchanged.
- **Major** (x.0.0): Breaking changes to existing binding signatures or behavior.

### Deprecation

Bindings can be marked deprecated in the manifest:

```json
{
  "getHP": {
    "description": "Returns the player's health.",
    "returns": "number",
    "deprecated": "Use player.getHealth() instead."
  }
}
```

Runtimes should:
- Log a deprecation warning the first time a deprecated binding is called
- Continue to execute the binding normally (deprecation is not removal)
- Include the migration message in the warning

### Backward Compatibility

When a manifest's major version increments, scripts written for the previous major version may break. Host applications should document breaking changes and consider supporting a compatibility mode during the transition.

The `xript` spec version (e.g., `"0.1"`) is separate from the manifest API version. A new spec version does not require a new API version: they track different things.

## Manifest-to-TypeScript Mapping

The typegen tool generates TypeScript definitions from the manifest. These are the mapping rules:

### Primitive Types

| Manifest Type | TypeScript Type |
|---------------|----------------|
| `"string"` | `string` |
| `"number"` | `number` |
| `"boolean"` | `boolean` |
| `"void"` | `void` |
| `"null"` | `null` |

### Complex Types

| Manifest Expression | TypeScript Type |
|--------------------|----------------|
| `"string[]"` | `string[]` |
| `{ "array": "Position" }` | `Position[]` |
| `{ "union": ["string", "number"] }` | `string \| number` |
| `{ "map": "number" }` | `Record<string, number>` |
| `{ "optional": "string" }` | `string \| undefined` |

### Custom Types

Object types become interfaces:

```json
{
  "Position": {
    "description": "A 2D position.",
    "fields": {
      "x": { "type": "number", "description": "Horizontal position." },
      "y": { "type": "number", "description": "Vertical position." }
    }
  }
}
```

Generates:

```typescript
/** A 2D position. */
interface Position {
  /** Horizontal position. */
  x: number;
  /** Vertical position. */
  y: number;
}
```

Enum types become string literal unions:

```json
{
  "Direction": {
    "description": "A cardinal direction.",
    "values": ["north", "south", "east", "west"]
  }
}
```

Generates:

```typescript
/** A cardinal direction. */
type Direction = "north" | "south" | "east" | "west";
```

### Open Enums

An enum type's `values` (or a field's inline `enum`) can set `"open": true` to mean "these known values, plus any other string." typegen appends `| (string & {})` so the known values still autocomplete while any string type-checks:

```json
{
  "LogLevel": {
    "description": "A log severity.",
    "values": ["debug", "info", "warn", "error"],
    "open": true
  }
}
```

Generates:

```typescript
/** A log severity. */
type LogLevel = "debug" | "info" | "warn" | "error" | (string & {});
```

docgen marks an `open` type as extensible in the generated documentation.

### Field Defaults and Inline Enums

Object-type fields carry optional `default` and inline `enum` metadata. Both are codegen and documentation hints; no runtime reads them, applies defaults, or enforces enum membership.

| Field shape | TypeScript |
|-------------|-----------|
| `{ "type": "string", "optional": true }` | `string \| undefined` (`prop?: string`) |
| `{ "type": "string", "default": "x" }` | `string` (non-optional — a `default` implies a value is always present) |
| `{ "type": "string", "enum": ["posix", "hybrid", "native"] }` | `"posix" \| "hybrid" \| "native"` |
| `{ "type": "string", "enum": ["posix", "hybrid"], "open": true }` | `"posix" \| "hybrid" \| (string & {})` |
| `{ "type": "PathStyle" }` (named `values` enum) | `"posix" \| "hybrid" \| "native"` (identical to inline enum) |

A `default`-present field is non-optional in the emitted interface; an `optional: true` field with no default is `T | undefined`. The inline `enum` form and a referenced named-enum type definition generate identical literal unions.

### Record Accessors

For an object type used as an addon-owned record shape, typegen emits a companion `<TypeName>Accessor` interface alongside the plain interface, with typed `get`/`set` per field (applying the same default-implies-required and enum-implies-union rules). The accessor is pure typing. xript backs no store, so a host that persists records with its own backend gets typed access without xript ever seeing that store.

### Function Bindings

Function bindings generate typed function declarations with JSDoc:

```json
{
  "setHealth": {
    "description": "Sets the player's health.",
    "params": [
      { "name": "value", "type": "number", "description": "The new health value." }
    ],
    "capability": "modify-player"
  }
}
```

Generates:

```typescript
/**
 * Sets the player's health.
 * @remarks Requires capability: `modify-player`
 * @param value - The new health value.
 */
declare function setHealth(value: number): void;
```

### Namespace Bindings

Namespace bindings generate typed namespace declarations:

```typescript
/** Player functions. */
declare namespace player {
  /** Returns the player's health. */
  function getHealth(): number;

  /**
   * Sets the player's health.
   * @remarks Requires capability: `modify-player`
   */
  function setHealth(value: number): void;
}
```

### Nested Namespaces

Namespaces may nest to arbitrary depth via `members` — a namespace member whose value is itself a namespace:

```jsonc
{
  "bindings": {
    "app": {
      "description": "Host root namespace.",
      "members": {
        "widget": {
          "description": "Widget operations.",
          "members": {
            "list": { "description": "Lists widgets." }
          }
        }
      }
    }
  }
}
```

This exposes `app.widget.list()` to scripts. Capability gating lives on **leaf functions only**; intermediate namespace nodes carry no capability and are plain frozen objects, with the runtime deep-freezing the namespace from its root. The nested `members` form is canonical. The dotted-key form (`"app.widget"` as a top-level binding key) is not used.

### Async Bindings

Bindings with `"async": true` wrap their return type in `Promise`:

```typescript
/** Reads a value from storage. */
declare function get(key: string): Promise<string | undefined>;
```

### Optional Parameters

Parameters with a `default` value or `"required": false` become optional:

```typescript
declare function greet(name: string, excited?: boolean): string;
```

## Naming Conventions

### Function Names

Binding function names should follow JavaScript conventions:
- camelCase (`getHealth`, `setPlayerName`)
- Verb-first for actions (`addItem`, `removeEnemy`, `setHealth`)
- Adjective or noun for getters (`isAlive`, `currentLevel`, `getHealth`)

### Namespace Names

Namespace names should be lowercase nouns or noun phrases:
- `player`, `world`, `inventory`, `data`
- Not verbs (`modify`, `handle`, `process`)
- Not plurals unless they represent collections (`enemies` for a collection manager, but `enemy` for operations on a single enemy)
