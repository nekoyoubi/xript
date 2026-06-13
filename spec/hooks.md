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

## Event Delivery

Hook dispatch and the top-level [`events` broadcast catalog](./manifest.md#events-host-broadcast-catalog) are two faces of **one dispatch engine**: a keyed handler registry plus a fire-from-registry pass. The `hooks` global, the `__xript_hook_handlers` registry, and `fireHook` already *are* an event bus, merely keyed off `manifest.hooks`. The `events` catalog rides that same machinery rather than introducing a parallel event subsystem — the least new vocabulary is one subscribe verb, one host method, and one optional schema field.

### Subscription (script side)

Alongside the `hooks` global, the runtime injects an `events` global. A mod subscribes by event id:

```javascript
events.on("player.damaged", (event) => {
  log(`took ${event.amount} damage`);
});

events.subscribe("level.loaded", () => { /* alias of events.on */ });
```

The call pushes the handler into a registry keyed by event id (`__xript_event_handlers["<id>"]`), preserving registration order — exactly like `hooks.<name>(fn)` pushes into `__xript_hook_handlers`. Multiple handlers per event id run in registration order.

### Delivery (host side)

The host emits with `emit`, the sibling of `fireHook`:

```javascript
const results = runtime.emit("player.damaged", { amount: 25, source: "trap" });
```

`emit` resolves the event id in the `events` catalog, looks up `__xript_event_handlers[id]`, and invokes each handler — an object payload spreads to positional arguments per the event's declared `payload` shape, otherwise the payload is passed as a single argument. Results are collected in registration order; a handler that throws contributes `undefined` and does not stop the others. This is byte-for-byte the `fireHook` fan-out contract.

### Subscription capability gate

An event may declare a `capability` that gates subscription, reusing the hook gate model:

```json
{
  "events": [
    {
      "id": "world.changed",
      "description": "Broadcast when world terrain mutates.",
      "capability": "read:world"
    }
  ]
}
```

`events.on` checks the event's declared `capability` against the granted set via `grantedSatisfies` (mode-lattice + prefix-subsumption — see [Capability Model](./capabilities.md#hierarchical-capabilities)) before admitting the handler. A subscription denied for lack of capability throws a `CapabilityDeniedError` at registration time. An event with no `capability` admits any subscriber.

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

Each hook handler invocation gets its own execution budget by default. Hooks can override the manifest-level limits:

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

## Error Handling

### Handler Errors

When a hook handler throws an error, the runtime:

1. Catches the error
2. Wraps it in a `HookError` with the hook name and phase
3. Logs it via the host console
4. Continues executing remaining handlers

One handler's error does not prevent other handlers from running. The `fireHook` return value includes results from successful handlers; failed handlers contribute `undefined`.

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
    "save": { "description": "Any save operation.", "phases": ["pre", "on", "post", "error"] },
    "autosave": { "description": "Automatic background saves.", "phases": ["pre", "post", "done"] },
    "manualSave": { "description": "Player-initiated saves.", "phases": ["pre", "on", "post", "error"] }
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
