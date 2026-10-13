---
title: "UI Dashboard"
description: "A dashboard application demonstrating the xript UI Fragment Protocol with slots, mod manifests, data-bind, data-if, data-each, and the sandbox fragment API."
---

The full fragment protocol in one shot: an app declares slots, mods fill them with fragments, and everything binds to live host data.

A fragment is a *fill* of a fragment-format slot, not a separate top-level mod concept. Mods contribute through a single `fills` object keyed by host slot id; a fragment fill carries markup, declared data bindings, and DOM event handlers. (The former top-level `fragments[]`/`contributions` shape still validates with a deprecation warning, but `fills` is the canonical surface.)

## What It Shows

- **Host app** with three slots (`sidebar.left`, `header.status`, `main.overlay`)
- **Health panel mod** that `fills` a slot, using `data-bind` for values and `data-if` for conditional warnings
- **Inventory panel mod** that renders a keyed list with `data-each`, and ships no script at all
- **Fragment lifecycle** with `hooks.fragment.update` handlers
- **Cross-validation** ensuring each fill targets a valid slot, matches its `accepts` format, and (when the slot declares a `payload`) satisfies the slot's payload schema

## Running the Demo

```bash
node examples/ui-dashboard/src/demo.js
```

The demo loads two mods, simulates game state changes (health decreasing, items being added), and prints the fragment HTML at each step.

## App Manifest

The host declares three slots:

```json
{
  "slots": [
    {
      "id": "sidebar.left",
      "accepts": ["text/html"],
      "multiple": true,
      "style": "isolated"
    },
    {
      "id": "header.status",
      "accepts": ["text/html"],
      "multiple": false,
      "style": "inherit"
    },
    {
      "id": "main.overlay",
      "accepts": ["text/html"],
      "capability": "ui-mount",
      "multiple": true,
      "style": "scoped"
    }
  ]
}
```

Each slot's `accepts` names the fragment formats it takes (`text/html`, `text/html+jsml`, `application/jsml+json`). A slot may also declare a `payload` (a full JSON Schema describing exactly what a valid fill looks like) and a `reserved` flag for surface declared ahead of any filler. The `style` modes (`inherit`, `isolated`, `scoped`) control how host styles reach the mounted fragment.

## Health Panel Mod — Filling a Slot

The health-panel mod declares which slot it fills via its `fills` object, keyed by host slot id:

```json
{
  "name": "health-panel",
  "version": "1.0.0",
  "capabilities": ["ui-mount"],
  "entry": "src/mod.js",
  "fills": {
    "sidebar.left": [
      {
        "id": "health-display",
        "format": "text/html",
        "source": "fragments/panel.html",
        "bindings": [
          { "name": "health", "path": "player.health" },
          { "name": "maxHealth", "path": "player.maxHealth" },
          { "name": "name", "path": "player.name" }
        ],
        "priority": 10
      }
    ]
  }
}
```

A fill can also declare a `handlers` array (entries shaped `{ selector, on, handler }`) to wire DOM events to sandbox functions. (`events` is a deprecated alias for `handlers`; if both are present, `handlers` wins.) The DOM-handler `handlers` array is distinct from a host's top-level `events` catalog: bindings are what you call, slots and handlers are what handles, `events` is what the host emits.

## Health Panel Fragment

The fragment uses `data-bind` to display values and `data-if` for conditional warnings:

```html
<div class="health-panel">
  <div class="player-name" data-bind="name">Unknown</div>
  <div class="health-bar">
    <span data-bind="health">0</span>/<span data-bind="maxHealth">0</span>
  </div>
  <div data-if="health < 50" class="warning">Low health!</div>
  <div data-if="health < 20" class="critical">Critical — find a healer!</div>
</div>
```

The mod script uses the sandbox fragment API for more complex updates:

```javascript
hooks.fragment.update("health-display", function (bindings, fragment) {
  var pct = (bindings.health / bindings.maxHealth) * 100;
  var color = pct > 60 ? "green" : pct > 30 ? "yellow" : "red";
  fragment.setAttr(".health-bar", "data-color", color);
  fragment.toggle(".warning", bindings.health < 50);
  fragment.toggle(".critical", bindings.health < 20);
});
```

## Inventory Panel: a Keyed List

A list is presentation, so it lives in the template. `data-each` renders the `li` once per inventory item, and `data-key` names each copy so an update patches the list instead of replacing it:

```html
<div class="inventory-panel">
  <div class="panel-title"><span data-bind="playerName">Player</span>'s Inventory</div>
  <ul class="item-list">
    <li data-each="item in inventory" data-key="item.name">{{ item.name }} (x{{ item.count }})</li>
  </ul>
  <div data-if="len(inventory) == 0" class="empty-message">No items yet.</div>
</div>
```

The fill declares `inventory` as a binding and turns on `interpolate`. There is no entry script: nothing about rendering a list needs the sandbox. Each result carries a `repeats` entry describing the expansion; when a new item arrives, its `patch` reads `reuse "Iron Sword", reuse "Health Potion", insert "Magic Shield"`, so a host that keeps its DOM nodes alive inserts one `li` and touches nothing else.

## Loading Mods

The host loads mods using `runtime.loadMod()`, passing the mod manifest (with its `fills`) and the file sources it references:

```javascript
const healthMod = runtime.loadMod(modManifest, {
  fragmentSources: {
    "fragments/panel.html": panelHtml,
    "src/mod.js": modScript,
  },
});
```

Fragment sources are provided as a `Record<string, string>`; the runtime sanitizes them on load, cross-validates each fill against the host's slots, and resolves the fills into the slots they key.

## What Happens at Each Step

1. **Full health (80/100):** `data-if="health < 50"` evaluates to `false`, so warnings stay hidden. The fragment API sets color to green.
2. **After damage (40/100):** `data-if="health < 50"` flips to `true`, so the warning shows. Color becomes yellow.
3. **Critical (15/100):** both warnings visible, color becomes red, and a new item appears in inventory as a keyed `insert`.

See the [source code](https://github.com/nekoyoubi/xript/tree/main/examples/ui-dashboard) for the complete example.
