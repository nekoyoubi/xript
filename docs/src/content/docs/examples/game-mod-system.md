---
title: "Example: Game Mod System"
description: A tier 3 integration walkthrough — namespaces, capabilities, async bindings, custom types, and execution limits.
---

This example demonstrates the full xript scripting model: namespaces to organize a rich API, capabilities at three risk levels, async bindings for I/O operations, custom types for complex data structures, and execution limits to prevent runaway scripts. This is **tier 3** adoption.

The full source is in [`examples/game-mod-system/`](https://github.com/nekoyoubi/xript/tree/main/examples/game-mod-system).

## The Manifest

The manifest declares a dungeon crawler modding API with four binding groups, three capabilities, and five custom types.

### Bindings

```json
{
  "bindings": {
    "log": {
      "description": "Writes a message to the mod console.",
      "params": [{ "name": "message", "type": "string" }]
    },
    "player": {
      "description": "Functions for reading and modifying the player character.",
      "members": {
        "getName":      { "returns": "string" },
        "getHealth":    { "returns": "number" },
        "getMaxHealth": { "returns": "number" },
        "getPosition":  { "returns": "Position" },
        "setHealth":    { "params": [...], "capability": "modify-player" },
        "getInventory": { "returns": { "array": "Item" } },
        "addItem":      { "params": [...], "capability": "modify-player" }
      }
    },
    "world": {
      "description": "Functions for querying the game world.",
      "members": {
        "getCurrentLevel": { "returns": "number" },
        "getEnemies":      { "returns": { "array": "Enemy" }, "async": true },
        "spawnEnemy":      { "params": [...], "capability": "modify-world" }
      }
    },
    "data": {
      "description": "Persistent data storage for mods.",
      "members": {
        "get": { "returns": { "optional": "string" }, "capability": "storage", "async": true },
        "set": { "capability": "storage", "async": true }
      }
    }
  }
}
```

Key observations:

- **Four binding groups**: `log` is flat (top-level), while `player`, `world`, and `data` are namespaces with members
- **Read operations are ungated**: `player.getHealth()`, `world.getCurrentLevel()`, `player.getInventory()` — any mod can read game state
- **Write operations require capabilities**: `player.setHealth()` needs `modify-player`, `world.spawnEnemy()` needs `modify-world`, `data.get()`/`data.set()` need `storage`
- **Async bindings**: `world.getEnemies()`, `data.get()`, and `data.set()` are asynchronous — mods use `await` to call them

### Capabilities

```json
{
  "capabilities": {
    "modify-player": { "description": "Modify the player's stats, inventory, and equipment.", "risk": "medium" },
    "modify-world":  { "description": "Spawn or remove entities in the game world.", "risk": "high" },
    "storage":       { "description": "Read and write persistent data for this mod.", "risk": "low" }
  }
}
```

Three risk levels demonstrate how a game might gate its API: reading persistent data is low-risk, changing the player is medium, and altering the world is high.

### Custom Types

```json
{
  "types": {
    "Position":  { "fields": { "x": { "type": "number" }, "y": { "type": "number" } } },
    "Item":      { "fields": { "id": {...}, "name": {...}, "type": { "type": "ItemType" }, "damage": {...}, "healing": {...} } },
    "Enemy":     { "fields": { "id": {...}, "type": { "type": "EnemyType" }, "health": {...}, "position": { "type": "Position" } } },
    "ItemType":  { "values": ["weapon", "armor", "consumable", "key", "quest"] },
    "EnemyType": { "values": ["skeleton", "goblin", "slime", "dragon", "mimic"] }
  }
}
```

Types describe the data structures modders will work with. They feed into `xript-typegen` (TypeScript definitions) and `xript-docgen` (API documentation) so modders get editor autocomplete and generated docs.

### Execution Limits

```json
{
  "limits": {
    "timeout_ms": 1000,
    "memory_mb": 32,
    "max_stack_depth": 128
  }
}
```

A 1-second timeout is appropriate for game mods that run per-frame or per-event. The runtime terminates any mod that exceeds these limits.

## The Host

The host simulates a dungeon crawler with in-memory game state:

```javascript
import { initXriptAsync } from "@xriptjs/runtime";

const xript = await initXriptAsync();
const runtime = await xript.createRuntime(manifest, {
  hostBindings: createHostBindings(),
  capabilities: ["modify-player", "storage"],
  console: { log: console.log, warn: console.warn, error: console.error },
});
```

The async factory (`initXriptAsync`) is required because the manifest has async bindings. Each mod gets its own runtime instance with a specific set of capabilities.

The host bindings map directly to the manifest structure:

```javascript
const hostBindings = {
  log: (message) => console.log(`[mod] ${message}`),
  player: {
    getName: () => gameState.player.name,
    getHealth: () => gameState.player.health,
    setHealth: (value) => {
      gameState.player.health = Math.max(0, Math.min(value, gameState.player.maxHealth));
    },
    getInventory: () => gameState.player.inventory.map((i) => ({ ...i })),
    addItem: (item) => { gameState.player.inventory.push({ ...item }); },
    // ...
  },
  world: {
    getEnemies: async () => gameState.world.enemies.map((e) => ({ ...e })),
    spawnEnemy: (type, position) => { /* add to enemy list */ },
    // ...
  },
  data: {
    get: async (key) => storage.get(key),
    set: async (key, value) => { storage.set(key, value); },
  },
};
```

Host bindings return copies (via spread operators) rather than direct references to game state, preventing mods from bypassing the API.

## The Demo Mods

The demo runs eight mods, each demonstrating different tier 3 features.

### 1. Healing Potion (modify-player)

Reads the player's health and restores it to max:

```javascript
const hp = player.getHealth();
const max = player.getMaxHealth();
player.setHealth(max);
```

Demonstrates sync read + capability-gated write within the `player` namespace.

### 2. Enemy Scout (no capabilities)

Queries enemies on the current level using an async binding:

```javascript
const enemies = await world.getEnemies();
for (const e of enemies) {
  log(e.type + " at (" + e.position.x + "," + e.position.y + ")");
}
```

Demonstrates async bindings and working with custom types (`Enemy`, `Position`).

### 3. Inventory Manager (modify-player)

Reads the inventory and adds a new item:

```javascript
const items = player.getInventory();
player.addItem({ id: "key-1", name: "Dungeon Key", type: "key" });
```

Demonstrates working with array returns and object parameters using custom types (`Item`, `ItemType`).

### 4. Save Checkpoint (storage)

Writes game state to persistent async storage:

```javascript
await data.set("checkpoint", hp + "|" + pos.x + "," + pos.y);
```

### 5. Load Checkpoint (storage)

Reads previously saved data back:

```javascript
const saved = await data.get("checkpoint");
```

Together, mods 4 and 5 demonstrate the async storage API with the `storage` capability.

### 6. Unauthorized World Mod (modify-player only)

Attempts to spawn an enemy without the `modify-world` capability:

```javascript
world.spawnEnemy("dragon", { x: 5, y: 5 });
// => CapabilityDeniedError: requires "modify-world"
```

The runtime blocks the call entirely — no partial execution, no side effects.

### 7. Authorized World Mod (modify-player + modify-world)

The same spawn call succeeds with the right capability:

```javascript
world.spawnEnemy("dragon", { x: 5, y: 5 });
// => succeeds
```

### 8. Infinite Loop (hits timeout)

A mod that runs forever, terminated by the 1000ms execution limit:

```javascript
while (true) {}
// => ERROR: interrupted
```

Demonstrates the runtime's denial-of-service protection.

## Running the Demo

```sh
cd examples/game-mod-system
node src/demo.js
```

## Concepts Demonstrated

| Concept | Where |
|---------|-------|
| Multiple namespaces | `player.*`, `world.*`, `data.*` |
| Three capability tiers | `storage` (low), `modify-player` (medium), `modify-world` (high) |
| Capability denial | Mod 6 vs Mod 7 |
| Async bindings | `world.getEnemies`, `data.get`, `data.set` |
| Custom object types | `Position`, `Item`, `Enemy` |
| Custom enum types | `ItemType`, `EnemyType` |
| Execution limits | Mod 8 hits the 1000ms timeout |
| Persistent storage | Mods 4 and 5 save/load data |
| Inline examples | The manifest includes usage examples on `player.setHealth` |

## When to Use This Pattern

Tier 3 is the right choice when:

- Your API surface is large enough to need **namespaces and capability tiers**
- Modders will write **multi-line scripts**, not just expressions
- You need **async operations** (database access, network calls, file I/O)
- You want **generated docs and types** that are always in sync with the API
- You need to enforce **execution limits** to protect the host application
