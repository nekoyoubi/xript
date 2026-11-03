# xript Hook Conventions

A hook is an event-typed slot: a host-declared plug-point whose `accepts` is the event-handler type (`application/x-xript-hook`), and whose fills are handlers the host calls when the event fires. Hooks are the reverse of bindings — bindings let scripts call the host; an event slot lets the host call scripts. Together, they form a bidirectional communication channel between the application and its mods.

This document covers hook declaration, lifecycle phases, registration, invocation, and the runtime conventions that govern hook behavior. Those conventions are the semantics of the event slot type; everything below applies whether an event is declared as a slot or, for back-compat, in the deprecated standalone `hooks` section.

> **The standalone `hooks` concept is deprecated.** A lifecycle event is an event-typed slot, and firing it means calling that slot's fills. The `hooks` field remains allowed (hosts still fire hooks and runtimes still dispatch them), but new manifests should declare events as slots and let mods fill them. The declaration form below documents the back-compat surface; the conventions it describes carry over unchanged to event slots.

## Declaration

A host declares an event as a slot whose `accepts` is the event-handler type. The deprecated standalone form declares it in the manifest's `hooks` section instead:

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

Either form requires a `description`. Like bindings, if a modder can't understand what an event does, it may as well not exist. A mod fills an event slot by naming a handler export (`{ "handler": "onPlayerDamage" }`); the script-side registration helpers below are the runtime's convenience over that wiring.

## Lifecycle Phases

Hooks can optionally declare lifecycle phases. Phases let scripts intervene at specific points in a host operation:

```json
{
  "hooks": {
    "save": {
      "description": "Fired during the save lifecycle.",
      "phases": ["pre", "post", "done", "error"],
      "params": [
        { "name": "data", "type": "SaveData", "description": "The save payload." }
      ]
    }
  }
}
```

The four standard phases are:

| Phase | When | Typical Use |
|-------|------|-------------|
| `pre` | Before the operation | Validation, modification, cancellation |
| `post` | After the operation, can modify | Result transformation, interception |
| `done` | After all post-processing, sealed | Logging, notifications, observation |
| `error` | When the operation fails | Error recovery, fallback behavior |

Phases are optional. A hook without phases is a simple notification — it fires, handlers run, done. The host controls which phases it declares and in what order it fires them.

## Registration (Script Side)

Scripts register handlers via the `hooks` global object injected by the runtime.

### Simple hooks (no phases):

```javascript
hooks.playerDamage((amount, source) => {
  log(`Player took ${amount} damage from ${source}`);
});
```

### Phased hooks:

```javascript
hooks.save.pre((data) => {
  log("About to save: " + data.filename);
});

hooks.save.post((data) => {
  log("Save complete: " + data.filename);
});
```

Multiple scripts can register handlers for the same hook (or phase). Handlers run in registration order.

## Invocation (Host Side)

The host fires hooks through the runtime's `fireHook` method:

```javascript
// Simple hook
const results = runtime.fireHook("playerDamage", { amount: 25, source: "trap" });

// Phased hook
const preResults = runtime.fireHook("save", { phase: "pre", data: savePayload });
const postResults = runtime.fireHook("save", { phase: "post", data: savePayload });
```

`fireHook` returns an array of results from all registered handlers, in registration order. If no handlers are registered, it returns an empty array.

A Rust `XriptPool` fires a hook at every handler registered for it on any worker, whenever it was registered (by a mod's entry, an export, another handler, or host code), and returns the results in the order one runtime would: every handler in registration order across the pool, then every hook fill in its mod's load order.

### Firing one phase

A fire with a `phase` runs only the handlers registered through `hooks.<hook>.<phase>(fn)`, in registration order, and passes `data` as the JavaScript runtimes do: a plain object spreads to its values in key order, any other value is the one argument, and no `data` passes no arguments. A phase the hook does not declare, a hook with no phases, and an unknown hook all run nothing and return an empty array; the fire is refused, not an error. Hook fills are unphased and never run on a phased fire. An empty phase (`""`) is no phase: the fire runs exactly what an unphased fire runs, hook fills included.

Each runtime spells it with its own host idiom:

| Runtime | Phased fire |
|---|---|
| JavaScript, Node | `runtime.fireHook(hook, { phase, data })` |
| Rust | `runtime.fire_hook_phase(hook, phase, Option<&Value>)`, plus `fire_hook_phase_tagged` and `_async` twins; also on `XriptHandle`, `BlockingHandle`, and `XriptPool` |
| C# | `runtime.FireHook(hook, new FireHookOptions { Phase, Data })` |

`spec/hook-phase-tests.json` is the conformance corpus every runtime asserts. What an unphased fire does with a phased hook's handlers is not part of that contract.

## Event Delivery

Hook dispatch and the top-level [`events` catalog](./manifest.md#events-host-broadcast-catalog) share one fan-out contract: handlers run in registration order, an object payload spreads to positional arguments, any other payload is passed as a single argument, and a handler that throws contributes `undefined` without stopping the others. The `events` side is a full bus. Mods subscribe, cancel, emit the events the host lets them emit, and read who is listening, while the host emits, declares events at runtime, and clears one mod's subscriptions.

The bus is one JavaScript source that every runtime installs verbatim into its sandbox. Its behaviour is the same in all four runtimes by construction, and `spec/event-bus-tests.json` pins it.

A Rust `XriptPool` is several runtimes with one bus. Its workers share the catalogue, the namespace claims, and every subscription's record, so a declaration, a claim, a cancellation or a question about who is listening answers the same whichever worker asks. A handler runs on the worker that subscribed it. An emit, from the host or from a mod, walks the subscriptions in subscription order and has each handler's worker run it, so it reaches every worker with the ordering and results of a single runtime. A worker waiting on another serves what is asked of it meanwhile, and the wait counts against the emitting call's own budget.

How a worker waits depends on how the emit was made. A host emit on a worker built in `RuntimeMode::Async` awaits each answer from another worker as a parked call, so the worker's thread keeps running its other calls meanwhile. A mod's `events.emit` is a synchronous call that returns the handlers' results, so on any worker the thread waits until the answer arrives, serving requests addressed to it while it waits. A mod that must not hold the worker uses [`events.emitAsync`](#emitting), which delivers the same results as a promise and, on a `RuntimeMode::Async` worker, awaits each answer from another worker the way a host emit does.

A payload a handler on another worker receives, and the result it returns, cross between the workers as JSON with the [special-value markers](./bindings.md#special-values) always on, whatever `value_fidelity` says, since that hop never reaches the host. `undefined` (an own property holding it included), `NaN`, the infinities and `-0` therefore arrive exactly as they left. A function cannot leave the interpreter that holds it. It crosses as `{ "$xriptCallback": "cross-worker" }`, a callback marker that names no callback where it lands, so the handler sees that plain object, just as a single Rust runtime hands a handler plain data for a callback marker it did not issue. The same holds for a function in a result crossing back. A payload JSON cannot hold at all, such as one with a cycle, cannot reach a handler on another worker, and the emit throws.

### Subscribing

```javascript
const sub = events.on("player.damaged", (amount, source) => {
  log(`took ${amount} damage from ${source}`);
});

sub.id;       // a storable string token
sub.event;    // "player.damaged"
sub.cancel(); // { cancelled: true, spent: false }

events.subscribe("level.loaded", () => { /* alias of events.on */ });
events.once("level.loaded", () => { /* runs at most once */ });
```

A handler receives an object payload's values as positional arguments, in the order the payload object holds its keys: the host above emitted `{ amount, source }`, so the handler takes `(amount, source)`. A payload that is not a plain object arrives as one argument, and no payload as none. Typegen types handlers the same way, from the payload type's declared fields in order, so a host that builds each payload in its declared field order matches the generated types. The Rust runtime currently orders an object payload's keys alphabetically, whatever order the host wrote them in.

`events.on(id, handler, options?)` and `events.once(id, handler, options?)` return a frozen `{ id, event, cancel }`. `id` is a string the mod may store and pass to `events.cancel` later, and `cancel()` is shorthand for that. `once` spends its subscription before the handler runs, so a handler that throws does not resubscribe.

`options.match` filters by payload: the handler runs only when every listed top-level payload key is strictly equal (`===`) to the given value. An empty `match` always runs; a payload that is not an object never satisfies a non-empty one. When the event declares `keys`, a `match` key outside them is refused at subscribe time.

```javascript
events.on("stat.changed", (instanceId, value) => redraw(value), { match: { instanceId: "hero" } });
```

Subscribing refuses, with a `BindingError`, an empty id, a non-function handler, an id that resolves to no declared entry, and a family shape such as `stat.<instanceId>.changed` (subscribe to a concrete id instead). An event whose entry declares a `capability` admits a subscriber only when the granted set satisfies it via `grantedSatisfies` (mode lattice plus prefix subsumption, see [Capability Model](./capabilities.md#hierarchical-capabilities)); otherwise subscribing throws a `CapabilityDeniedError`. An event with no `capability` admits any subscriber.

### Ownership

Every subscription belongs to the mod that made it: the runtime's caller context at the moment `on` ran. The runtime enters a mod's context while it runs that mod's entry script, an export invoked in that mod's namespace, or a handler that mod subscribed. A call that awaits and resumes keeps its owner across the await, whatever other calls ran meanwhile (see [Caller Identity](./bindings.md#caller-identity)). Code no mod owns, such as host-run `execute` or a continuation that resumed after the call that started it had returned, has no owner, and its subscriptions are *untracked*. Having no owner grants no privilege: untracked code is treated like any other owner.

- `events.cancel(idOrSubscription)` returns `{ cancelled, spent }`. The first cancel answers `{ cancelled: true, spent: false }` and a repeat answers `{ cancelled: false, spent: false }`. For a `once` that has already fired it answers `{ cancelled: false, spent: true }`. Cancelling another owner's subscription needs the `events.off` capability.
- `events.off(id)` drops the caller's own listeners on that event and returns how many. With `events.off` it drops everyone's.
- `events.cancelOwned()` cancels every subscription the caller owns and returns how many. `events.cancelOwned(owner)` names another owner, which needs `events.off`; `null` names the untracked listeners.

The host side has `cancelOwned(modId)` (`cancel_owned` in Rust, `CancelOwned` in C#). It re-runs one mod's scripts without unloading the mod: cancel what it subscribed, then run its scripts again.

### Emitting

The host emits with `emit`, the sibling of `fireHook`:

```javascript
const results = runtime.emit("player.damaged", { amount: 25, source: "trap" });
```

The id may be any concrete id that [resolves](#resolution) to a declared entry, and an id that does not resolve delivers to nobody and returns `[]`. Handlers run in subscription order against a snapshot taken when the emit starts. A listener cancelled during the dispatch is skipped, and one added during it waits for the next emit. Results come back in order.

A mod may emit only an event declared with `"emit": "mods"`:

```javascript
const results = events.emit("note.posted", { text: "hello" });
```

`events.emit` follows the same fan-out rules and returns the handlers' results. Emitting a host-only event, an undeclared id, or a family shape throws a `BindingError`.

`events.emitAsync(id, data?)` is `emit` delivered as a promise:

```javascript
const results = await events.emitAsync("note.posted", { text: "hello" });
```

It takes the same arguments and makes the same checks, runs the handlers in the same order against the same snapshot, under the same budget, and resolves to exactly the array `emit` would return. A refused emit does not throw: the promise rejects with the `BindingError` `emit` would have thrown, naming `events.emitAsync`. Where every handler can run without waiting on another runtime, which is everywhere except a Rust `XriptPool` worker built in `RuntimeMode::Async`, the handlers run before `emitAsync` returns and the promise is already resolved. On such a pool worker a handler held by another worker is awaited rather than blocked on, so the worker's thread keeps running other calls meanwhile, and a call whose budget runs out while it waits rejects with a `BindingError` (the call itself fails with its timeout or cancellation, as any parked call does). A promise settles when the runtime runs its job queue, as any other promise in that runtime does.

### Resolution

`events.describe(id)` returns the catalogue entry an id resolves to, or `null`. It looks for an exact match on an entry's `id` first. If none matches, it walks the catalogue in order and tests every `pattern` id and every `addressed` form segment by segment. Segments are the `.`-separated parts of the id, and a `<name>` segment matches exactly one non-empty segment. `on` and `emit` accept any concrete id that resolves this way, and the listeners of each concrete id are kept apart.

```json
{ "id": "stat.changed", "description": "Fired after any stat changes.", "addressed": ["stat.<instanceId>.changed"] }
```

Here `stat.hero.changed` resolves to `stat.changed`, and a subscriber to `stat.hero.changed` hears only the hero. The host emits the generic and the addressed form side by side.

> **Limitation.** A `<name>` covers one segment, so a subject id that itself contains a `.` does not fit: `stat.hero.hp.changed` does not resolve against `stat.<instanceId>.changed`. Pick subject ids without dots, or declare a shape with as many segments as the subject has.

### The catalogue at runtime

`events.declare(entry)` adds an event to the catalogue. The entry has the same shape as a manifest `events` entry, and a mod needs the `events.declare` capability to call it. Once declared, the event can be subscribed to, emitted (for an `"emit": "mods"` entry), and described. The declarer may declare the same id again to replace its entry, but no one may redeclare an id the manifest declares or another owner declared. The host has `declareEvent(entry)` (`declare_event`, `DeclareEvent`) with no capability check. A malformed entry is refused, including one that breaks the id grammar, has an unknown field, gives an `emit` other than `"host"` or `"mods"`, or disagrees between `pattern` and `<name>` segments.

`events.catalogue()` returns every entry, manifest-declared first and then runtime-declared, in declaration order. Typegen types the manifest-declared ones; an id declared at runtime is untyped.

### Namespaces

`events.claim(prefix)` claims an event-id namespace for the calling mod and needs `events.claim`. It answers `true` when the caller now holds the prefix (or already did), and `false` when another mod holds it. Untracked code cannot claim. `events.namespaces()` lists every claim as `{ prefix, owner }`, longest prefix first. `events.ownerOf(id)` returns the owner of the most specific claim covering the id, or `null`. A claim covers an id when the id equals the prefix or continues it at a `.` boundary, so `stat` covers `stat.hero.changed` and does not cover `status.changed`. Claims are declarative and never checked at emit; they tell mods who speaks for a namespace.

### Introspection

- `events.names()`: every event id currently holding a listener, sorted
- `events.listenerCount(id?)`: listeners on one event, or on all of them
- `events.subscribers(id)`: `{ event, total, owners: [{ owner, count }], repeated, untracked }`, with owners sorted. `repeated` lists the owners holding more than one subscription on the event and `untracked` counts the listeners with no owner

### Bus capabilities

| Capability | Lets a mod |
|------------|-----------|
| `events.off` | cancel, `off`, or `cancelOwned` another owner's subscriptions |
| `events.claim` | claim an event-id namespace |
| `events.declare` | declare an event at runtime |

A host declares these in its `capabilities` to make them grantable. Prefix subsumption applies as usual, so a grant of `events` covers all three.

## Capability Gating

Hooks can require capabilities, the same model as bindings:

```json
{
  "hooks": {
    "save": {
      "description": "Fired during the save lifecycle.",
      "phases": ["pre", "post", "done", "error"],
      "capability": "persistence"
    }
  }
}
```

A script without the `persistence` capability cannot register handlers for this hook. Attempting to register throws a `CapabilityDeniedError`.

## Async Hooks

Hooks can be declared async, controlled by the host:

```json
{
  "hooks": {
    "dataSync": {
      "description": "Fired when data synchronization occurs.",
      "async": true
    }
  }
}
```

When `async` is true, handlers can use `await` and `fireHook` returns a Promise. The host must use the async runtime variant (`initXriptAsync` / async-capable `createRuntime`) for async hooks.

## Execution Limits

A hook or event fire runs under an execution budget: the script timeout, fresh for each fire and shared by the handlers that fire runs. A fire that overruns stops with the execution-limit error, whichever handler was running. Hooks can override the manifest-level limits:

```json
{
  "hooks": {
    "frameTick": {
      "description": "Fired every frame.",
      "limits": {
        "timeout_ms": 5
      }
    }
  }
}
```

Per-hook limits are useful when different hooks have different performance requirements. A frame tick handler needs a tight timeout; a save handler can take longer.

An event slot declares its budget the same way, in the slot's own `limits`. A fire's budget is the hook's or slot's `limits.timeout_ms` where it declares one and the manifest's `timeout_ms` otherwise, clamped by the embedder's hard limit either way; no other slot's budget enters into it. An event slot's fills are calls into that slot's fills, so each runs under the slot's budget too (see [execution.md](./execution.md)).

Where the runtimes stand:

| Runtime | Fire budget | A hook's or event slot's own `limits.timeout_ms` |
|---------|-------------|----------------------------------|
| `@xriptjs/runtime`, `@xriptjs/runtime-node` | opt-in: create the runtime with `budgetHandlers: true`. Without it handlers run unbudgeted, and the first handler to run past the script timeout raises the `unbudgeted-handler` deprecation (see [deprecations.md](./deprecations.md)) | honoured |
| `xript-runtime` (Rust) | always | honoured |
| `Xript.Runtime` (C#) | always | honoured |

## Error Handling

### Handler Errors

When a hook handler throws an error, the runtime:

1. Catches the error
2. Wraps it in a `HookError` with the hook name and phase
3. Logs it via the host console
4. Continues executing remaining handlers

One handler's error does not prevent other handlers from running. The `fireHook` return value includes results from successful handlers; failed handlers contribute `undefined`.

The fire itself can still fail, and then the host hears about it rather than getting an empty result. Hook data or an event payload that cannot cross into the sandbox, such as a retained callback the host already released, fails the fire with the callback error (reason `released`) before any handler runs. A fire stopped by its budget fails with the execution-limit error. Every runtime surfaces both; `spec/callback-tests.json` pins the first.

**Commands do the opposite, deliberately.** Swallowing an error is right for a fire-and-forget lifecycle notification and wrong for a user-triggered action, so a failing command handler propagates its error to the caller rather than contributing `undefined`. See [commands.md](./commands.md#invocation).

### Error Types

| Error | When Thrown |
|-------|------------|
| `HookError` | A handler failed during execution |
| `CapabilityDeniedError` | Registration attempted without the required capability |

## Hook Granularity

Filtering and scoping are the host's responsibility, not the hook system's. Instead of one `save` hook with filter parameters, hosts should expose granular hooks when distinction matters:

```json
{
  "hooks": {
    "save": { "description": "Any save operation.", "phases": ["pre", "post", "done", "error"] },
    "autosave": { "description": "Automatic background saves.", "phases": ["pre", "post", "done"] },
    "manualSave": { "description": "Player-initiated saves.", "phases": ["pre", "post", "done", "error"] }
  }
}
```

Scripts register for what they care about. The host controls granularity by how many hooks it exposes.

## Naming Conventions

Hook names should follow the same conventions as binding names:

- camelCase (`playerDamage`, `onSave`, `frameTick`)
- Noun or event-oriented (`playerDamage`, `levelComplete`, `inventoryChange`)
- Not verbs unless describing an action (`save`, `load` are fine as they describe the operation the hook wraps)

## Manifest-to-TypeScript Mapping

The typegen tool generates handler registration types from hooks:

### Simple hook:

```typescript
declare namespace hooks {
  function playerDamage(handler: (amount: number, source: string) => void): void;
}
```

### Phased hook:

```typescript
declare namespace hooks {
  namespace save {
    function pre(handler: (data: SaveData) => void): void;
    function done(handler: (data: SaveData) => void): void;
    function post(handler: (data: SaveData) => void): void;
    function error(handler: (data: SaveData) => void): void;
  }
}
```

### Async hook:

Async hooks wrap the handler return type in `Promise`:

```typescript
declare namespace hooks {
  function dataSync(handler: (payload: SyncPayload) => Promise<void>): void;
}
```

### Events:

An event's handler arguments come from its payload the way the runtimes deliver them: a payload type with declared fields becomes those fields, positionally, in declaration order; a primitive or array payload is one argument; no payload is none. `emit` and `emitAsync` still take the payload as one object.

```typescript
interface XriptEventArgs {
  "player.damaged": [amount: number, source: string];
  [id: `stat.${string}.changed`]: [instanceId: string, value: number];
}

declare namespace events {
  function on<K extends XriptEventId>(id: K, handler: (...args: XriptEventArgs[K]) => unknown, options?: XriptSubscribeOptions): XriptSubscription;
  function emit<K extends XriptModEventId>(id: K, data?: XriptEvents[K]): unknown[];
  function emitAsync<K extends XriptModEventId>(id: K, data?: XriptEvents[K]): Promise<unknown[]>;
}
```
