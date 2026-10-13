# xript Binding Conventions

Bindings are the bridge between the host application and modder scripts. The [manifest schema](./manifest.md) defines how bindings are declared. This document covers the runtime conventions that govern how bindings behave: error handling, versioning, and the mapping from manifest declarations to generated TypeScript types.

## Error Handling

### Host-Side Errors

When a binding function throws an error inside the host application, the runtime must:

1. **Catch the error** before it propagates to the script
2. **Wrap it** in a `BindingError` with:
   - The original error message
   - The binding name (e.g., `"player.setHealth"`)
   - No stack trace from the host (this would leak implementation details outside the sandbox)
3. **Throw the `BindingError`** into the script context so the modder can catch and handle it

Example from the modder's perspective:

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

Modders can wrap binding calls in try/catch. Uncaught errors from bindings terminate the script with the error message logged to the host's mod console.

### Error Types

The runtime provides these error types to scripts:

| Error | When Thrown |
|-------|------------|
| `BindingError` | A binding function failed during execution |
| `CapabilityDeniedError` | A gated function was called without the required capability |
| `TypeError` | Arguments don't match the binding's declared parameter types (always raised for a non-function where a function parameter is declared) |
| `ImportDeniedError` | A module-format mod entry attempted to `import` any specifier (rejected at link time; carries `.specifier`) |
| `CommonJSDetectedError` | A mod entry contained `require()`, `module.exports`, or `exports.x` artifacts (rejected at load time; carries `.artifact`) |

Runtimes may add additional error types, but these must be present. `ImportDeniedError` and `CommonJSDetectedError` are load-time errors raised by the mod loader; see [Modules](./modules.md).

### Type Validation

Runtimes should validate argument types before invoking the host binding. If a binding declares `params: [{ "name": "value", "type": "number" }]` and the modder passes a string, the runtime should throw a `TypeError` without calling the host function. This prevents unexpected values from reaching the host and provides clear feedback to the modder.

Type validation is recommended but not strictly required — some runtimes may defer to the host's own type checking for performance reasons.

One check is required: a parameter declared as a function (`"function"`, `{ "function": { ... } }`, or either wrapped in `optional`) must receive a function. Anything else is refused with a `TypeError` naming the binding and the parameter, for example `probe.find(): parameter "test" expects a function, got number`, and the host is not called. A function parameter that is not required (`"required": false`, a `default`, or an `optional` wrapper) also accepts `undefined` and `null`. The runtime never coerces: a binding that cannot tell "the mod passed a callback" from "the mod passed nothing" answers wrong without saying so, which is exactly what this check exists to prevent. See [Callbacks](#callbacks).

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

The `xript` spec version (e.g., `"0.1"`) is separate from the manifest API version. A new spec version does not require a new API version — they track different things.

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
| `"function"` | `(...args: any[]) => any` |

### Complex Types

| Manifest Expression | TypeScript Type |
|--------------------|----------------|
| `"string[]"` | `string[]` |
| `{ "array": "Position" }` | `Position[]` |
| `{ "union": ["string", "number"] }` | `string \| number` |
| `{ "map": "number" }` | `Record<string, number>` |
| `{ "optional": "string" }` | `string \| undefined` |
| `{ "function": { "params": [{ "name": "cell", "type": "number" }], "returns": "boolean" } }` | `(cell: number) => boolean` |
| `{ "optional": "function" }` | `((...args: any[]) => any) \| undefined` |

A function type is parenthesised wherever it sits inside a union, an optional, or an array, so `| undefined` never binds to its return type. A signature with no `returns` returns `void`.

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

### Field Defaults and Inline Enums

Object-type fields carry optional `default` and inline `enum` metadata. Both are codegen and documentation hints — no runtime reads them.

| Field shape | TypeScript |
|-------------|-----------|
| `{ "type": "string", "optional": true }` | `string \| undefined` (`prop?: string`) |
| `{ "type": "string", "default": "x" }` | `string` (non-optional — default implies a value is always present) |
| `{ "type": "string", "enum": ["posix", "hybrid", "native"] }` | `"posix" \| "hybrid" \| "native"` |
| `{ "type": "PathStyle" }` (named `values` enum) | `"posix" \| "hybrid" \| "native"` (identical to inline enum) |

A `default`-present field is non-optional in the emitted interface; an `optional: true` field with no default is `T | undefined`. Inline `enum` and a referenced named-enum type definition generate identical literal unions.

Alongside each object type interface, typegen emits a companion `<TypeName>Accessor` interface with typed `get`/`set` per field, applying the same default-implies-required and enum-implies-union rules. The accessor is pure typing; xript backs no store.

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

This exposes `app.widget.list()` to scripts. Capability gating lives on **leaf functions only**; intermediate namespace nodes carry no capability and are plain frozen objects. The runtime deep-freezes the namespace from its root. The nested `members` form is canonical — the dotted-key form (`"app.widget"` as a top-level binding key) is not used.

### Async Bindings

Bindings with `"async": true` wrap their return type in `Promise`:

```typescript
/** Reads a value from storage. */
declare function get(key: string): Promise<string | undefined>;
```

`async` declares the **shape** of the value a script receives, a promise rather than a settled value. It says nothing about whether the interpreter yields while the host does its work; that is a property of the runtime, and the runtimes differ:

| Runtime | What `await binding()` does | Other work on the same runtime meanwhile |
| --- | --- | --- |
| JS/WASM, `initXriptAsync` | the asyncify build suspends the QuickJS stack until the host promise settles; the host's event loop is free | none: one asyncify module suspends one call at a time, so a second call on that runtime waits |
| JS/WASM, `initXript` | async bindings are not available; a host function's return value is marshalled as-is | n/a |
| Node.js | the host promise is handed to the `vm` context unchanged; the script genuinely awaits it and the event loop is free | yes: other calls on the runtime run while it is pending |
| Rust, `RuntimeMode::Sync` (default) | the host future is driven to completion on the interpreter thread (`pollster::block_on`) and the script receives an already-settled promise; `await` never suspends | none: the interpreter thread is held for the binding's full duration |
| Rust, `RuntimeMode::Async` | the script receives a pending promise; the host future runs on the runtime's executor and settles it | yes: other calls on the runtime run while it is pending (drive them with the `*_async` methods or an `XriptHandle`) |
| C# | host functions are synchronous (`HostFunction` returns a settled `JsonElement`) and run on the Jint engine thread; `async` is declarative only | none: the engine thread is held for the call |

Execution limits differ too. In Rust's `RuntimeMode::Async`, `timeout_ms` bounds the whole call, time spent awaiting a host future included, and cancellation reaches a call parked on one. Everywhere else, limits and cancellation bound script execution only: Node's `vm` timeout covers the synchronous run, not the wait on a host promise, and a binding that blocks the engine thread is the host's to bound.

### Optional Parameters

Parameters with a `default` value or `"required": false` become optional:

```typescript
declare function greet(name: string, excited?: boolean): string;
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

## Callbacks

A binding can take a function. A pathfinder asks which cells are walkable, a filter asks which items to keep, a field-of-view routine asks what blocks sight: each needs a predicate the mod supplies. A script function passed anywhere in a binding's arguments (top level, an object field, an array element, any depth) arrives on the host as a **callback**: a callable proxy for the script function.

```javascript
const route = map.findPath(start, goal, { walkable: (cell) => !cell.lava });
```

The host calls the callback like a function. In the JavaScript and Node runtimes it is a plain function that throws `CallbackError`; in the Rust and C# runtimes, whose bindings receive JSON, a function appears in the arguments as a marker object `{ "$xriptCallback": "<token>" }` that the host resolves with `Callback::from_value` (Rust) or `XriptCallback.From` (C#) and calls with `call` / `Invoke`.

### Lifetime

A callback is **call-scoped**: it is valid only while the binding call that received it is running. Once the binding returns (or, for an async binding, once its result settles), calling it fails as expired, with a message naming the binding. Nothing retains a script function past the call, so there is no cross-call lifetime to manage and nothing for a garbage collector to get wrong. A host that wants something durable asks for data, or declares a slot a mod fills.

A callback is also bound to the thread running the call. In the Rust and C# runtimes a callback called from another thread fails as expired.

### Calling

Calling a callback runs the script function synchronously on the sandbox, re-entrantly, inside the binding call:

- **Arguments** go host to sandbox by the same rules as a binding's return value. **The return value** comes back sandbox to host by the same rules as a binding's arguments. A function inside a callback's arguments or return value is not proxied.
- **Budget.** The callback spends the calling script's execution budget. The same timeout, memory, and stack limits apply, and a runaway callback is stopped exactly as a runaway script is. The stop is not the host's to swallow: if a callback exhausts the budget, the binding call ends with the execution-limit error whatever the host does next.
- **Throws.** A script error inside a callback reaches the host as a catchable error whose message is the script error's own message (`CallbackError` with `reason: "threw"`, `CallbackError::Threw`, or `CallbackException` with `Reason == "threw"`). If the host lets it escape, the binding call rethrows the script's original error into the script, so `catch (e)` around the binding call sees the error the callback threw, with its own name and message. In Rust, "lets it escape" means returning the callback error's message unchanged (`Err(e.to_string())`, or `?` into a `String` error).
- **Synchronous only.** A callback returns a settled value. A callback that returns a promise is refused (`reason: "promise"`). An async binding called from inside a callback throws instead of starting (a `BindingError` in the JavaScript runtimes, an `Error` with the same message in Rust), because the callback cannot await it.
- **Re-entrancy.** A callback may call other bindings, including one that takes its own callback. Each binding call has its own scope.

The failure reasons are the same in every runtime: `threw`, `expired`, `promise`, and `limit`.

### Async bindings

An async binding's callbacks stay valid until its result settles, so the host may call them before and after its own awaits. The universal runtime's async (asyncify) sandbox runs such a call while the engine is suspended in the binding; the call is synchronous and must not suspend again, which is why an async binding refuses to start inside a callback in every runtime.

### What is not a callback

Only a function passed **into** a binding call becomes a callback. A function in a value a host binding returns, in a hook's arguments, or in an event payload is not proxied; it is marshalled by the ordinary data rules, and the runtimes that marshal through JSON drop it. A manifest that declares a function type in one of those places gets a `callback-does-not-cross` lint warning.

### Conformance

`spec/callback-tests.json` is the shared corpus every runtime asserts: top-level, nested object, nested array, and deeply nested callbacks; argument and return marshalling; re-entrancy; a throw caught by the host and one left to propagate; a promise return; a call after the binding returned; a runaway callback against the script's budget; and the refusal of a non-function for a declared function parameter.

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

### Two Grammars, On Purpose

Binding names and capability names follow **different grammars**, and the difference is deliberate:

- **Binding and member names are JavaScript identifiers.** A binding is accessed as `world.getHealth(...)` — a kebab name would parse as subtraction, so the schema places **no segment pattern** on `bindings` keys or namespace `members` keys. camelCase is the convention; underscores are legal.
- **Capability scopes are kebab dotted paths.** A capability names a node in a scope tree (`fs.addon`, `modify-player`), matched by prefix subsumption — the `capabilityRef` grammar (`^(read:|write:)?[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$`) applies to capability declarations and every `capability` reference field, never to binding names.

A gated binding therefore routinely pairs the two: the member `exportReport` (identifier) gates on the capability `reports.export-report` (kebab scope). Tooling that applies the capability grammar to binding names is over-reaching; the validator, `score`, and `lint` constrain only the capability side.
