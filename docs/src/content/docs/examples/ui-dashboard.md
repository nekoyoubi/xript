---
title: "UI Dashboard"
description: "A dashboard application demonstrating the xript UI Fragment Protocol with slots, mod manifests, data-bind, data-if, and the sandbox fragment API."
---

The full fragment protocol in one shot: an app declares slots, mods contribute fragments, and everything binds to live host data.

## What It Shows

- **Host app** with three slots (`sidebar.left`, `header.status`, `main.overlay`)
- **Health panel mod** using `data-bind` for values and `data-if` for conditional warnings
- **Inventory panel mod** using the sandbox fragment API for iteration
- **Fragment lifecycle** with `hooks.fragment.update` handlers
- **Cross-validation** ensuring mods target valid slots

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

## Inventory Panel — Sandbox Iteration

Since `data-bind` handles values and `data-if` handles visibility, iteration over arrays uses the sandbox fragment API:

```javascript
hooks.fragment.update("inventory-list", function (bindings, fragment) {
  var items = bindings.inventory || [];
  var html = items.map(function (item) {
    return "<li>" + item.name + " (x" + item.count + ")</li>";
  });
  fragment.replaceChildren(".item-list", html);
  fragment.toggle(".empty-message", items.length === 0);
});
```

## Loading Mods

The host loads mods using `runtime.loadMod()`:

```javascript
const healthMod = runtime.loadMod(modManifest, {
  fragmentSources: {
    "fragments/panel.html": panelHtml,
    "src/mod.js": modScript,
  },
});
```

Fragment sources are provided as a `Record<string, string>`; the runtime sanitizes them on load.

## What Happens at Each Step

1. **Full health (80/100):** `data-if="health < 50"` evaluates to `false` — warnings hidden. Fragment API sets color to green.
2. **After damage (40/100):** `data-if="health < 50"` flips to `true` — warning shows. Color becomes yellow.
3. **Critical (15/100):** Both warnings visible. Color becomes red. New item appears in inventory via `replaceChildren`.

See the [source code](https://github.com/nekoyoubi/xript/tree/main/examples/ui-dashboard) for the complete example.
