# Game Mod System

A **tier 3** xript example demonstrating the full scripting model: namespaces, capabilities at three risk levels, custom types, async bindings, persistent storage, and execution limits.

The host simulates a dungeon crawler where mods can read game state, heal the player, scout enemies, manage inventory, save/load persistent data, and even spawn enemies — all within a sandboxed environment with fine-grained capability gating.

## Running

```sh
cd examples/game-mod-system
node src/demo.js
```

## What the Demo Shows

1. **Healing Potion** — reads and modifies player health (requires `modify-player`)
2. **Enemy Scout** — queries enemies via async binding (no capabilities needed)
3. **Inventory Manager** — reads inventory and adds items (requires `modify-player`)
4. **Save Progress** — uses async persistent storage (requires `storage`)
5. **Unauthorized World Mod** — attempts to spawn an enemy without `modify-world` (denied)
6. **Authorized World Mod** — spawns an enemy with the right capability (succeeds)
7. **Infinite Loop** — triggers the 1000ms timeout execution limit

## Manifest Features

- **4 binding groups**: `log` (flat), `player` (namespace), `world` (namespace), `data` (namespace)
- **3 capabilities**: `storage` (low risk), `modify-player` (medium), `modify-world` (high)
- **5 custom types**: `Position`, `Item`, `Enemy`, `ItemType`, `EnemyType`
- **3 async bindings**: `world.getEnemies`, `data.get`, `data.set`
- **Execution limits**: 1000ms timeout, 32MB memory, 128 stack depth

See the [walkthrough on xript.dev](https://xript.dev/examples/game-mod-system) for a full explanation.
