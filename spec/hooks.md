# xript Hook Conventions

Hooks are the reverse of bindings: the host fires them, and scripts handle them. Bindings let scripts call the host; hooks let the host call scripts. Together, they form a bidirectional communication channel between the application and its mods.

This document covers hook declaration, lifecycle phases, registration, invocation, and the runtime conventions that govern hook behavior.

## Declaration

Hooks are declared in the manifest's `hooks` section:

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

Every hook requires a `description`. Like bindings, if a modder can't understand what a hook does, it may as well not exist.

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
