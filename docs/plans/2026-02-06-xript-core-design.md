# xript Core Design

## Overview

xript is a platform specification for making any application moddable through JavaScript. It provides a sandboxed execution environment, a manifest-driven API surface, and tooling that generates types and documentation automatically.

The core promise: **eval, but safe.**

## Target Applications

Four projects drive the initial design:

| Project | Type | Extensibility Goal |
|---------|------|-------------------|
| echoes-to-come | Phaser JRPG | Replace internal scripting with xript; expose same system to modders |
| epixtory | Astro storytelling platform | Authors embed scripts in stories; readers are safe by default |
| brxi | Rust/Tauri window manager | Users build shareable "bricks" (custom components) |
| myaical | Rust/Tauri calendar/task manager | Plugin system for workflows and integrations |

## Design Principles

- **One sandbox model everywhere** — QuickJS compiled to WASM runs identically in browser and native
- **Code-first registration** — owners write TypeScript, tooling extracts the manifest
- **The manifest is the contract** — everything derives from it (types, docs, validation)
- **Secure by default, opt-in to power** — nothing exposed unless explicitly exposed
- **Conflict resolution is itself xript** — collisions are detected automatically, resolved via scripts

---

## Execution Model

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Host App      │────────▶│   xript Runtime  │────────▶│   Script        │
│  (Phaser/Rust)  │         │   (QuickJS WASM) │         │   (User JS)     │
└─────────────────┘         └──────────────────┘         └─────────────────┘
        │                            │                           │
        │  registers bindings        │  exposes bindings         │  calls bindings
        │  (timing.check, etc)       │  as global functions      │  (timing.check())
        └────────────────────────────┴───────────────────────────┘
```

1. Host app creates an xript runtime instance (QuickJS WASM)
2. Host registers bindings — functions and properties scripts can access
3. Runtime exposes bindings inside the sandbox as callable globals
4. Script executes real JavaScript, can call exposed functions, nothing else
5. Binding calls cross the boundary — runtime marshals calls to the host

**What scripts CAN do:**
- Call any exposed binding
- Use all standard JS: variables, functions, loops, conditionals, closures, async/await
- Import other scripts (if the host allows)

**What scripts CANNOT do:**
- Access anything not explicitly exposed
- Make network requests (unless exposed)
- Read files (unless exposed)
- Run forever (execution limits kill runaway scripts)

---

## Runtime Interface

What owners interact with in code:

```typescript
import { createRuntime } from '@xriptjs/runtime';

// 1. Create a sandbox
const runtime = await createRuntime();

// 2. Expose bindings
runtime.expose('timing.check', (meterId: string) => {
  return this.timingSystem.check(meterId);
});

runtime.expose('combat.fireDamage', {
  get: () => this.combat.fireMultiplier,
  set: (v: number) => this.combat.fireMultiplier = v
});

runtime.exposeNamespace('ui', {
  createButton: (opts) => this.uiManager.createButton(opts),
  createContainer: (opts) => this.uiManager.createContainer(opts),
});

// 3. Load a script
await runtime.load('./mods/fire-buff/main.js');

// 4. Or evaluate inline
const result = await runtime.eval(`
  combat.fireDamage = combat.fireDamage * 1.5;
`);
```

The runtime handles sandboxing, marshalling, execution limits, and conflict detection.

---

## Manifest Schema

The manifest is generated from code, consumed by tooling. Owners don't write it by hand.

```json
{
  "xript": "1.0",
  "id": "echoes-to-come",
  "name": "Echoes to Come",
  "version": "0.8.0",

  "namespaces": {
    "combat": {
      "description": "Battle system hooks",
      "bindings": {
        "fireDamage": {
          "type": "property",
          "valueType": "number",
          "access": "read-write",
          "description": "Base fire spell damage multiplier"
        },
        "calculateDamage": {
          "type": "function",
          "args": [
            { "name": "attacker", "type": "Entity" },
            { "name": "target", "type": "Entity" },
            { "name": "skill", "type": "Skill" }
          ],
          "returns": "DamageResult",
          "description": "Core damage calculation"
        }
      }
    }
  },

  "types": {
    "Entity": { "..." : "..." },
    "Skill": { "..." : "..." },
    "DamageResult": { "..." : "..." }
  }
}
```

**Generated from:**

```typescript
xript.expose('combat.fireDamage', {
  get: () => this.combat.fireMultiplier,
  set: (v: number) => this.combat.fireMultiplier = v,
  description: 'Base fire spell damage multiplier'
});

xript.expose('combat.calculateDamage', {
  fn: (attacker: Entity, target: Entity, skill: Skill): DamageResult => { ... },
  description: 'Core damage calculation'
});
```

**Produces:**
- TypeScript definitions for modder autocomplete
- Browsable API documentation
- Runtime validation rules

---

## Package Format

What a mod looks like as a distributable:

```
fire-buff/
├── xript.mod.json      # identity, permissions, conflict hints
├── main.js             # entry point
└── lib/                # optional additional scripts
```

**Mod manifest (`xript.mod.json`):**

```json
{
  "id": "fire-buff",
  "name": "Fire Buff",
  "version": "1.0.0",
  "author": "someplayer",
  "description": "Makes fire spells 50% stronger",

  "entry": "main.js",

  "requires": {
    "host": "echoes-to-come@>=0.8.0",
    "mods": []
  },

  "modifies": [
    { "target": "combat.fireDamage", "hint": "multiply" }
  ]
}
```

**Mod-pack structure:**

```
ultimate-balance-pack/
├── xript.mod.json
├── main.js              # loads child mods, applies config
├── mods/                # embedded or referenced mods
└── patches/
    └── combat-balance.js   # resolution script for conflicts
```

---

## Mod Ingress

How mods get into the system:

1. **Local files** — user downloads archive, extracts to `mods/` folder
2. **Workshop/registry** — platform-managed subscription model
3. **URL fetch** — paste a URL, app downloads and loads
4. **Mod-packs** — hierarchical loading with bundled mods and resolution layers

All ingress methods produce the same package format. The host's mod loader handles discovery and loading.

---

## Conflict Resolution Protocol

Conflicts are detected automatically and resolved via layered scripts.

**Step 1: Detection**

When mods load, xript compares `modifies` declarations:

```
fire-buff      modifies: combat.fireDamage (hint: multiply)
hard-mode      modifies: combat.fireDamage (hint: multiply)
```

Collision detected: both touch `combat.fireDamage`.

**Step 2: Draft Generation**

xript generates a resolution script:

```javascript
// AUTO-GENERATED: resolve combat.fireDamage
export function resolve_combat_fireDamage(modifications) {
  let value = 1.0;
  for (const mod of modifications) {
    if (mod.hint === 'multiply') value *= mod.value;
    if (mod.hint === 'set') value = mod.value;
    if (mod.hint === 'add') value += mod.value;
  }
  return value;
}
```

**Step 3: Customization**

Users or pack authors edit the draft:

```javascript
export function resolve_combat_fireDamage(modifications) {
  // Custom: average multipliers instead of stacking
  const multipliers = modifications.map(m => m.value);
  return multipliers.reduce((a, b) => a + b) / multipliers.length;
}
```

**Step 4: Promotion**

Once settled, the resolution script becomes a stable patch — versioned and frozen. Downstream users adding more mods get their own resolution layer on top.

**Layered resolution:**

```
Base Game
  └── Mod Pack (stable patch resolves internal conflicts)
        └── User's extra mods (auto-generated resolution layer)
              └── User customizes, settles their layer
```

Each layer only resolves its own conflicts. Lower layers are untouched.

---

## Capability Model

Permissions are implicit in what's exposed:

- **Secure by default** — scripts see nothing unless you expose it
- **Opt-in to power** — expose filesystem, network, or anything else if you choose
- **Transparent** — the manifest declares everything a script can access

For platforms like epixtory where user-generated scripts run in other users' browsers:
- The platform controls what's exposed
- Scripts can't escape the sandbox
- Capability badges (optional UX feature) can show "this story uses: audio, randomness"

---

## Tooling

| Tool | Input | Output |
|------|-------|--------|
| `xript extract` | Code with `expose()` calls | `manifest.json` |
| `xript generate types` | `manifest.json` | `types.d.ts` |
| `xript generate docs` | `manifest.json` | HTML/Markdown docs |
| `xript validate` | Mod package | Pass/fail with errors |
| `xript resolve` | Multiple mods | Draft resolution scripts |
| `xript pack` | Mod folder | Distributable archive |

Optional: **Playground** — web-based REPL for modders to experiment with the API interactively.

---

## Platform-Specific Considerations

### epixtory (Storytelling Platform)

Authors interact with scripting at three levels:

1. **Invisible** — visual editor generates xript, author never sees code
2. **Assisted** — AI generates xript from natural language, author reviews
3. **Direct** — author writes JavaScript in a code panel

All three produce the same artifact. The platform exposes UI primitives (containers, buttons, progress bars, canvas) so authors can build minigames and interactive elements.

### echoes-to-come (Game)

xript replaces the existing string-based scripting system. The game is built with xript internally; modders use the same system. This ensures the modding API is battle-tested by the game's own development.

### brxi (Window Manager)

"Bricks" are xript packages that define custom components. The difference between out-of-the-box and community bricks should feel like "how did I ever live without this?"

---

## Open Questions

- **Hot reload** — can scripts be reloaded without restarting the host?
- **Debugging** — how do modders debug scripts running inside the sandbox?
- **Versioning** — how do manifest versions evolve without breaking mods?
- **Performance profiling** — how do owners identify slow scripts?
- **Async boundaries** — how do long-running async operations work across the sandbox boundary?

---

## Next Steps

1. Build the QuickJS WASM runtime wrapper (`@xriptjs/runtime`)
2. Implement `expose()` API and manifest extraction
3. Build type generator from manifest
4. Create a minimal proof-of-concept in one target app (likely epixtory or efx)
5. Iterate based on real usage
