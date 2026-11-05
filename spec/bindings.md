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
  // e instanceof BindingError
  // e.message === "player.setHealth(): health value must be non-negative"
  // e.binding === "player.setHealth"
  log(e.message);
}
```

The message names the binding exactly once, as `<binding>(): <reason>`: a host message that already starts with that prefix is not prefixed again. The same holds for every way a binding call can fail: the host function throwing (or, for an async binding, rejecting), a binding the host did not supply (`<binding>(): not implemented by the app`), and a value that cannot cross the boundary. `BindingError` and `CapabilityDeniedError` are globals in every runtime, and each error a binding throws is a real instance of its class (and of `Error`), so `instanceof` works. Both globals are sealed with the runtime's other globals (non-writable, non-configurable, each class and its prototype frozen), and the runtime builds every error from the classes it captured at install, defining `name`, `binding` and `capability` as own properties rather than assigning them, so nothing a script does to the globals or to `Error.prototype` changes what a binding throws. The `events` bus refuses a call with the same two classes. `spec/binding-error-tests.json` pins the name, message, `binding`, `capability`, and `instanceof` of each.

### Script-Side Error Handling

Modders can wrap binding calls in try/catch. Uncaught errors from bindings terminate the script with the error message logged to the host's mod console.

### Error Types

The runtime provides these error types to scripts:

| Error | When Thrown |
|-------|------------|
| `BindingError` | A binding function failed during execution |
| `CapabilityDeniedError` | A gated function was called without the required capability. Message: `<binding>() requires the "<capability>" capability, which hasn't been granted to this script. Ask the app developer to enable it.`; carries `.binding` and `.capability` |
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

`async` declares the **shape** of the value a script receives: a real promise rather than a settled value, so `binding() instanceof Promise` is `true` and `.then`, `Promise.all`, and `Promise.race` work on it. It says nothing about whether the interpreter yields while the host does its work; that is a property of the runtime, and the runtimes differ:

| Runtime | What `await binding()` does | Other work on the same runtime meanwhile |
| --- | --- | --- |
| JS/WASM, `initXriptAsync` | the script receives a pending promise, settled when the host promise settles; the continuation runs when the runtime drains its job queue, under a fresh `timeout_ms` budget, and the host's event loop is free | yes: other calls run meanwhile, and several async bindings can be pending at once |
| JS/WASM, `initXript` | async bindings are not available; a host function's return value is marshalled as-is | n/a |
| Node.js | the host promise is handed to the `vm` context unchanged; the script genuinely awaits it and the event loop is free | yes: other calls on the runtime run while it is pending |
| Rust, `RuntimeMode::Sync` (default) | the host future is driven to completion on the interpreter thread (`pollster::block_on`) and the script receives an already-settled promise; `await` never suspends | none: the interpreter thread is held for the binding's full duration |
| Rust, `RuntimeMode::Async` | the script receives a pending promise; the host future runs on the runtime's executor and settles it | yes: other calls on the runtime run while it is pending (drive them with the `*_async` methods or an `XriptHandle`) |
| C# | host functions are synchronous (`HostFunction` returns a settled `JsonElement`) and run on the Jint engine thread; `async` is declarative only | none: the engine thread is held for the call |

Execution limits differ too. In Rust's `RuntimeMode::Async`, `timeout_ms` bounds the whole call, time spent awaiting a host future included, and cancellation reaches a call parked on one. Everywhere else, limits and cancellation bound script execution only: Node's `vm` timeout covers the synchronous run, not the wait on a host promise, and a binding that blocks the engine thread is the host's to bound.

A script awaits an async binding from `executeAsync` (`execute_async` in Rust). In the universal runtime, whose synchronous `execute` cannot drive one, an async binding called during `execute` throws a `BindingError` naming it, the host binding is not called, and the runtime stays usable; the other runtimes settle it in line or hand back the promise. How each runtime treats a promise that a synchronous `execute` ends with is in [execution.md](./execution.md#execute-and-executeasync).

### Optional Parameters

Parameters with a `default` value, `"required": false`, or its inverse alias `"optional": true` become optional:

```typescript
declare function greet(name: string, excited?: boolean): string;
```

A parameter marked `"variadic": true` is a rest parameter: it absorbs every remaining argument and its `type` names the type of each one. Only the last parameter may be variadic.

These flags describe a binding; no runtime enforces them. A script may pass fewer or more arguments than a binding declares, and the binding receives exactly what was passed. Every runtime exposes the flags to a host reading its manifest (`Parameter::is_optional` / `is_variadic` in Rust, `ParameterDef.IsOptional` / `IsVariadic` in C#).

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

## Values Across the Boundary

A value a binding receives or returns, a hook or event payload, an export's arguments, and an execution result all cross between the sandbox and the host. The JavaScript and Node runtimes hand the host real JavaScript values, at every depth. The universal runtime's sandbox is a separate engine, so it copies what crosses out by `JSON.stringify`'s rules except for those values JSON cannot spell: a `Date` arrives as its ISO string and a `Map` as an empty object, while a cyclic value arrives as a genuinely cyclic copy. The Rust and C# runtimes hand it JSON (`serde_json::Value`, `JsonElement`), which has no spelling for several script values, writes `-0` as `0`, and by default has no stable key order.

Every runtime follows the same rules for a value on its way across:

- **Wrapper objects** (`new Number(...)`, `new String(...)`, `new Boolean(...)`, `Object(10n)`) cross as their primitive, keeping a special value: `new Number(NaN)` crosses as `NaN`. This holds for arguments, results, and callback returns at every depth.
- **`toJSON`** applies as it does for `JSON.stringify`, including the key it receives: `""` for a top-level value, an argument included. A `toJSON` that throws is skipped, and the object crosses by its own properties, including a value a getter returned; it is never an error and never the object's string.
- **Getters** run once per crossing. A getter can run again only when a `toJSON` or getter in the same value throws, or the value is cyclic, because a runtime copying through `JSON.stringify` then copies the value a second time. A getter that throws while a value is copied across fails the call, and the script sees the getter's own error, unwrapped.
- **Dropped and empty**: symbol-keyed, non-enumerable, and inherited properties are dropped; `arguments`, an `ArrayBuffer`, a `DataView`, a `WeakMap`, a promise inside a value, and a generator cross as `{}`; an `Array` subclass crosses as a plain array; a hole crosses as `undefined`.
- **Proxies and conversions**: a live proxy crosses as the value it presents through its traps; a revoked proxy, at any depth and in any position (an argument, a result, a callback's return), fails the call with the engine's own `TypeError`, as reading it would. A `Date` crosses as its ISO string (its `toJSON`), a `Map` and a `Set` as `{}`, and an object's `valueOf` and `toString` are never called: it crosses by its own data.
- **Depth**: every runtime carries a value at least 1000 levels deep in both directions. Past a runtime's limit (2048 levels in the JavaScript runtimes, 1024 in Rust, 10000 in C#) the call fails with a `BindingError` whose message begins `<binding>(): `, never with a stack overflow.
- **Error prefix**: a binding error carries its `<binding>(): ` prefix exactly once, whatever the host error it wraps already said.

### Special values

By default the Rust and C# runtimes turn `undefined`, `NaN`, `Infinity` and `-Infinity` into `null` and `-0` into `0`, as `JSON.stringify` does. A host that needs them opts into **value fidelity** (`RuntimeOptions::value_fidelity` in Rust, `RuntimeOptions.ValueFidelity` in C#). Each of the five then travels as a one-key marker object, in the same family as the callback marker:

| Script value | Marker |
|---|---|
| `undefined` | `{ "$xript": "undefined" }` |
| `NaN` | `{ "$xript": "NaN" }` |
| `Infinity` | `{ "$xript": "Infinity" }` |
| `-Infinity` | `{ "$xript": "-Infinity" }` |
| `-0` | `{ "$xript": "-0" }` |

Four more values travel as markers that carry a payload:

| Script value | Marker |
|---|---|
| a BigInt (or BigInt wrapper) | `{ "$xript": "bigint", "value": "-12345678901234567890" }`, the value in decimal |
| a symbol | `{ "$xript": "symbol", "description": "tag" }`, with `description` omitted for a symbol that has none |
| a string that is not well-formed UTF-16 | `{ "$xript": "string", "units": [97, 55296, 98] }`, every UTF-16 code unit of the whole string |
| a reference back to an ancestor | `{ "$xript": "cycle", "up": 1 }`: `up: 1` is the object or array holding the marker, `up: 2` the container holding that one, and so on |

A script value crossing out is encoded at any depth, so `echo(Infinity, undefined, 1)` reaches the binding as `[{"$xript":"Infinity"}, {"$xript":"undefined"}, 1]`. A marker crossing in (a binding's return, a hook or event payload, an export's arguments) is decoded back to the real value, so returning that array gives the script `Infinity`, `undefined`, `1` again, and an object property whose value is the `undefined` marker arrives as an own property holding `undefined`. A `symbol` marker decodes to a fresh symbol with that description, and a `cycle` marker rebuilds the cycle. A marker is an object whose `$xript` names a known tag and whose other keys are exactly that tag's payload keys; any other shape (an unknown tag, an extra key, a missing payload key, or a `cycle` whose `up` is not a whole number of at least 1 or points above the outermost container) is plain data. The callback marker composes with these: a callback in the same arguments is still `{ "$xriptCallback": "<token>" }`.

The new markers follow what the JavaScript runtimes do. A symbol is carried at the top level of a value: a binding's argument, an execution result, a subscriber's result, and a callback's return all cross out as the `symbol` marker, and a `symbol` marker crossing in decodes to a fresh symbol. A symbol nested inside a value follows JSON's rules, dropped from an object and `null` in an array. A cyclic value is marked only at its back-edges: a container that appears twice without a cycle still crosses as two copies. A lone surrogate in a value crosses intact and is never an error. An object key cannot hold a marker, so a lone surrogate in a key is the one place the JSON boundary shows: the JavaScript runtimes keep the key intact, and Rust and C# turn the surrogate into U+FFFD in both modes.

Without value fidelity, a value that cannot cross fails with an error that names where it was going, never silently: a BigInt or a cyclic value in a binding's arguments is refused with a `BindingError` naming the binding, and one in an execution result, a hook or event result, or a callback's return fails that call with a named error rather than becoming `null`. A lone surrogate becomes U+FFFD, and a symbol becomes `null`.

Value fidelity also makes numbers consistent in Rust: an integral script number held as a double (anything computed from a host binding's return) reaches the host as an integer, as a literal does. The C# runtime already returns integral numbers as integers.

Hosts build and read markers with small helpers: `special::{undefined, nan, infinity, neg_infinity, neg_zero, number, as_f64, is_undefined}`, the `Special` enum, and the `XriptValue` trait in Rust; `XriptValue.{Undefined, NaN, Infinity, NegativeInfinity, NegativeZero, Number, TryGetNumber, TryGetSpecial, IsUndefined}` and `XriptSpecial` in C#. `number` and `Number` spell `-0` as its marker.

### Key order

An object keeps the key order its author wrote, in both directions, and a hook or event payload object spreads to arguments in that order. The JavaScript, Node and C# runtimes keep authored order natively. The Rust runtime keeps it when built with its `preserve_order` cargo feature; without it, keys arrive sorted.

### Conformance

`spec/value-fidelity-tests.json` pins every rule above at any depth: inbound, out and back through a binding, out to a binding that only receives (`sink`, for getters, wrappers, and symbols), as results, through hook and event payloads and results, as a callback's return (`callbackResult`), at 1000 levels and past the limit (`depth`), and the single error prefix (`prefix`), written in marker spelling: the JavaScript runtimes decode it to real values before handing it over and encode what their host receives, cycles as back-references, before comparing. `spec/key-order-tests.json` pins authored key order inbound, round-tripped, and spread from a hook payload, and JavaScript's own order for integer-like keys. `spec/async-tests.json` pins async bindings as real promises, the async function body `executeAsync` runs, and the synchronous `execute` refusals.

## Callbacks

A binding can take a function. A pathfinder asks which cells are walkable, a filter asks which items to keep, a field-of-view routine asks what blocks sight: each needs a predicate the mod supplies. A script function passed anywhere in a binding's arguments (top level, an object field, an array element, any depth) arrives on the host as a **callback**: a callable proxy for the script function.

```javascript
const route = map.findPath(start, goal, { walkable: (cell) => !cell.lava });
```

The host calls the callback like a function. In the JavaScript and Node runtimes it is a plain function that throws `CallbackError`; in the Rust and C# runtimes, whose bindings receive JSON, a function appears in the arguments as a marker object `{ "$xriptCallback": "<token>" }` that the host resolves with `Callback::from_value` (Rust) or `XriptCallback.From` (C#) and calls with `call` / `Invoke`.

### Lifetime

By default a callback is **call-scoped**: it is valid only while the binding call that received it is running. Once the binding returns (or, for an async binding, once its result settles), calling it fails as expired, with a message naming the binding. A call-scoped callback has no cross-call lifetime to manage and nothing for a garbage collector to get wrong, which is why it is the default.

A callback is also bound to the thread running the call. In the Rust and C# runtimes a callback called from another thread fails as expired.

### Retained callbacks

Some hosts need to keep a mod's function: a timer binding that runs it later, a subscription that calls it on every change, a save system's `register(capture, restore)`, a behavior-tree `action(fn)` whose stored action a later `tick(tree)` binding calls. The manifest declares where that is allowed by marking a function-typed position `"retain": true`:

```json
"after": {
  "description": "Runs a function after a delay.",
  "params": [
    { "name": "ms", "type": "number" },
    { "name": "fn", "type": "function", "retain": true }
  ]
}
```

`retain` is valid on a binding parameter typed as a function (`"function"`, `{ "function": { ... } }`, or either wrapped in `optional`), and on a function-typed field of a declared custom type, so `options.onDone` inside a parameter typed `TimerOptions` can be retained while `options.onTick` stays call-scoped. A retain-marked position is found through the declared type: a parameter's type, `optional`, an array (`T[]` or `{ "array": T }`), a map's values, every branch of a union, and every argument of a variadic parameter. The runtime walks the declared types along the path where the callback actually sits, so a recursive type (a tree node whose `children` are tree nodes, each with a retained `action`) is retainable at any depth. `retain` anywhere else is a validation error (`retain-not-function`).

Every runtime records where in the arguments each callback was found. Only a callback found at a retain-marked position can be retained; the host retains it during the binding call:

| Runtime | Retain | Call | Release |
|---|---|---|---|
| JavaScript, Node | `callback.retain()` returns `{ call(...args), release() }` | `retained.call(...args)` | `retained.release()` |
| Rust | `Callback::retain()` returns `Result<RetainedCallback, RetainError>` | `retained.call(&args)` | `retained.release()` |
| C# | `XriptCallback.Retain()` returns a `RetainedCallback` | `retained.Invoke(args)` | `retained.Release()` |

`retain()` refuses (`RetainError` / `RetainException`) with `undeclared` when the callback is not at a retain-marked position, and with `limit` when the runtime already holds `limits.max_retained_callbacks` retained callbacks (default 10000). Retaining a callback whose call has ended fails as expired.

**Identity.** A script function is retained at most once per mod. Retaining it again, at any position, returns the same retained callback (the same handle object in JavaScript and Node, an equal handle with the same token in Rust and C#) and does not count twice against the limit. So a host that stored a retained callback recognizes it when the script hands it back in another binding's arguments: it calls `retain()` on the callback it received and compares.

**Calling.** A retained callback may be called in two places, both on the runtime's own thread:

- **Re-entrantly, from inside any binding call a script is running** (a `tick` binding calling stored actions). It runs exactly as a call-scoped callback does: it spends that script call's budget, and an execution-limit stop ends that script call whatever the host does.
- **Between script calls** (a timer firing). It runs on a fresh execution budget, the same way a hook fire or an export invocation gets one, and a limit stop fails that one call with `limit`; the runtime stays usable.

Called from another thread, it fails as expired. Every other calling rule above applies unchanged: arguments and return values marshal the same way, a throw arrives as `threw` and passes through as the script's own error, a promise is refused, and an async binding refuses to start inside it. A retained callback runs on behalf of the mod that supplied it, so a callback that mod retains from inside it is that mod's too.

**Release.** A retained callback stays alive until it is released: explicitly with `release()` (releasing twice does nothing), all at once for one mod with `releaseRetained(modName)` / `release_retained(mod)` / `ReleaseRetained(mod)` (what unloading a mod does; returns how many it released), or all at once when the runtime is disposed. Calling a released callback fails with reason `released`. A released function can be retained again, as a new retained callback.

**Round trip.** A retained callback the host passes back into the sandbox (as a binding's return value, a member of hook data or an event payload, or an export argument) arrives as the original script function, so `fn === original` holds in the script. In JavaScript and Node the host passes the retained handle itself; in Rust and C# it passes the handle's marker, `retained.to_value()` / `retained.ToMarker()`, which is the same `{ "$xriptCallback": "<token>" }` shape. It resolves only in the runtime that holds it, and not while a different mod is running than the one that supplied it: a released one fails as `released`, and one crossing in while another mod runs fails as expired. A handle from another runtime fails as expired in JavaScript and Node. In Rust and C#, a marker that names no retained callback the runtime issued (another runtime's, a call-scoped token, or plain data shaped like a marker) is not a retained callback at all and stays plain data, exactly as before `retain` existed. A marker never resolves to anything but the function it was issued for.

```javascript
// host (JavaScript)
const timers = [];
const host = {
  clock: {
    after: (ms, fn) => { timers.push({ due: now() + ms, fn: fn.retain() }); },
  },
};
// later, between script calls
for (const timer of dueTimers()) { timer.fn.call(); timer.fn.release(); }
```

### Calling

Calling a callback runs the script function synchronously on the sandbox, re-entrantly, inside the binding call:

- **Arguments** go host to sandbox by the same rules as a binding's return value. **The return value** comes back sandbox to host by the same rules as a binding's arguments. A function inside a callback's arguments or return value is not proxied.
- **Budget.** The callback spends the calling script's execution budget. The same timeout, memory, and stack limits apply, and a runaway callback is stopped exactly as a runaway script is. The stop is not the host's to swallow: if a callback exhausts the budget, the binding call ends with the execution-limit error whatever the host does next.
- **Throws.** A script error inside a callback reaches the host as a catchable error whose message is the script error's own message (a thrown string is its own message; a thrown value with no `message`, such as a number, `null`, or a plain object without one, gets a runtime's own text) (`CallbackError` with `reason: "threw"`, `CallbackError::Threw`, or `CallbackException` with `Reason == "threw"`). If the host lets it escape, the binding call rethrows the script's original error into the script, so `catch (e)` around the binding call sees the error the callback threw, with its own name and message. In Rust, "lets it escape" means returning the callback error's message unchanged (`Err(e.to_string())`, or `?` into a `String` error).
- **Synchronous only.** A callback returns a settled value. A callback that returns a promise is refused (`reason: "promise"`). An async binding called from inside a callback throws instead of starting with a `BindingError` naming it, because the callback cannot await it. Rust adds `RetainedCallback::call_async` for a host that wants an async callback's result: it accepts a promise return, drives the runtime's jobs until the promise settles, and resolves to its value. It is safe nested, including from inside a binding of the same runtime.
- **Re-entrancy.** A callback may call other bindings, including one that takes its own callback. Each binding call has its own scope.

The failure reasons are the same in every runtime: `threw`, `expired`, `promise`, `limit`, and, for a retained callback, `released`.

### Async bindings

An async binding's callbacks stay valid until its result settles, so the host may call them before and after its own awaits. Such a call is synchronous and cannot await anything itself, which is why an async binding refuses to start inside a callback in every runtime.

### What is not a callback

Only a function passed **into** a binding call becomes a callback. A script function in a value leaving the sandbox any other way (an `execute` result, an export's return value, a hook handler's return) is not proxied; it is marshalled by the ordinary data rules, and the runtimes that marshal through JSON drop it. Functions never cross out of the sandbox as host-callable values except through a callback, and never outlive their call except through a declared `retain`.

In the other direction, a function in a value a host binding returns, in a hook's arguments, or in an event payload is not a callback either: it is marshalled by the ordinary data rules, and the runtimes that marshal through JSON drop it. The one exception is a retained callback coming back, which arrives as the script's own function (see Round trip). A manifest that declares a function type in one of those places gets a `callback-does-not-cross` lint warning, unless the position is marked `retain`, which declares exactly that round trip.

### Conformance

`spec/callback-tests.json` is the shared corpus every runtime asserts: top-level, nested object, nested array, and deeply nested callbacks; argument and return marshalling; re-entrancy; a throw caught by the host and one left to propagate; a promise return; a call after the binding returned; a runaway callback against the script's budget; and the refusal of a non-function for a declared function parameter. For retained callbacks it pins retaining at a retain parameter, a retain field of a declared type, an array of that type, and a variadic parameter, and refusing anywhere else; identity (one retained callback per function per mod, recognized again at an undeclared position); calling between script calls on a fresh budget and re-entrantly on the calling script's budget, with throws, promises, and limit stops in both; another thread failing as expired; explicit release, per-mod release, and disposal, with `released` after each; `max_retained_callbacks` and the capacity a release frees; and the round trip back in through a binding's return value, hook data, an event payload, and export arguments, refused for a released callback and for another mod.

## Optional Bindings

A binding declared `"optional": true` (a function, a namespace, a namespace member, or an accessor) is one a conforming host may omit. It lets hosts with different capabilities share one manifest: a binding that needs a browser is declared once, and only the hosts that can provide it do.

### What a mod sees

- **An omitted optional binding is `undefined`.** The name is bound, so a bare reference never throws a `ReferenceError`, and its value is `undefined`, so `typeof share === "undefined"`, `if (net.fetch)`, and `net.fetch?.(url)` all work. It is never a stub that throws.
- **A provided optional binding works normally.** Nothing about a call changes because the declaration says `optional`.
- **`xript.has(path)` is the probe.** It answers `true` only when `path` names a declared binding (top-level, namespace, member, or accessor, dotted: `"net.fetch"`) that this host provides. It answers `false` for a declared binding the host omitted, for anything beneath an omitted namespace, for an undeclared path, and for a non-string argument. A namespace counts as provided when the host supplies it, whatever it supplies inside. `has` answers presence, not permission: a provided binding gated by a capability the script lacks still answers `true`, and calling it is still refused. The answer is fixed when the runtime is built, and `has` cannot be replaced or reassigned by a script.

### What a host sees

Omitting a binding that is **not** optional is unchanged: it installs as a stub that throws when called, it is listed in the runtime's missing-bindings report (`missingBindings`, `missing_bindings()`, `MissingBindings`), and strict binding checks refuse to construct. Omitting an optional binding is not drift, so it is not reported, and neither is anything beneath an optional namespace the host omits. A host that provides an optional namespace is held to the usual rule for that namespace's non-optional members.

### Tooling

`typegen` types an omitted-able binding as possibly `undefined` (an optional property, or `| undefined` on a global), so a mod that calls one unguarded fails to typecheck; a namespace holding an optional member is emitted as an object type for that reason. `docgen` marks the binding "Optional: a host may omit this" with its `xript.has` path. The ambient declarations type `xript.has(path: string): boolean`.

### Conformance

`spec/optional-binding-tests.json` is the shared corpus every runtime asserts: omitted optional functions, namespaces, and members are bound to `undefined`; guards fall back; provided optional bindings work; the omitted non-optional binding still throws and is the only one reported; and `xript.has` answers true and false across declared, omitted, nested, undeclared, non-string, and capability-gated paths.

## Accessors

A binding declared with `accessor` reads as a value the host computes on every read, rather than a function a script calls. It is the shape for live state: a clock, the current selection, a setting the host owns.

### Supplying one

| Runtime | A host supplies an accessor as |
| --- | --- |
| JS/WASM, Node.js | `{ get: () => value, set?: (value) => void }` at the binding's place in `hostBindings`, or a native getter (and setter) defined on the namespace object |
| Rust | `HostAccessor::new(get).with_setter(set)`, registered by dotted path with `HostBindings::add_accessor("clock.now", ...)` or as a namespace member with `NamespaceBuilder::accessor("now", ...)` |
| C# | `new HostAccessor(get, set)`, as a namespace member with `HostNamespaceMember.Live(...)` or at the top level with `HostBindings.AddAccessor(...)` |

A `get-set` declaration needs both a getter and a setter; a host that supplies only a getter has not supplied it, and it is reported missing like any other unsupplied binding. A host that can only read declares `get`.

### What a script sees

- **Every read calls the getter.** Nothing is cached: two reads are two host calls, and the value is whatever the host answers at that moment.
- **Every assignment calls the setter** with the assigned value, marshalled as a binding argument is.
- **Without a setter, assignment throws a `TypeError`** whose message says the value is read-only, in strict and sloppy code alike. A silently dropped write in sloppy code would read as success to a mod that never checks.
- **An accessor is a real accessor property.** It is enumerable, it cannot be deleted or redefined, and its namespace is frozen as every namespace is. Freezing never reads it: building the runtime calls no getter.
- **Each access is a binding call.** It is capability-gated on every read and write, audited under the binding's dotted name, runs on the calling script's execution budget, and an error the host raises reaches the script as that runtime's ordinary binding error, catchable, carrying the host's message.
- **An accessor omitted by the host** reads as `undefined` when it is `optional`, and otherwise throws on read and write the way a missing function's stub throws on call.

`typegen` declares a `get` accessor `readonly` (a top-level one as a `const`) and a `get-set` accessor as a writable property (a top-level one as a `let`). `docgen` documents it as a value with its type and whether it is writable.

### Conformance

`spec/accessor-tests.json` is the shared corpus every runtime asserts: the getter runs per read and never at construction; the setter receives scalar and structured values; assignment without a setter is refused in sloppy and strict code and leaves the value live; getter and setter errors reach the script; a gated accessor is refused; an omitted optional accessor is `undefined` and an omitted required one throws; the property is a real accessor on a frozen namespace; a top-level accessor works the same way; and a loop over a getter is stopped by the execution budget.

## Caller Identity

A host binding can ask which mod called it. The runtime already knows: it keeps a caller context, a stack it pushes when it enters a mod's code (the mod's entry script, an export invoked in that mod's namespace, a hook or event handler that mod registered, a [retained callback](#callbacks) that mod supplied) and pops when that code returns. A caller-aware binding receives the top of that stack as call info ahead of the script's arguments:

```javascript
import { withCaller } from "@xriptjs/runtime";

const hostBindings = {
  saveSlot: withCaller((info, slot, data) => {
    // info.modId: "inventory-plus", or null for code no mod owns
    // info.binding: "saveSlot", or the qualified "storage.saveSlot" in a namespace
    return store.write(`${info.modId ?? "host"}/${slot}`, data);
  }),
};
```

| Runtime | Caller-aware form |
|---------|-------------------|
| `@xriptjs/runtime`, `@xriptjs/runtime-node` | `withCaller((info, ...args) => ...)`, anywhere a host function goes, including inside a namespace |
| `xript-runtime` (Rust) | `HostBindings::add_function_with_caller(name, \|info: &HostCallInfo, args\| ...)`, or `HostNamespaceMember::CallerFunction` in a nested namespace |
| `Xript.Runtime` (C#) | `HostBindings.AddFunction(name, (HostCallInfo info, JsonElement[] args) => ...)`, or `HostNamespaceMember.Fn(CallerHostFunction)` |

`modId` is `null` for code no mod owns: host-run `execute`, and a continuation that resumes after the host call that started it has already returned.

Attribution follows the logical call, not whichever call ran last. A call that awaits an async binding and resumes after another call started is still credited to its own mod, in every runtime that lets calls interleave: each async call carries its caller across its suspensions and re-enters it around every resumption (Node through the async context its continuations inherit, the JS/WASM asyncify build around the resumption it drives, Rust's `RuntimeMode::Async` in a caller lane per call). C# settles a call's continuations before the call returns, so its calls never interleave.

The caller context lives on the host, so a mod cannot claim to be another. Caller identity is opt-in per binding; a plain host function is called exactly as before. The event bus uses the same context to attribute subscriptions (see [Ownership](./hooks.md#ownership)), and `spec/event-bus-tests.json` pins both. Subscriptions and retained callbacks are held independently: releasing a mod's retained callbacks leaves its subscriptions in place, even one on the same function, and cancelling its subscriptions leaves its retained callbacks callable (`spec/callback-tests.json`).

## Built-in Globals

A top-level binding becomes a global of the same name, and the runtime installs four globals of its own: `console`, `events`, `hooks`, and `xript`. A binding that reuses one of those names is legal, and nothing refuses it, but the two collide. Which one a mod sees depends on the name:

| Name | What the runtime installs | When a binding uses the name |
|------|---------------------------|------------------------------|
| `console` | logging, routed to the host's console handler | the binding wins; `console.log` and its siblings no longer reach the console handler |
| `events` | the [events bus](./hooks.md#event-delivery) | the runtime's `events` wins and the binding is unreachable. The Rust and C# runtimes install `events` only when the manifest declares events, so on those two a manifest with no `events` keeps the binding |
| `hooks` | hook registration | the runtime's `hooks` wins and the binding is unreachable |
| `xript` | the exports API, `xript.exports` | not consistent: the outcome differs by runtime and by whether the binding is a function or a namespace, and mods can lose `xript.exports`. A binding named `xript` is already a `reserved-identifier` lint error |

`xript lint` reports each collision as a `binding-shadows-builtin` warning naming the built-in and the side that wins, and every runtime raises the same code once on its [deprecation channel](./deprecations.md) at construction when a built-in actually replaced a host binding. Move the binding under a namespace, where a member named `events` or `console` is just a property and collides with nothing. A host that wanted an events binding should declare its events in the manifest's `events` instead; mods then get the bus.

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
