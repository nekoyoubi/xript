---
title: Annotations
description: The @xript JSDoc annotation convention for declaring manifest bindings directly in TypeScript source code.
---

The `@xript` annotation convention lets you declare manifest bindings directly in TypeScript source. The `xript scan` command reads these annotations and generates the `bindings` and `capabilities` sections of your manifest, so the binding lives next to the function it describes instead of in a separate file.

## Tags

### `@xript <binding.path>`

Declares a function as an xript binding at the given dot-delimited path. Dots create namespace nesting in the manifest.

```typescript
/**
 * Get value from the data store.
 *
 * @xript data.get
 */
export function getData(path: string): DataResult { ... }
```

Produces the manifest binding `data.get` (namespace `data`, member `get`).

### `@xript-cap <capability>`

Gates this binding behind a named capability. A binding's `capability` field is a single string in the manifest schema, so the scanner writes the **first** `@xript-cap` tag it finds and warns about the rest. Every named capability still gets registered under the manifest's `capabilities` section, auto-generating any that don't yet exist; only the binding-to-capability link is limited to one.

```typescript
/**
 * Transfer currency between players.
 *
 * @xript economy.transfer
 * @xript-cap modify-state
 */
export function transferCurrency(fromId: string, toId: string, amount: number): void { ... }
```

## What the scanner extracts

All metadata comes from standard JSDoc and TypeScript. `@xript` and `@xript-cap` are the only custom tags.

| Source | Manifest field |
|--------|---------------|
| `@xript <path>` | binding path (dot-delimited namespace nesting) |
| `@xript-cap <name>` | `capability` field on the binding (single string — first tag wins) |
| JSDoc description (text before tags) | `description` |
| `@param` tags + TypeScript parameter types | `params` array |
| TypeScript return type / `@returns` | `returns` |
| `async` keyword or `Promise<>` return | `async: true` |
| `@deprecated` tag | `deprecated` |

## Namespace nesting

Dot-delimited paths produce nested namespace bindings:

```typescript
/** @xript player.inventory.add */
export function addItem(item: string): void { ... }

/** @xript player.inventory.remove */
export function removeItem(item: string): boolean { ... }

/** @xript log */
export function log(message: string): void { ... }
```

Produces:

```json
{
  "bindings": {
    "player": {
      "description": "player namespace",
      "members": {
        "inventory": {
          "description": "inventory namespace",
          "members": {
            "add": { "description": "...", "params": [...] },
            "remove": { "description": "...", "params": [...], "returns": "boolean" }
          }
        }
      }
    },
    "log": { "description": "...", "params": [...] }
  }
}
```

Auto-generated namespace descriptions use the format `"{name} namespace"` and can be overridden by editing the manifest after scanning.

## Capability auto-generation

When the scanner encounters `@xript-cap storage` but `storage` is not defined in the manifest's `capabilities` section, it auto-generates:

```json
{
  "storage": {
    "description": "storage capability",
    "risk": "low"
  }
}
```

The scanner preserves existing capability definitions and warns about gaps.

## Scanner behavior

- only processes exported functions with `@xript` JSDoc tags
- ignores functions without `@xript` tags
- reports diagnostics for duplicate binding paths, missing descriptions, and bindings that declare more than one `@xript-cap` (only the first is written to the singular `capability` field)
- in merge mode, adds new bindings, warns about removed bindings (does not auto-delete), preserves manual edits to existing bindings
- supports class methods if exported; the scanner treats them as standalone functions at the annotated path
- generates only the `bindings` and `capabilities` sections; the host's fill surface (typed `slots`, the standalone `events` catalog, and the mod-side `fills` that plug into them) is authored in the manifest directly, not derived from `@xript` annotations

## Examples

### Simple binding

```typescript
/**
 * Write a message to the application log.
 *
 * @xript log
 * @param message - The message to log
 * @param level - Log level
 */
export function log(message: string, level?: string): void { ... }
```

### Async binding with capability

```typescript
/**
 * Save data to persistent storage.
 *
 * @xript storage.save
 * @xript-cap persist
 * @param key - Storage key
 * @param value - Value to store
 */
export async function saveData(key: string, value: unknown): Promise<void> { ... }
```

### Deprecated binding

```typescript
/**
 * Get player health.
 *
 * @xript player.getHealth
 * @deprecated Use player.stats.get("health") instead
 */
export function getPlayerHealth(): number { ... }
```
