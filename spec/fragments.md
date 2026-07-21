# Fragment Protocol

The fragment protocol is the semantics of one slot type: the **fragment-format slot**. A host declares a slot whose `accepts` names a fragment format (`text/html`, `application/j5ml+json`, or a format the host declares itself); a mod fills it with an inert fragment — markup plus declared data bindings and event handlers. A fragment is a fill of a fragment-format slot; it is not a separate top-level mod concept. The runtime sanitizes fragment content against the format's vocabulary, resolves data bindings, evaluates conditional visibility, and routes events through the sandbox.

See [fragment-formats.md](./fragment-formats.md) for how a host declares a format's node vocabulary and where the runtime sanitizes prop values, [mod-manifest.md](./mod-manifest.md) for the `fills` surface and the other slot types (code-renderer, role, event), and [manifest.md](./manifest.md) for how a host declares slots and their `style` modes.

## Fragment-Format Slots

A host declares a fragment-format slot in its app manifest `slots` array. The slot's `accepts` lists the fragment formats it takes; `style` controls how host styles reach the mounted fragment.

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

The full slot field reference and the `inherit` / `isolated` / `scoped` styling modes live in [manifest.md](./manifest.md).

## Fragment Fills

A mod fills a fragment-format slot through its `fills` surface, keyed by the host slot id. The fill carries markup and optionally declares data bindings and DOM event handlers.

```json
{
  "fills": {
    "sidebar.left": [
      {
        "format": "text/html",
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
| `format` | string | yes | — | Fragment format of the content (must be in the slot's `accepts`, and must resolve to a built-in or host-declared vocabulary) |
| `source` | string | yes | — | File path (relative to mod root) or inline markup |
| `inline` | boolean | no | false | When true, `source` is inline markup (JSML) |
| `interpolate` | boolean | no | false | When true, text nodes in `source` are parsed for `{{ expression }}` sites. Off by default so a fragment that quotes the delimiter keeps its meaning. See [Expressions](./expressions.md#inline-interpolation--expr-) |
| `bindings` | Binding[] | no | — | Data bindings |
| `handlers` | Handler[] | no | — | Event handlers (entries shaped `{ selector, on, handler }`) |
| `events` | Handler[] | no | — | **Deprecated** alias for `handlers`. Accepted for back-compat; if both are present, `handlers` wins |
| `id` | string | no | — | Optional fill identifier, used for ordering tie-breaks and the sandbox fragment API |
| `priority` | integer | no | 0 | Ordering within the slot (higher = earlier) |

> **`events` → `handlers` migration.** The handler array was renamed: its entries are event *handlers* (`{ selector, on, handler }`), not events, so `handlers` names what it carries. `events` stays accepted as a deprecated alias — a reader honors `handlers` or `events`, and when both appear `handlers` wins. Migrate by renaming the key; the entry shape is unchanged. This mirrors the `hooks` → event-typed-slots back-compat precedent: the old name keeps working, the new name is preferred.

### What Counts as a Fragment Fill

A fill is a **fragment fill** if and only if it carries both a string `format` and a string `source`. That test is what separates a fragment from the other things a slot can take: a code-renderer fill carries an `entry`, and a pure-data fill carries neither. Only fragment fills are parsed, sanitized, and mounted; the rest pass through untouched.

A fragment fill's `format` must resolve to a vocabulary — one of the three built-in formats, or one the host declares in its `formats` block. **An unresolvable format is an error at load time**, raised by `xript validate` before the mod is instantiated and again by the runtime as a backstop. It used to fall through to the HTML sanitizer, which meant a typo'd media type quietly ran a JSON document through an HTML tokenizer. See [fragment-formats.md](./fragment-formats.md#unknown-formats).

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
3. The value is written where the node's vocabulary says it lands: by default it replaces the node's children with a single text node; if the node declares a `bindTo` prop, the value is written to that prop instead, **through that prop's sink**
4. In the built-in HTML vocabulary this reduces to the familiar rule: text elements (`span`, `div`, `p`, …) get `textContent`, void and input elements (`input`, `img`, …) get `value`
5. On data change, the runtime re-resolves only changed bindings and patches the affected nodes

A bound value routed to a prop goes through that prop's sink, exactly as a literal value would. Without that, `data-bind` would be an injection bypass on any prop the vocabulary marked dangerous. See [the safety model](./fragment-formats.md#the-safety-model).

### Performance

`data-bind` attributes persist in the DOM. The runtime maintains a map of attribute → element references for O(1) updates. This supports 60fps update rates for game-loop-driven UI without template re-parsing or diffing.

### Expression Values

`data-bind` accepts any [XEG expression](./expressions.md), so `data-bind="round(hp / maxHp * 100)"` computes and `data-bind="hp"` stays a plain lookup. A bare identifier is a member of the grammar, so every `data-bind` written before this existed keeps working unchanged.

The parser classifies the body, and the classification decides what is writable. See [`data-bind` is classified, not just accepted](./expressions.md#data-bind-is-classified-not-just-accepted).

### Two-Way Binding

For input elements, the runtime can both push values (host → fragment) and listen for changes (fragment → host). Write-back is explicit: use the `handlers` array to declare handlers for `input` or `change` events on bound elements.

Write-back needs an lvalue, so it is available only where `data-bind` holds a bare binding name. A computed expression has no inverse; a write-back handler aimed at one is a lint error rather than a silently dropped write.

## Conditional Visibility: `data-if`

The `data-if` attribute evaluates an expression against the binding context to control element visibility.

```html
<div data-if="health < 50" class="warning">You're hurting!</div>
<div data-if="health < 20" class="critical">Get to a healer!</div>
```

### Evaluation

1. The runtime extracts the expression string from `data-if`
2. The expression is parsed as [XEG](./expressions.md) and evaluated by walking the AST. There is no `eval`, no `Function`, and no code generation anywhere on this path, so a mod-authored attribute string cannot reach a host global
3. Identifiers resolve against the fill's declared `bindings`, and against nothing else. An undeclared name is `null`, never a lookup in the surrounding scope
4. The result is reported in the `conditions` array returned by `getContent()`, keyed by the node's position in the bound tree. Truthy → the node is visible; falsy → the host hides it, by whatever means its renderer has (`display: none`, removal, a `Visible` property)
5. On binding change, the runtime re-evaluates and reports only if the boolean result changed

Evaluation is total: an unparseable or failing expression is `false`, never an exception that aborts a render.

The `visibility` map is still returned and is deprecated. It is keyed by expression text, so two nodes carrying the same `data-if` collapse into one entry and a host cannot map a result back to a node.

`data-if` **never prunes the tree**. The runtime reports the result; the host applies it. A fragment stays an inert description of what should be shown, not a mutation of what is shown.

## Inline Interpolation

A fill that sets `"interpolate": true` parses `{{ expression }}` sites in its **text nodes**.

```html
<p>Health: {{ hp }}/{{ maxHp }} ({{ round(hp / maxHp * 100) }}%)</p>
```

Opt-in, because a fragment published before the mode existed may carry `{{` in prose or a code sample and its meaning must not change. Text nodes only, because a prop's sink validates a whole value and cannot judge one assembled from pieces. The exact lexing rule, the escape, and the structural argument are in [Expressions](./expressions.md#inline-interpolation--expr-).

### Hard Wall

`data-bind` and `data-if` are the only two "smart" attributes the spec defines. No `data-each`, no `data-else`, no template language constructs. Everything beyond binding and conditional visibility goes through the sandbox fragment API.

Interpolation does not widen that wall: `{{ … }}` carries the same expression grammar `data-bind` already carried, in a position that produces text. The inline conditional is XEG's ternary, which selects a *value*. There is no block form, and there will not be: a block form selects markup, which is control flow. Nor is there a "statement to run for effect" — a render-time statement is a mutation triggered by rendering, and every property that makes a fragment safe to re-render, cache, or render in a renderer with no sandbox attached dies with it.

## Event Routing

Handlers are declared in the fragment manifest, not in the markup. The runtime attaches listeners to matching elements and delegates to sandbox functions.

```json
"handlers": [
  { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
]
```

The deprecated `events` key is accepted as an alias; see [Fill Fields](#fill-fields).

### How It Works

1. After mounting the fragment, the runtime resolves each handler's `selector` as a [node reference](#node-references)
2. For each matched node, the runtime attaches a listener for the specified `on` event
3. When the event fires, the runtime calls the named `handler` function in the mod's sandboxed script
4. The handler receives event data (target node info, event type)
5. Multi-match is intentional: `[data-action='heal']` matching three buttons wires all three to the same handler

## Node References

Handlers and command-buffer ops target nodes the same way, in every vocabulary, through one grammar.

> A target string is an **ID reference** if it matches `^#[A-Za-z][A-Za-z0-9_.:-]*$`. It resolves to the node whose `id` prop equals that name, in any vocabulary. Any other string is a **CSS selector**, which is meaningful only for HTML-vocabulary formats; on a tree format it is dropped with an `unsupported-target` diagnostic.

The runtime hands the host both forms: the raw `selector` string, and a parsed `target` — `{ by: "id", id }` or `{ by: "selector", selector }`. An HTML host can keep passing `selector` straight to `querySelectorAll` and get the node it always got, because `#heal-button` is simultaneously a valid CSS ID selector. A component host reads `target` and matches on `id`.

`id` is a protocol prop: legal on every node of every vocabulary, never declared, never dropped, never sanitized. It exists precisely so that this grammar has something to resolve against.

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

The `fragment` object passed to callbacks is a proxy, not a live node reference. Method calls accumulate an operation list (command buffer). After the callback returns, the runtime passes the operation list to the host, which applies the mutations. The sandbox never touches the real tree.

The command buffer is **sanitized on the way out**, in the runtime, before the host sees it. Ops used to be exempt: a mod could emit `setAttr("#x", "onclick", "alert(1)")` or `replaceChildren("#list", "<img onerror=…>")` and the host would apply it raw, because the protocol promised that *fragments* were sanitized and said nothing about ops. Ops now go through the same vocabulary and the same sinks a fragment's props do. An op naming a prop the vocabulary does not declare is dropped; an op whose prop declares a sink is routed through it; an `on*` prop is rejected in every vocabulary.

### Available Operations

| Method | Arguments | Effect |
|--------|-----------|--------|
| `toggle(target, condition)` | node ref, boolean | Show/hide matching nodes |
| `setText(target, text)` | node ref, string | Set text content of matching nodes. Hosts must apply it **as text**, never as markup |
| `setProp(target, prop, value)` | node ref, string, any | Set a prop on matching nodes. The value keeps its type: a number stays a number, an object stays an object |
| `replaceChildren(target, content)` | node ref, string / string[] / node[] | Replace the children of matching nodes |
| `setAttr(target, attr, value)` | node ref, string, any | **Deprecated** alias of `setProp`. Still emitted under its own op name |
| `addClass(target, className)` | node ref, string | HTML-vocabulary sugar for adding a class. Dropped with a diagnostic on other vocabularies |
| `removeClass(target, className)` | node ref, string | HTML-vocabulary sugar for removing a class. Dropped with a diagnostic on other vocabularies |

Every op carries both `selector` (the raw target string, always populated) and `target` (the parsed [node reference](#node-references)).

`setProp` is the general form: **an attribute is a prop**. `setAttr` keeps working, keeps its own op name, and emits `prop` alongside `attr` so a new host reads one key. `addClass` and `removeClass` are `setProp("class", …)` in a trench coat — they only mean anything in a vocabulary that has CSS classes, so they survive as HTML sugar and are dropped elsewhere.

`replaceChildren` joins an array **only when every element is a string**; that is the HTML case, and it is byte-identical to what it always did. An array of nodes passes through as a node list, which is how a component vocabulary replaces children.

### Lifecycle Registration

```javascript
hooks.fragment.mount("health-panel", (fragment) => { /* called on mount */ });
hooks.fragment.unmount("health-panel", (fragment) => { /* called on unmount */ });
hooks.fragment.update("health-panel", (bindings, fragment) => { /* called on data change */ });
hooks.fragment.suspend("health-panel", (fragment) => { /* called on suspend */ });
hooks.fragment.resume("health-panel", (fragment) => { /* called on resume */ });
```

## Fragment Content: the Tree Contract

`getContent(bindings)` is what a host calls to get a fragment's current, bound, sanitized content. It returns both a **tree** and, for HTML vocabularies, the HTML serialization of that tree.

The full shape, what it guarantees, and what a thing that draws is allowed to read is [renderers.md](./renderers.md) — the tree contract, versioned `xript-tree/1`. In short: node names keep their case, props keep their type and their declaration order, `html` stays a required non-optional string so a host that mounts it keeps working byte-for-byte, and `diagnostics` carries everything the sanitizer found. Diagnostics are also pushed through an `onFragmentDiagnostic` callback on the runtime options, which is where op-time findings surface.

The full sanitization model — vocabularies, sinks, what is an error and what is a warning — is [fragment-formats.md](./fragment-formats.md). The rest of this section is the built-in HTML vocabulary that every host gets for free.

## The Built-In HTML Vocabulary

For `text/html`, `text/html+jsml`, and `application/jsml+json` fragments, the runtime sanitizes content against HTML's element and attribute allow-lists before the host ever sees it. The guarantee to hosts: what you're mounting is inert.

An element outside the allow-list is dropped — and, since v0.8, **reported**. It used to vanish with no diagnostic at all, which meant a mod could contribute a fragment, watch nothing appear, and have nothing to go on. The drop stays a drop rather than a hard failure because HTML is an open language that keeps growing without asking, and a node that is dropped is already inert. A host that wants the stricter contract sets `strictHtmlVocabulary` and gets an error instead. A **host-declared** vocabulary is closed, so an unknown node there is always an error.

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

In vocabulary terms, `href` is a `uri` sink and `src` is an `image-uri` sink. The built-in vocabulary hard-codes that mapping because HTML hard-codes it. A host-declared vocabulary states it explicitly, per prop.

### Style Sanitization

Within `<style>` blocks and `style` attributes: `url()` references, `expression()`, `-moz-binding`, and `behavior:` are stripped. This is the `css` sink.

### Conformance

All runtime implementations must produce identical sanitized output for the same input. The conformance test suite at `spec/sanitizer-tests.json` defines the canonical input/output pairs.

## Security Model

Fragments are inert templates. They carry structure and style. All dynamic behavior routes through systems the runtime already controls:

1. **Data display** goes through declared `data-bind` bindings, written where the vocabulary says they land, through the target prop's sink
2. **Conditional visibility** goes through declared `data-if` expressions evaluated by the sandboxed expression engine, and reported rather than applied
3. **User interaction** goes through declared `handlers` → sandboxed handler functions
4. **Complex mutations** go through the sandbox fragment API — a command buffer, never a live tree reference, and sanitized against the same vocabulary on the way out

No inline scripts. No inline event handlers. No `on*` prop, in any vocabulary, declared or not. No embedded code of any kind survives sanitization. The fragment is a skeleton; the sandbox is the muscle.

The model's one load-bearing idea is that **danger is a property of where a value lands, not of what a node is called**. A prop is dangerous when a renderer eventually hands it to something that navigates, executes, or parses markup. Only the vocabulary's owner knows which props those are, so the vocabulary's owner declares them, and the runtime sanitizes exactly there. Everything else is inert data and is left alone.

## Cross-Validation

When a mod is loaded against a host application, the runtime validates each fragment fill:

1. Every fill keys to a slot that exists in the app manifest
2. Every fill's format is in the target slot's `accepts` list
3. Every fill's format resolves to a vocabulary — built-in, or declared in the host's `formats` block. An unresolvable format is an error, not a fallback
4. An inline fill's markup is checked against that vocabulary: an undeclared node in a declared vocabulary fails the load, and every dropped prop is reported
5. If the slot requires a capability, the mod must list that capability
6. If the slot has `multiple: false`, only one fill is resolved — the deterministic winner (highest priority, ties broken alphabetically by fill id, then by owning mod name), not insertion order

Checks 2 through 4 are specific to fragment-format slots; the keyed slot id and capability checks apply to fills of every slot type. Check 2 was previously enforced only on the deprecated `fragments[]` path, which meant a `fills`-native mod could name a format its target slot did not accept and load anyway. `xript validate` now enforces it on both. See [mod-manifest.md](./mod-manifest.md#validation-contract) for the general fill validation contract.

Check 4 is what makes a typo cheap: `["Panle", {...}]` is caught by `xript validate` in CI, rather than at runtime as a component that quietly failed to appear.

## Runtime Slot Resolution

Cross-validation runs at load time. v0.5.0 adds a deterministic runtime resolver that answers "what is mounted in this slot, and in what order?"

`resolveSlot(slotId)` returns the loaded fills targeting `slotId`, ordered by:

1. `priority` descending
2. fill `id` ascending
3. owning mod name ascending

Key 3 was added in v0.8.0 and closes a real nondeterminism: fragment fills that omit an `id` have one synthesized as `${slotId}-fill-${index}`, so two mods filling the same slot at the same index produce the *same* id and key 2 was never total. Order no longer depends on the order the host loaded its mods.

**This is one rule, shared by every ordered slot kind.** Fragment, data, and [command](./commands.md#ordering-and-cardinality) resolution all order by the same three keys, and role resolution falls back to the third of them once its `preferences` are applied. A slot kind that answered differently about the same declaration would be a fork, not a feature.

Cardinality: when the slot's `multiple` is `false` (the default), the resolver yields at most one fill — the highest-priority winner. This supersedes the looser "first-come-first-served" wording above: resolution is deterministic and reproducible, not insertion-ordered. A `resolveSlotSingle(slotId)` convenience returns the single winner (or none). Cardinality counts *fills*, not mods, on every slot kind: a `multiple: false` command slot resolves to exactly one command across all mods.

Capability-ungranted fills are excluded from results (they are already filtered at load). Resolving an undeclared slot id returns an empty result, not an error — querying an empty or unknown slot is legitimate.

## Runtime Parity

Every runtime implements every part of this page, and the fragment surface is covered by "four runtimes at parity".

| | `@xriptjs/runtime` | `@xriptjs/runtime-node` | `xript-runtime` (Rust) | `Xript.Runtime` (C#) |
|---|---|---|---|---|
| `text/html`, `text/html+jsml` | yes | yes | yes | yes |
| `application/jsml+json` | yes | yes | yes | yes |
| Host-declared `formats` vocabularies | yes | yes | yes | yes |
| Sanitized tree on `getContent()` | yes | yes | yes | yes |
| Unknown format rejected at load | yes | yes | yes | yes |
| `setProp`, node references, op-value sanitization | yes | yes | yes | yes |

All four read JSML, resolve host-declared vocabularies, carry the sanitized tree alongside the HTML projection, and refuse an unrecognized format at load rather than running it through the HTML sanitizer.

Parity is held by contract: `spec/fragment-vocabulary-tests.json` and `spec/fragment-op-tests.json` are shared conformance corpora generated from the reference implementation, and every runtime is asserted against them. Same sources, same trees, same diagnostics.
