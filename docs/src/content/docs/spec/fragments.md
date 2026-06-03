---
title: Fragment Protocol
description: "The xript UI Fragment Protocol: the fragment-format slot, mod fills, and the sandbox fragment API."
---

import CodeTabs from '../../../components/CodeTabs.astro';

The fragment protocol governs the **fragment-format slot** — a [slot](/spec/manifest/#slots) whose `accepts` type is a fragment format like `text/html+jsml`. The host declares the slot; a mod fills it with inert UI. The runtime sanitizes fragment content, resolves data bindings, evaluates conditional visibility, and routes events through the sandbox. A fragment is a fill of this slot type; everything below describes that fill's shape and lifecycle.

## Slots

Hosts declare slots in their app manifest. A fragment-format slot is a named mounting point whose `accepts` type names a fragment format, with optional capability gating.

```json
{
  "slots": [
    {
      "id": "sidebar.left",
      "accepts": ["text/html+jsml"],
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
| `accepts` | string[] | yes | — | Fragment format(s) this slot accepts |
| `capability` | string | no | — | Capability required to mount here |
| `multiple` | boolean | no | false | Allow multiple mod fragments |
| `style` | enum | no | `"inherit"` | Styling mode |

### Styling Modes

- **`inherit`** — fragment inherits host styles; good for inline UI like status bars
- **`isolated`** — no host styles bleed in; good for panels and overlays
- **`scoped`** — host exposes CSS custom properties; the fragment uses them

## Fragment Fills

Mods fill a fragment-format slot through the `fills` surface of their [mod manifest](/spec/mod-manifest/), keyed by the slot id. Each fill provides markup and optionally declares data bindings and event handlers.

```json
{
  "fills": {
    "sidebar.left": [
      {
        "format": "text/html+jsml",
        "source": "fragments/panel.html",
        "bindings": [
          { "name": "health", "path": "player.health.val" },
          { "name": "maxHealth", "path": "player.health.max" }
        ],
        "handlers": [
          { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
        ],
        "priority": 10
      }
    ]
  }
}
```

### Inline Fragments (JSML)

For simple fragments, inline the markup:

```json
{
  "fills": {
    "header.status": [
      {
        "format": "text/html+jsml",
        "source": "<span data-bind=\"health\">0</span> / <span data-bind=\"maxHealth\">0</span>",
        "inline": true,
        "bindings": [
          { "name": "health", "path": "player.health.val" },
          { "name": "maxHealth", "path": "player.health.max" }
        ]
      }
    ]
  }
}
```

## Data Binding: `data-bind`

The `data-bind` attribute wires host data into fragment markup. The runtime finds elements with `data-bind="<name>"` and sets their content to the resolved binding value.

```html
<p>Health: <span data-bind="health">0</span>/<span data-bind="maxHealth">0</span></p>
```

Attributes persist in the DOM, so updates stay O(1). That holds 60fps game-loop speed without re-parsing the template every frame.

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

## Event Handlers

DOM event handlers are declared in the manifest, not the markup. The runtime attaches listeners and delegates to sandbox functions. Each entry pairs a `selector`, the DOM event to listen for (`on`), and the sandbox `handler` to call.

```json
"handlers": [
  { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
]
```

Multi-match is intentional: three `[data-action='heal']` buttons all wire to the same handler.

:::note[The field is `handlers` — `events` is a deprecated alias]
This array used to be called `events`, but its entries are event *handlers*, not events; the old name was simply wrong. The field is now `handlers`. Readers still accept `events` as a deprecated alias for back-compat, mirroring the standalone-`hooks` to event-slot precedent. If a fill carries both, `handlers` wins; if it carries only `events`, that is honored with a deprecation warning. New fills should use `handlers`. Migrate by renaming the key; the entry shape is unchanged.

This is distinct from the top-level [`events` catalog](/spec/manifest/#events), which declares what the *host* broadcasts. A fragment's `handlers` are DOM responses wired on a fill; the catalog is a discovery declaration of host-emitted events. Same word, opposite directions.
:::

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

**Stripped:** `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, all `on*` event attributes, `javascript:`/`vbscript:` URIs, document wrapper elements.

`data:` URIs are stripped from `href` and `src`, with one narrow exception: `data:image/png`, `data:image/jpeg`, `data:image/gif`, and `data:image/svg+xml` are allowed in `src` only — the scheme is gated by subtype so a `data:text/html` payload can never slip through.

All runtime implementations must pass the [sanitizer conformance suite](https://github.com/nekoyoubi/xript/blob/main/spec/sanitizer-tests.json).

## Fragment Ordering

When multiple fills target the same slot:

1. Sort by `priority` descending (higher renders first)
2. Break ties alphabetically by mod name

## Cross-Validation

When a mod loads against a host, the runtime validates each fragment fill:

1. The fill keys to a slot that exists in the app manifest
2. The fill's `format` is in the target slot's `accepts` list
3. If the slot gates on a capability, the mod must declare it
4. If the slot is `multiple: false`, only the deterministic winner resolves (highest `priority`, ties broken by fill `id`)

A slot's `payload` carries a full JSON Schema, so a slot can describe exactly what a valid fill looks like — nested `required`, patterns, the lot. `cross-validate` checks each fill's payload against that schema. It applies the schema as authored: a fill carrying more than the payload declares still passes unless the slot explicitly closes its payload. The check is on by default; pass `--no-fill-payloads` on the CLI (or `checkFillPayloads: false` to the library and MCP tool) to skip it and check only slot existence, accepted formats, and gates.

## Security Model

Fragments are inert templates. All dynamic behavior routes through the sandbox:

- **Data display** → declared `data-bind` bindings
- **Conditional visibility** → declared `data-if` expressions
- **User interaction** → declared `handlers` → sandboxed handler functions
- **Complex mutations** → sandbox fragment API (command buffer)

No inline scripts. No inline event handlers. No embedded code survives sanitization.
