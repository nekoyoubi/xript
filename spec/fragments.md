# Fragment Protocol

The fragment protocol extends xript with moddable UI. Hosts declare **slots** — mounting points in their interface. Mods declare **fragments** — UI contributions that target those slots. The runtime sanitizes fragment content, resolves data bindings, evaluates conditional visibility, and routes events through the sandbox.

## Mod Manifests

A mod manifest is a JSON file declaring what a mod provides and what it needs. It is distinct from the app manifest — the app manifest describes what the host exposes; the mod manifest describes what the mod contributes.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `xript` | string | Spec version this mod targets (e.g. `"0.3"`) |
| `name` | string | Machine-readable identifier (`^[a-z][a-z0-9-]*$`, max 64 chars) |
| `version` | string | Mod version (semver) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Human-readable display name |
| `description` | string | Brief description for users |
| `author` | string | Author name or handle |
| `capabilities` | string[] | Capabilities this mod requires from the host |
| `entry` | string \| string[] | Script entry point(s) relative to mod root |
| `fragments` | Fragment[] | UI fragment contributions |

The schema lives at `spec/mod-manifest.schema.json`.

## Slots

Hosts declare slots in their app manifest under the `slots` array. Each slot is a named mounting point with format constraints and optional capability gating.

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
| `id` | string | yes | — | Unique slot identifier (`^[a-z][a-z0-9.-]*$`) |
| `accepts` | string[] | yes | — | MIME types this slot accepts |
| `capability` | string | no | — | Capability required to mount into this slot |
| `multiple` | boolean | no | false | Whether multiple mods can contribute to this slot |
| `style` | enum | no | "inherit" | Styling mode (see below) |

### Styling Modes

- **`inherit`** — Fragment inherits host styles. Suitable for inline UI like status bars.
- **`isolated`** — No host styles bleed into the fragment. Suitable for panels and overlays. On the web, implemented via Shadow DOM or equivalent.
- **`scoped`** — Host exposes CSS custom properties / design tokens; fragment uses them. Best of both worlds.

## Fragments

Mods declare fragments in their mod manifest under the `fragments` array. Each fragment targets a slot, provides markup, and optionally declares data bindings and event handlers.

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

### Fragment Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Unique fragment ID within the mod |
| `slot` | string | yes | — | Target slot ID from the host's manifest |
| `format` | string | yes | — | MIME type of the fragment content |
| `source` | string | yes | — | File path (relative to mod root) or inline markup |
| `inline` | boolean | no | false | When true, `source` is inline markup (JSML) |
| `bindings` | Binding[] | no | — | Data bindings |
| `events` | Event[] | no | — | Event handlers |
| `priority` | integer | no | 0 | Ordering within the slot (higher = earlier) |

### Inline Fragments (JSML)

For simple fragments, the source can be inline markup:

```json
{
  "id": "status-text",
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

### Fragment Ordering

When multiple fragments target the same slot (requires `multiple: true`):

1. Sort by `priority` descending (higher values render first)
2. Break ties alphabetically by fragment `id`

Hosts can override this ordering via user preferences.

## Data Binding: `data-bind`

The `data-bind` attribute is the mechanism for wiring host data into fragment markup. The runtime finds elements with `data-bind="<name>"` and sets their content to the resolved binding value.

```html
<p>Health: <span data-bind="health">0</span>/<span data-bind="maxHealth">0</span></p>
```

### Resolution

1. The fragment declares bindings mapping local names to host data paths
2. The runtime resolves each path against the host's data layer (e.g. `"player.health.val"` → traverse `data.player.health.val`)
3. For text elements (`span`, `div`, `p`, etc.): the runtime sets `textContent`
4. For input elements (`input`, `textarea`, `select`): the runtime sets `value`
5. On data change, the runtime re-resolves only changed bindings and patches the affected elements

### Performance

`data-bind` attributes persist in the DOM. The runtime maintains a map of attribute → element references for O(1) updates. This supports 60fps update rates for game-loop-driven UI without template re-parsing or diffing.

### Two-Way Binding

For input elements, the runtime can both push values (host → fragment) and listen for changes (fragment → host). Write-back is explicit: use the `events` array to declare handlers for `input` or `change` events on bound elements.

## Conditional Visibility: `data-if`

The `data-if` attribute evaluates an expression against the binding context to control element visibility.

```html
<div data-if="health < 50" class="warning">You're hurting!</div>
<div data-if="health < 20" class="critical">Get to a healer!</div>
```

### Evaluation

1. The runtime extracts the expression string from `data-if`
2. The expression is evaluated using the same safe evaluator that powers tier 1 (no `eval`, no `Function`, no code generation — the sandboxed expression engine)
3. Binding values are injected as variables in the expression context
4. Truthy result → element is visible. Falsy → element is hidden (via `display: none` or DOM removal, host's choice)
5. On binding change, the runtime re-evaluates and toggles only if the boolean result changed

### Hard Wall

`data-bind` and `data-if` are the only two "smart" attributes the spec defines. No `data-each`, no `data-else`, no template language constructs. Everything beyond binding and conditional visibility goes through the sandbox fragment API.

## Event Routing

Events are declared in the fragment manifest, not in the markup. The runtime attaches listeners to matching elements and delegates to sandbox functions.

```json
"events": [
  { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
]
```

### How It Works

1. After mounting the fragment, the runtime queries elements matching each event's `selector`
2. For each match, the runtime attaches a listener for the specified `on` event
3. When the event fires, the runtime calls the named `handler` function in the mod's sandboxed script
4. The handler receives event data (target element info, event type)
5. Multi-match is intentional: `[data-action='heal']` matching three buttons wires all three to the same handler

### Format-Specific Targeting

For `text/html` fragments, `selector` is a CSS selector. For other formats, the targeting mechanism is defined by the format (e.g. widget IDs for terminal UI formats).

## Fragment Lifecycle

Fragments have five lifecycle events, consistent with xript's existing hook vocabulary:

| Lifecycle | When | Typical Use |
|-----------|------|-------------|
| `mount` | Fragment inserted into slot, bindings resolved | Initialize state, set up timers |
| `unmount` | Fragment removed from slot | Cleanup, release resources |
| `update` | Bound data changed | Reflect new state, complex updates |
| `suspend` | Host context changed (e.g. scene transition) | Pause timers, reduce activity |
| `resume` | Fragment reactivated after suspend | Resume timers, refresh state |

The host fires lifecycle events via the runtime. Mods register handlers through the sandbox fragment API.

## Sandbox Fragment API

For logic beyond `data-bind` and `data-if`, mods use the sandbox fragment API. This provides imperative fragment manipulation from within the sandboxed script.

```javascript
hooks.fragment.update("health-panel", (bindings, fragment) => {
  fragment.toggle(".low-health-warning", bindings.health < 50);
  fragment.addClass(".health-bar", bindings.health < 20 ? "critical" : "normal");
  fragment.replaceChildren(".inventory-list",
    bindings.inventory.map(item => `<li>${item.name} (x${item.count})</li>`)
  );
});
```

### Command Buffer Pattern

The `fragment` object passed to callbacks is a proxy, not a live DOM reference. Method calls accumulate an operation list (command buffer). After the callback returns, the runtime passes the operation list to the host, which applies the mutations. The sandbox never touches the real DOM.

### Available Operations

| Method | Arguments | Effect |
|--------|-----------|--------|
| `toggle(selector, condition)` | CSS selector, boolean | Show/hide matching elements |
| `addClass(selector, className)` | CSS selector, string | Add class to matching elements |
| `removeClass(selector, className)` | CSS selector, string | Remove class from matching elements |
| `setText(selector, text)` | CSS selector, string | Set text content of matching elements |
| `setAttr(selector, attr, value)` | CSS selector, string, string | Set attribute on matching elements |
| `replaceChildren(selector, html)` | CSS selector, string/string[] | Replace children of matching elements |

### Lifecycle Registration

```javascript
hooks.fragment.mount("health-panel", (fragment) => { /* called on mount */ });
hooks.fragment.unmount("health-panel", (fragment) => { /* called on unmount */ });
hooks.fragment.update("health-panel", (bindings, fragment) => { /* called on data change */ });
hooks.fragment.suspend("health-panel", (fragment) => { /* called on suspend */ });
hooks.fragment.resume("health-panel", (fragment) => { /* called on resume */ });
```

## HTML Sanitization

For `text/html` fragments, the runtime sanitizes content before the host ever sees it. The guarantee to hosts: what you're mounting is inert.

### Allowed Elements

Structural and presentational elements: `div`, `span`, `p`, `h1`-`h6`, `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `table`, `thead`, `tbody`, `tfoot`, `tr`, `td`, `th`, `caption`, `col`, `colgroup`, `figure`, `figcaption`, `blockquote`, `pre`, `code`, `em`, `strong`, `b`, `i`, `u`, `s`, `small`, `sub`, `sup`, `br`, `hr`, `img`, `picture`, `source`, `audio`, `video`, `track`, `details`, `summary`, `section`, `article`, `aside`, `nav`, `header`, `footer`, `main`, `a`, `abbr`, `mark`, `time`, `wbr`, `style` (scoped).

### Stripped Elements

Removed entirely (element and all children): `script`, `iframe`, `object`, `embed`, `form`, `base`, `link`, `meta`, `title`, `html`, `head`, `body`, `noscript`, `applet`, `frame`, `frameset`.

### Allowed Attributes

`class`, `id`, `data-*`, `aria-*`, `role`, `style`, `src` (safe URIs only), `alt`, `width`, `height`, `href` (safe URIs only), `target`, `rel`, `colspan`, `rowspan`, `scope`, `headers`, `lang`, `dir`, `title`, `tabindex`, `hidden`.

### Stripped Attributes

All `on*` event attributes (`onclick`, `onerror`, `onload`, etc.), `formaction`, `action`, `method`, `enctype`.

### URI Sanitization

`javascript:`, `vbscript:`, and `data:` URIs are stripped from `href` and `src` attributes. Exception: `data:image/png`, `data:image/jpeg`, `data:image/gif`, and `data:image/svg+xml` are allowed in `src` attributes only.

### Style Sanitization

Within `<style>` blocks and `style` attributes: `url()` references, `expression()`, `-moz-binding`, and `behavior:` are stripped.

### Conformance

All runtime implementations must produce identical sanitized output for the same input. The conformance test suite at `spec/sanitizer-tests.json` defines the canonical input/output pairs.

## Security Model

Fragments are inert templates. They carry structure and style. All dynamic behavior routes through systems the runtime already controls:

1. **Data display** goes through declared `data-bind` bindings
2. **Conditional visibility** goes through declared `data-if` expressions evaluated by the sandboxed expression engine
3. **User interaction** goes through declared `events` → sandboxed handler functions
4. **Complex mutations** go through the sandbox fragment API (command buffer, never direct DOM access)

No inline scripts. No inline event handlers. No embedded code of any kind survives sanitization. The fragment is a skeleton; the sandbox is the muscle.

## Cross-Validation

When a mod is loaded against a host application, the runtime validates:

1. Every fragment targets a slot that exists in the app manifest
2. Every fragment's format is in the target slot's `accepts` list
3. If the slot requires a capability, the mod must have that capability granted
4. If the slot has `multiple: false`, only one fragment can be mounted (first-come, first-served)
