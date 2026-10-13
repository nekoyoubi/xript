# Fragment Protocol

The fragment protocol is the semantics of one slot type: the **fragment-format slot**. A host declares a slot whose `accepts` names a fragment format (`text/html`, `application/j5ml+json`, or a format the host declares itself); a mod fills it with an inert fragment: markup plus declared data bindings and event handlers. A fragment is a fill of a fragment-format slot; it is not a separate top-level mod concept. The runtime sanitizes fragment content against the format's vocabulary, resolves data bindings, expands repeats, evaluates conditional visibility, and routes events through the sandbox.

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
| `bindings` | Binding[] | no | — | Data bindings (see [Binding Fields](#binding-fields)) |
| `handlers` | Handler[] | no | — | Event handlers (entries shaped `{ selector, on, handler }`) |
| `events` | Handler[] | no | — | **Deprecated** alias for `handlers`. Accepted for back-compat; if both are present, `handlers` wins |
| `id` | string | no | — | Optional fill identifier, used for ordering tie-breaks and the sandbox fragment API |
| `priority` | integer | no | 0 | Ordering within the slot (higher = earlier) |

> **`events` → `handlers` migration.** The handler array was renamed: its entries are event *handlers* (`{ selector, on, handler }`), not events, so `handlers` names what it carries. `events` stays accepted as a deprecated alias: a reader honors `handlers` or `events`, and when both appear `handlers` wins. Runtimes report its use once per mod at load as a `deprecated-events-alias` diagnostic (see [Load-Time Diagnostics](#load-time-diagnostics)). Migrate by renaming the key; the entry shape is unchanged. This mirrors the `hooks` → event-typed-slots back-compat precedent: the old name keeps working, the new name is preferred.

### Binding Fields

A binding is `{ name, path }`, with an optional `type` that tooling reads to type-check the expressions using it. Any other field on a binding is a **host-defined extension**: a value transform, a formatting hint, whatever a host chooses to offer. The protocol sanctions them and runtimes carry them through to the host untouched, never interpreting them.

```json
{ "name": "hp", "path": "player.hp", "transform": "percent" }
```

`path` is a dot-separated walk from the host's data. Each segment reads an own key of an object or a canonical numeric index of an array (`party.0.name`; `0` and `12`, never `01`, `-1`, or `+1`), and nothing else. It never reads a property of a primitive (`name.length`), an array's `length`, or an inherited property (`constructor`, `toString`). A segment that reads nothing makes the whole path resolve to nothing, which is distinct from a present `null`: a bare-name `data-bind` on a path that resolves to nothing writes nothing and keeps its authored fallback, while a present `null` renders as the empty string. The `render` section of `spec/expression-tests.json` pins the walk in every runtime.

The cost is portability. A mod that uses an extension field only renders as its author meant on hosts that implement that field; every other host ignores it. `xript lint` reports each such field as an info finding (`non-portable-binding-field`) so the author sees the trade. When the same result can be computed with an [expression](./expressions.md) in `data-bind`, that version renders the same everywhere.

### Load-Time Diagnostics

Some fill shapes load without error but almost certainly do not do what their author meant. Every runtime reports them as **mod diagnostics**: warnings on the loaded mod instance and through the host's mod diagnostic callback, held to `spec/mod-load-tests.json`.

| Code | Raised when |
|------|-------------|
| `markup-source-not-inline` | A fill's `source` is markup (trimmed, it opens with `<`, or it parses as JSON, which covers a JSML tree) but `inline` is not `true`, and the host supplied no file by that name. The source is looked up as a file name, finds nothing, and the fill mounts empty |
| `missing-fragment-source` | A non-inline `source` names a file the host did not supply. The fill mounts empty |
| `deprecated-events-alias` | A fill declares handlers under `events`. Reported once per mod, on the first fill that uses it |

A fill whose source was not supplied mounts as an empty document in its format's own syntax, so a missing JSON-syntax source mounts empty exactly as a missing HTML source does, rather than failing to parse an empty string. `xript lint` reports `markup-source-not-inline` and `deprecated-events-alias` as warnings before the mod ever reaches a host.

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

## Repeat: `data-each`

The `data-each` attribute renders a node once per element of a list.

```html
<ul>
  <li data-each="member in party" data-key="member.id">
    <span data-bind="member.name"></span>
    <span data-if="member.hp < 20" class="critical">low</span>
  </li>
</ul>
```

### Syntax

`data-each="item in expr"` or `data-each="(item, index) in expr"`. The right side of `in` is an [XEG expression](./expressions.md) and must evaluate to an array. The binder names follow XEG's identifier rule, cannot be `true`, `false`, `null`, or `in`, and cannot repeat each other. `in` must be followed by whitespace.

### Expansion

1. The node carrying `data-each` is a **template**. The bind pass replaces it with one copy per element, in array order. The template itself is not rendered; an empty list leaves nothing in its place
2. Each copy is the template without its `data-each` and `data-key` props. Everything else (`data-bind`, `data-if`, `id`, every other prop, and the children) is carried onto the copy
3. Inside a copy, the item name, the optional index name, and `$index` are in scope for `data-bind`, `data-if`, `data-key`, `{{ }}` interpolation, and any nested `data-each`. `$index` is bound whether or not the header names an index. Inner names shadow outer ones, including the fill's own bindings
4. The header's own expression is evaluated in the **enclosing** scope, so `row in row.children` reads the outer `row`
5. Repeats nest. A nested template is expanded once per copy of its parent, against that copy's scope

A repeat name is a value, not a binding. It has no host path, so an `input` or `change` handler cannot write back through it; `xript lint` reports a handler that tries, the same way it reports one aimed at a computed `data-bind`.

### Ordering with `data-if`

`data-each` applies first. A `data-if` on the template is evaluated **per copy, with the item in scope**, so `<li data-each="m in party" data-if="m.alive">` reports one condition per member. A copy whose condition is false is reported at its own path in `conditions` and, like every `data-if`, is not pruned.

### Totality

`data-each` follows XEG's totality rules. A value that is not an array, an expression that fails, and a header that does not parse all render **zero copies**, never an exception that aborts a render. A malformed header is a validate-time error: `xript lint` reports it as an invalid expression.

One render produces at most **10,000 copies** across every `data-each` in the fragment. Nested repeats multiply, and without a ceiling a template's render cost would grow with the host's data raised to the nesting depth. Copies are counted as they are created, outer before inner; a repeat that would cross the ceiling is truncated to what remains and reported with a `repeat-limit` diagnostic.

### Keys: `data-key`

`data-key` is the one modifier `data-each` takes. It is an XEG expression evaluated per copy with the item in scope, and it names that copy's identity across updates.

| | mode | an update |
|---|---|---|
| no `data-key` | `replace` | replaces the repeated range: every old copy is removed and every new one inserted |
| distinct keys | `keyed` | patches by key: copies are reused, moved, inserted, or removed |
| a duplicate key, or a key that is not a string or a finite number | `index` | falls back to position, and reports `duplicate-key` or `invalid-key` |

A key is a string or a finite number, and `1` and `"1"` are different keys. One bad key drops the whole repeat to index keying, because a key set with a hole in it cannot say which copy is which. `data-key` on a node with no `data-each` does nothing; `xript lint` warns about it.

### What the host receives

The copies are already in `tree`, and every path in `conditions` addresses the expanded tree. Alongside them, `getContent()` returns `repeats`, one entry per expansion in document order:

```ts
interface FragmentRepeat {
  site: { template: number[]; within: (string | number)[] }; // stable across updates
  path: number[];        // the copies' parent in the bound tree; [] is the root
  start: number;         // index of the first copy among the parent's children
  count: number;
  expression: string;    // the data-each source
  key: string | null;    // the data-key source
  mode: "keyed" | "index" | "replace";
  keys: (string | number)[];  // one per copy; positions when mode is not "keyed"
  patch: RepeatPatchOp[];     // how to turn the previous render's copies into these
}

type RepeatPatchOp =
  | { op: "remove"; key; from }
  | { op: "insert"; key; to }
  | { op: "reuse";  key; from; to }
  | { op: "move";   key; from; to };
```

`site` identifies a repeat across renders: the template's path in the authored source, plus the keys of the copies enclosing it. A nested list inside a keyed row therefore follows its row when the row moves.

`patch` is computed against the previous `getContent()` of the same fragment instance:

- On a site's first render, every copy is an `insert`
- In `replace` mode, or when the mode changed, every previous copy is a `remove` and every new copy an `insert`
- Otherwise copies match by key. Removes come first, in previous order. Then every new copy, in order, is an `insert`, a `reuse` (kept, and already in relative order), or a `move` (kept, but relocated). The copies marked `reuse` are the longest run already in order, so removing or inserting one item moves nothing else

A host that does not care about patching ignores `repeats` and remounts the tree; the tree alone is always correct. The patch is for a host that wants to keep focus, scroll position, or animation state on a node whose item merely moved.

### Why repeat belongs in the template

Repeat is presentation. Whether a party renders as a list, a grid, or a row of portraits is the template's business, and before `data-each` the only way to render a list was to build markup in script and hand it to `replaceChildren`. That moved the layout out of the template into string assembly, where a renderer with no sandbox attached cannot see it and a vocabulary check cannot reach it until runtime.

Repeat is also total. Mapping a template over a bounded list is not control flow: there is no condition that decides whether it terminates, nothing it can mutate, and nothing it can observe beyond the bindings. Its cost is bounded by the data and by the copy ceiling, the same way XEG's cost is bounded by the AST. That is the bar the [hard wall](#hard-wall) sets, and repeat clears it where a block form does not.

## Inline Interpolation

A fill that sets `"interpolate": true` parses `{{ expression }}` sites in its **text nodes**.

```html
<p>Health: {{ hp }}/{{ maxHp }} ({{ round(hp / maxHp * 100) }}%)</p>
```

Opt-in, because a fragment published before the mode existed may carry `{{` in prose or a code sample and its meaning must not change. Text nodes only, because a prop's sink validates a whole value and cannot judge one assembled from pieces. The exact lexing rule, the escape, and the structural argument are in [Expressions](./expressions.md#inline-interpolation--expr-).

### Hard Wall

The spec defines three "smart" attributes: `data-bind`, `data-if`, and `data-each` (with its `data-key` modifier). No `data-else`, no template language constructs beyond those. Everything beyond binding, conditional visibility, and repeat goes through the sandbox fragment API.

The wall used to stand at two. `data-each` widened it deliberately, and on the same terms the first two meet: it is presentation (the shape of a list is markup, not logic), and it is total (a bounded map over data, with nothing to decide, mutate, or observe). See [why repeat belongs in the template](#why-repeat-belongs-in-the-template).

Interpolation does not widen the wall: `{{ … }}` carries the same expression grammar `data-bind` already carried, in a position that produces text. The inline conditional is XEG's ternary, which selects a *value*. There is no block form, and there will not be: a block form selects markup, which is control flow. Nor is there a "statement to run for effect"; a render-time statement is a mutation triggered by rendering, and every property that makes a fragment safe to re-render, cache, or render in a renderer with no sandbox attached dies with it.

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

For logic beyond `data-bind`, `data-if`, and `data-each`, mods use the sandbox fragment API. This provides imperative fragment manipulation from within the sandboxed script.

```javascript
hooks.fragment.update("health-panel", (bindings, fragment) => {
  fragment.toggle(".low-health-warning", bindings.health < 50);
  fragment.addClass(".health-bar", bindings.health < 20 ? "critical" : "normal");
  fragment.replaceChildren(".inventory-list",
    bindings.inventory.map(item => `<li>${item.name} (x${item.count})</li>`)
  );
});
```

`replaceChildren` is for content whose structure the script decides. A list whose shape the author already knows belongs in the template as [`data-each`](#repeat-data-each), where the vocabulary check sees it at load and a renderer with no sandbox attached can still draw it.

### Command Buffer Pattern

The `fragment` object passed to callbacks is a proxy, not a live node reference. Method calls accumulate an operation list (command buffer). After the callback returns, the runtime passes the operation list to the host, which applies the mutations. The sandbox never touches the real tree.

The command buffer is **sanitized on the way out**, in the runtime, before the host sees it. Ops used to be exempt: a mod could emit `setAttr("#x", "onclick", "alert(1)")` or `replaceChildren("#list", "<img onerror=…>")` and the host would apply it raw, because the protocol promised that *fragments* were sanitized and said nothing about ops. Ops now go through the same vocabulary and the same sinks a fragment's props do. An op naming a prop the vocabulary does not declare is dropped; an op whose prop declares a sink is routed through it; an `on*` prop is rejected in every vocabulary.

### Available Operations

| Method | Arguments | Effect |
|--------|-----------|--------|
| `toggle(target, condition)` | node ref, boolean | Show matching nodes when `condition` is true, hide them when it is false. **A set, not a flip** |
| `setText(target, text)` | node ref, string | Set text content of matching nodes. Hosts must apply it **as text**, never as markup |
| `setProp(target, prop, value)` | node ref, string, any | Set a prop on matching nodes. The value keeps its type: a number stays a number, an object stays an object. On an HTML attribute, `false` and `null` remove it (see below) |
| `replaceChildren(target, content)` | node ref, string / string[] / node[] | Replace the children of matching nodes. The value keeps the shape the mod passed; `[]` clears |
| `setAttr(target, attr, value)` | node ref, string, string / number / boolean / null | **Deprecated** alias of `setProp`. Still emitted under its own op name. `false` and `null` remove the attribute; an object or array is refused |
| `removeAttr(target, attr)` | node ref, string | Remove an attribute (a prop) from matching nodes. The inverse of `setAttr` |
| `addClass(target, className)` | node ref, string | HTML-vocabulary sugar for adding a class. Dropped with a diagnostic on other vocabularies |
| `removeClass(target, className)` | node ref, string | HTML-vocabulary sugar for removing a class. Dropped with a diagnostic on other vocabularies |

Every op carries both `selector` (the raw target string, always populated) and `target` (the parsed [node reference](#node-references)).

`setProp` is the general form: **an attribute is a prop**. `setAttr` keeps working, keeps its own op name, and emits `prop` alongside `attr` so a new host reads one key. `removeAttr` carries `prop` and `attr` and no `value`. `addClass` and `removeClass` are `setProp("class", …)` in a trench coat: they only mean anything in a vocabulary that has CSS classes, so they survive as HTML sugar and are dropped elsewhere.

**`toggle` is a set, not a flip.** The condition arrives as the op's `value`, coerced to a strict boolean in the sandbox; `toggle(t, false)` twice leaves `t` hidden, not shown. Appliers must read `value` and never invert the node's current state.

**An attribute has no `false`.** An HTML attribute holds a string, and HTML reads a boolean attribute by presence: `disabled="false"` is disabled. So when a write lands on an attribute (every `setAttr`, and a `setProp` whose prop no declared vocabulary in scope owns and the built-in HTML vocabulary resolves), `false`, `null`, and a missing value mean *absent*, and the runtime finalizes the op as `removeAttr`. A host therefore never receives `setAttr` with `false` or `null`. `true` stays `true` and writes as `"true"`; a string-boolean attribute such as `aria-pressed="false"` is written by passing the string `"false"`. A `setProp` on a prop a declared vocabulary owns keeps `false` as a typed value, because there it is data, not presence.

**An attribute holds a primitive.** An object or array reaching an attribute sink would serialize as `[object Object]` or a comma-joined list, so the runtime refuses it with an `op-invalid-value` diagnostic naming the target and the attribute, and drops the op. This is the same floor that refuses a value a prop's sink rejects; a declared typed prop still takes structured values through `setProp`.

`replaceChildren` carries exactly what the mod passed. A markup string is sanitized as markup. Under an HTML-speaking format, a list of strings is a list of markup strings: each element is sanitized on its own and the list is kept a list, so the host sees the shape the mod chose and concatenates it in order. The empty list is an explicit **clear**. Any other list is a J5ML node list and goes through the vocabulary, which is how a component vocabulary replaces children (on a tree format, a list of strings is a list of text nodes). A value that is neither a string nor a list is refused with `op-invalid-value`.

### Applier Conformance

The ops above have a host-side meaning too: the applier that turns them into DOM. [`fragment-applier-tests.json`](./fragment-applier-tests.json) is that meaning as data, a table of `(initial DOM, ops) -> (expected DOM, expected write count)` cases, each naming in `because` the applier defect it catches. It requires, among other things, that `setAttr` with `false` never leaves a present attribute, that a repeated identical write does not write again, that `toggle` repeated an even number of times with one condition lands on that condition, and that `replaceChildren([])` clears.

`@xriptjs/runtime` exports `runFragmentApplierConformance(apply)`. Given a function, it runs the table against a minimal write-counting DOM it builds for each case (the element surface an applier normally touches: `querySelectorAll`, attributes, `classList`, `hidden`, `textContent`, `innerHTML`, `replaceChildren`). Given an adapter `{ mount, apply, snapshot, writes }`, it drives an applier over any other target. It returns `{ total, passed, failures }` and never throws for a failing applier, so a host asserts `failures` is empty in its own test suite.

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

### SVG `title` and `desc`

`title` is stripped as HTML's document title, but inside an `<svg>` it is a different element: the accessible name and tooltip of the graphic, with `desc` as its longer description. Under an `svg` ancestor both are kept, and they are held to a narrow shape:

- **Text only.** An element child is reduced to its text and reported (`illegal-child`, `warning`). A stripped child such as `script` is dropped with its subtree and reported (`stripped-node`). A `style` child is dropped rather than letting its CSS surface as prose.
- **Few attributes.** `id`, `class`, `lang`, `dir`, plus the inert `data-*` and `aria-*` prefixes. Anything else is stripped and reported like any other disallowed attribute.
- **Only inside SVG.** A `title` anywhere else is still the stripped document title, and `desc` outside an `svg` is an unknown element.

Inside SVG the HTML parser reads `title` as ordinary content rather than as a raw-text region, and the reader follows suit, so a `title` under an `svg` never swallows the markup after it.

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
3. **Repeat** goes through `data-each`, expanded by the runtime from bound data under a copy ceiling, with every copy held to the same vocabulary and sinks as the template it came from
4. **User interaction** goes through declared `handlers` → sandboxed handler functions
5. **Complex mutations** go through the sandbox fragment API: a command buffer, never a live tree reference, and sanitized against the same vocabulary on the way out

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
| `removeAttr`, attribute-sink `false`/`null` removal, non-primitive refusal | yes | yes | yes | yes |
| `replaceChildren` keeps the mod's shape (no join, `[]` clears) | yes | yes | yes | yes |
| `data-each` repeat, `data-key` patches | yes | yes | yes | yes |
| Load-time mod diagnostics, entry error policy | yes | yes | yes | yes |

All four read JSML, resolve host-declared vocabularies, carry the sanitized tree alongside the HTML projection, and refuse an unrecognized format at load rather than running it through the HTML sanitizer.

Parity is held by contract: `spec/fragment-vocabulary-tests.json`, `spec/fragment-op-tests.json`, and `spec/repeat-tests.json` are shared conformance corpora generated from the reference implementation, and every runtime is asserted against them. Same sources, same trees, same diagnostics, same patches. `spec/mod-load-tests.json` holds every runtime to the same load-time mod diagnostics and entry error policy. `spec/marshal-tests.json` holds every runtime to treating a host value's keys as data on the way into the sandbox, an own `__proto__` key included. `spec/fragment-applier-tests.json` is the host-side counterpart, held by each host through `runFragmentApplierConformance`.
