# Fragment Protocol

The fragment protocol is the semantics of one slot type: the **fragment-format slot**. A host declares a slot whose `accepts` names a fragment format (`text/html+jsml`, `application/jsml+json`, `text/html`); a mod fills it with an inert fragment — markup plus declared data bindings and DOM event handlers. A fragment is a fill of a fragment-format slot; it is not a separate top-level mod concept. The runtime sanitizes fragment content, resolves data bindings, evaluates conditional visibility, and routes events through the sandbox.

See [mod-manifest.md](./mod-manifest.md) for the `fills` surface and the other slot types (code-renderer, role, event), and [manifest.md](./manifest.md) for how a host declares slots and their `style` modes.

## Fragment-Format Slots

A host declares a fragment-format slot in its app manifest `slots` array. The slot's `accepts` lists the fragment formats it takes; `style` controls how host styles reach the mounted fragment.

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

The full slot field reference and the `inherit` / `isolated` / `scoped` styling modes live in [manifest.md](./manifest.md).

## Fragment Fills

A mod fills a fragment-format slot through its `fills` surface, keyed by the host slot id. The fill carries markup and optionally declares data bindings and DOM event handlers.

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

### Fill Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `format` | string | yes | — | Fragment format of the content (must be in the slot's `accepts`) |
| `source` | string | yes | — | File path (relative to mod root) or inline markup |
| `inline` | boolean | no | false | When true, `source` is inline markup (JSML) |
| `bindings` | Binding[] | no | — | Data bindings |
| `handlers` | Handler[] | no | — | DOM event handlers (entries shaped `{ selector, on, handler }`) |
| `events` | Handler[] | no | — | **Deprecated** alias for `handlers`. Accepted for back-compat; if both are present, `handlers` wins |
| `id` | string | no | — | Optional fill identifier, used for ordering tie-breaks and the sandbox fragment API |
| `priority` | integer | no | 0 | Ordering within the slot (higher = earlier) |

> **`events` → `handlers` migration.** The handler array was renamed: its entries are event *handlers* (`{ selector, on, handler }`), not events, so `handlers` names what it carries. `events` stays accepted as a deprecated alias — a reader honors `handlers` or `events`, and when both appear `handlers` wins. Migrate by renaming the key; the entry shape is unchanged. This mirrors the `hooks` → event-typed-slots back-compat precedent: the old name keeps working, the new name is preferred.

### Inline Fills (JSML)

For simple fragments, the source can be inline markup:

```json
{
  "fills": {
    "header.status": [
      {
        "id": "status-text",
        "format": "text/html",
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

### Fill Ordering

When multiple fills target the same slot (requires `multiple: true`):

1. Sort by `priority` descending (higher values render first)
2. Break ties alphabetically by fill `id`

Hosts can override this ordering via user preferences.

> The former top-level `fragments[]` array is a deprecated alias for fragment-format slot fills: each legacy fragment's `slot` becomes the `fills` key and the rest of the entry becomes the fill. Validators still accept it with a deprecation warning. See [mod-manifest.md](./mod-manifest.md#deprecated-aliases).

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

For input elements, the runtime can both push values (host → fragment) and listen for changes (fragment → host). Write-back is explicit: use the `handlers` array to declare handlers for `input` or `change` events on bound elements.

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

Handlers are declared in the fragment manifest, not in the markup. The runtime attaches listeners to matching elements and delegates to sandbox functions.

```json
"handlers": [
  { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
]
```

The deprecated `events` key is accepted as an alias; see [Fill Fields](#fill-fields).

### How It Works

1. After mounting the fragment, the runtime queries elements matching each handler's `selector`
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

Interactive and form elements: `button`, `input`, `textarea`, `select`, `option`, `label`, `fieldset`, `legend`, `progress`, `meter`, `output`.

SVG elements: `svg`, `g`, `defs`, `symbol`, `use`, `circle`, `ellipse`, `path`, `rect`, `line`, `polygon`, `polyline`, `text`, `tspan`.

### Stripped Elements

Removed entirely (element and all children): `script`, `iframe`, `object`, `embed`, `form`, `base`, `link`, `meta`, `title`, `html`, `head`, `body`, `noscript`, `applet`, `frame`, `frameset`, `foreignObject`, `animate`, `set`.

### Allowed Attributes

`class`, `id`, `data-*`, `aria-*`, `role`, `style`, `src` (safe URIs only), `alt`, `width`, `height`, `href` (safe URIs only), `target`, `rel`, `colspan`, `rowspan`, `scope`, `headers`, `lang`, `dir`, `title`, `tabindex`, `hidden`.

Form attributes: `type`, `value`, `placeholder`, `name`, `for`, `checked`, `disabled`, `readonly`, `required`, `rows`, `cols`, `maxlength`, `minlength`, `min`, `max`, `step`, `pattern`, `open`, `low`, `high`, `optimum`.

SVG attributes: `cx`, `cy`, `r`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `points`, `d`, `fill`, `stroke`, `stroke-width`, `opacity`, `transform`, `viewBox`, `preserveAspectRatio`, `xmlns`.

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
3. **User interaction** goes through declared `handlers` → sandboxed handler functions
4. **Complex mutations** go through the sandbox fragment API (command buffer, never direct DOM access)

No inline scripts. No inline event handlers. No embedded code of any kind survives sanitization. The fragment is a skeleton; the sandbox is the muscle.

## Cross-Validation

When a mod is loaded against a host application, the runtime validates each fragment fill:

1. Every fill keys to a slot that exists in the app manifest
2. Every fill's format is in the target slot's `accepts` list
3. If the slot requires a capability, the mod must list that capability
4. If the slot has `multiple: false`, only one fill is resolved — the deterministic winner (highest priority, ties broken alphabetically by fill id), not insertion order

The runtime validates the keyed slot id and capability for fills of every slot type; the format-in-`accepts` and ordering checks above are specific to fragment-format slots. See [mod-manifest.md](./mod-manifest.md#validation-contract) for the general fill validation contract.

## Runtime Slot Resolution

Cross-validation runs at load time. v0.5.0 adds a deterministic runtime resolver that answers "what is mounted in this slot, and in what order?"

`resolveSlot(slotId)` returns the loaded fills targeting `slotId`, ordered by:

1. `priority` descending
2. fill `id` ascending (tie-break)

Cardinality: when the slot's `multiple` is `false` (the default), the resolver yields at most one fill — the highest-priority winner (ties broken by id). This supersedes the looser "first-come-first-served" wording above: resolution is deterministic and reproducible, not insertion-ordered. A `resolveSlotSingle(slotId)` convenience returns the single winner (or none).

Capability-ungranted fills are excluded from results (they are already filtered at load). Resolving an undeclared slot id returns an empty result, not an error — querying an empty or unknown slot is legitimate.
