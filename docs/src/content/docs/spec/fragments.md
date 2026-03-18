---
title: Fragment Protocol
description: "The xript UI Fragment Protocol: host-declared slots, mod-contributed UI, and the sandbox fragment API."
---

import CodeTabs from '../../../components/CodeTabs.astro';

The fragment protocol extends xript with moddable UI. Hosts declare **slots** — mounting points in their interface. Mods declare **fragments** — UI contributions that target those slots. The runtime sanitizes fragment content, resolves data bindings, evaluates conditional visibility, and routes events through the sandbox.

## Slots

Hosts declare slots in their app manifest. Each slot is a named mounting point with format constraints and optional capability gating.

```json
{
  "slots": [
    {
      "id": "sidebar.left",
      "accepts": ["text/html"],
      "capability": "ui-mount",
      "multiple": true,
      "style": "isolated"
    }
  ]
}
```

### Slot Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Unique slot identifier (e.g. `sidebar.left`) |
| `accepts` | string[] | yes | — | MIME types this slot accepts |
| `capability` | string | no | — | Capability required to mount here |
| `multiple` | boolean | no | false | Allow multiple mod fragments |
| `style` | enum | no | `"inherit"` | Styling mode |

### Styling Modes

- **`inherit`** — Fragment inherits host styles. Good for inline UI like status bars.
- **`isolated`** — No host styles bleed in. Good for panels and overlays.
- **`scoped`** — Host exposes CSS custom properties; fragment uses them.

## Fragments

Mods declare fragments in their [mod manifest](/spec/mod-manifest/). Each fragment targets a slot, provides markup, and optionally declares data bindings and event handlers.

```json
{
  "fragments": [
    {
      "id": "health-panel",
      "slot": "sidebar.left",
      "format": "text/html",
      "source": "fragments/panel.html",
      "bindings": [
        { "name": "health", "path": "player.health.val" },
        { "name": "maxHealth", "path": "player.health.max" }
      ],
      "events": [
        { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
      ],
      "priority": 10
    }
  ]
}
```

### Inline Fragments (JSML)

For simple fragments, inline the markup:

```json
{
  "id": "status",
  "slot": "header.status",
  "format": "text/html",
  "source": "<span data-bind=\"health\">0</span> / <span data-bind=\"maxHealth\">0</span>",
  "inline": true,
  "bindings": [
    { "name": "health", "path": "player.health.val" },
    { "name": "maxHealth", "path": "player.health.max" }
  ]
}
```

## Data Binding: `data-bind`

The `data-bind` attribute wires host data into fragment markup. The runtime finds elements with `data-bind="<name>"` and sets their content to the resolved binding value.

```html
<p>Health: <span data-bind="health">0</span>/<span data-bind="maxHealth">0</span></p>
```

Attributes persist in the DOM for O(1) updates — supports 60fps game-loop speed without template re-parsing.

For text elements: sets `textContent`. For input elements: sets `value`.

## Conditional Visibility: `data-if`

The `data-if` attribute evaluates an expression against the binding context to control element visibility.

```html
<div data-if="health < 50" class="warning">You're hurting!</div>
<div data-if="health < 20" class="critical">Get to a healer!</div>
```

Expressions use the same safe evaluator that powers tier 1. Truthy = visible, falsy = hidden. Re-evaluates on binding change, skips when the boolean result hasn't changed.

### The Hard Wall

`data-bind` and `data-if` are the only two "smart" attributes the spec defines. No `data-each`, no `data-else`, no template language. Everything beyond binding and conditional visibility goes through the sandbox fragment API.

## Event Routing

Events are declared in the manifest, not the markup. The runtime attaches listeners and delegates to sandbox functions.

```json
"events": [
  { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
]
```

Multi-match is intentional: three `[data-action='heal']` buttons all wire to the same handler.

## Sandbox Fragment API

For logic beyond `data-bind` and `data-if`, mods use the sandbox fragment API with the command buffer pattern:

```javascript
hooks.fragment.update("health-panel", function (bindings, fragment) {
  fragment.toggle(".warning", bindings.health < 50);
  fragment.addClass(".bar", bindings.health < 20 ? "critical" : "normal");
  fragment.replaceChildren(".inventory-list",
    bindings.inventory.map(item => "<li>" + item.name + "</li>")
  );
});
```

The `fragment` proxy accumulates operations; the host applies them after the callback returns. No direct DOM access.

### Available Operations

| Method | Effect |
|--------|--------|
| `toggle(selector, condition)` | Show/hide matching elements |
| `addClass(selector, className)` | Add class to matching elements |
| `removeClass(selector, className)` | Remove class |
| `setText(selector, text)` | Set text content |
| `setAttr(selector, attr, value)` | Set attribute |
| `replaceChildren(selector, html)` | Replace children |

### Lifecycle Hooks

```javascript
hooks.fragment.mount("panel", (fragment) => { /* inserted into slot */ });
hooks.fragment.unmount("panel", (fragment) => { /* removed from slot */ });
hooks.fragment.update("panel", (bindings, fragment) => { /* data changed */ });
hooks.fragment.suspend("panel", (fragment) => { /* temporarily inactive */ });
hooks.fragment.resume("panel", (fragment) => { /* reactivated */ });
```

## HTML Sanitization

For `text/html` fragments, the runtime sanitizes content before the host sees it. The guarantee: what you're mounting is inert.

**Preserved:** structural/presentational elements, `class`, `id`, `data-*`, `aria-*`, `role`, scoped `<style>`, safe `src`/`href`.

**Stripped:** `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, all `on*` event attributes, `javascript:` URIs, document wrapper elements.

All runtime implementations must pass the [sanitizer conformance suite](https://github.com/nekoyoubi/xript/blob/main/spec/sanitizer-tests.json).

## Fragment Ordering

When multiple fragments target the same slot:

1. Sort by `priority` descending (higher renders first)
2. Break ties alphabetically by fragment `id`

## Security Model

Fragments are inert templates. All dynamic behavior routes through the sandbox:

- **Data display** → declared `data-bind` bindings
- **Conditional visibility** → declared `data-if` expressions
- **User interaction** → declared `events` → sandboxed handler functions
- **Complex mutations** → sandbox fragment API (command buffer)

No inline scripts. No inline event handlers. No embedded code survives sanitization.
