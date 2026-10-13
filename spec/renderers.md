# The Renderer Contract

A **renderer** turns a fragment into pixels, cells, or widgets. It is not a host: it does not load mods, hold capabilities, evaluate expressions, or own storage. It walks a tree it is handed and draws it, and it applies a list of mutations it is handed and redraws.

Everything on this page exists to make that sentence literally true. If an implementer of a renderer finds themselves parsing an expression, reading a bindings map, or deciding whether a node is visible, the contract has failed and the bug is here, not in their code.

This page is the third audience for the fragment protocol. [fragments.md](./fragments.md) is for mod authors (`data-bind`, `data-if`, the sandbox API) and hosts (slots, lifecycle). [fragment-formats.md](./fragment-formats.md) is for vocabulary owners (nodes, props, sinks). This page is for the implementer of a thing that draws.

## Versioning

The contract is versioned independently of the spec and of any runtime, under the identifier `xript-tree/1`. Every result carries it:

```ts
{ contract: "xript-tree/1", … }
```

A renderer that recognizes the string may walk the tree. A renderer that does not recognize it must refuse to render and say so, rather than guessing. The version increments only when a renderer written against the previous one would draw the wrong thing.

### Frozen for the life of `xript-tree/1`

These may not change without a version increment:

- the node shape — a node is a text node or an element node, and nothing else
- the element shape — `name`, `props`, `children`, in that meaning
- prop values keep their JSON type, and prop *order* is preserved
- `path` is a child-index path into `tree`, root-relative, and addresses the same node in `tree` and in `conditions`
- `id` is a protocol prop: present on any node, never declared by a vocabulary, never dropped
- the four guarantees below — sanitized, bound, resolved, evaluated
- the op names and the meaning of each
- `contract` itself, as the first key a renderer may rely on

### Free to change within `xript-tree/1`

- **new diagnostic codes.** A renderer must treat an unknown `code` as an opaque warning, not an error. Diagnostics are advisory to a renderer in every case.
- **new op names.** A renderer must ignore an op it does not recognize, and must not treat it as a reason to abandon the batch.
- **new optional keys** on the result, on an element, or on an op. A renderer must ignore keys it does not know. Nothing that exists today is removed without a version bump.
- **the `html` projection.** Its contents, its whitespace, and whether a given vocabulary produces one at all. A renderer must not read `html`.
- **`visibility`** (the text-keyed map). It is deprecated, it collides, and it will be removed. A renderer must read `conditions`.

### Not part of the contract at all

`FragmentInstance`, `sanitizedTree`, `processFragment`, the harness, the debug protocol, and every runtime-internal type. A renderer that names one of them has reached past the seam.

## What a renderer receives

One value, produced by `getContent(data)` on the host side and handed across:

```ts
type RenderedFragment = {
  contract: "xript-tree/1";
  fragmentId: string;
  format: string;                    // the media type; the renderer's own vocabulary id
  contentType: "html" | "tree";
  tree: FragmentNode[];              // bound, sanitized, resolved. always present
  conditions: FragmentCondition[];   // every data-if, path-keyed, already evaluated
  repeats: FragmentRepeat[];         // every data-each, already expanded into tree. optional to read
  diagnostics: FragmentDiagnostic[]; // advisory
  html: string;                      // HTML projection; "" for a tree vocabulary. NOT for renderers
  visibility: Record<string, bool>;  // DEPRECATED, text-keyed, collides. do not read
};

type FragmentNode = FragmentText | FragmentElement;
type FragmentText    = { kind: "text",    value: string };
type FragmentElement = { kind: "element", name: string, props: PropList, children: FragmentNode[] };

type PropList  = ordered (name, PropValue) pairs, first-appearance order, no duplicates
type PropValue = string | number | boolean | null | PropValue[] | { [k: string]: PropValue };

type FragmentCondition = { path: number[], expression: string, visible: boolean };
type FragmentDiagnostic = {
  code: string;                      // open enum
  severity: "error" | "warning";
  path: string;                      // JSON-pointer-ish location in the source
  node: string;
  prop: string | null;
  message: string;
};
```

`path` on a condition is a child-index path: `[0, 2, 1]` is `tree[0].children[2].children[1]`. It is the **only** node addressing in the contract that a renderer needs, and it is stable for a given result. It is not stable across updates; a renderer re-reads `conditions` on every update rather than caching paths.

The Rust surface is the `xript-tree` crate, which is engine-free on purpose: naming a tree type must not require building a JavaScript engine. `xript-runtime` re-exports it and `FragmentResult::to_rendered()` is the projection. On JS, Node, and C# the tree is plain data and no extraction is needed.

## What xript guarantees, so the renderer does not

These are the load-bearing promises. Each one is a thing a renderer would otherwise have to implement, and each is the same thing implemented once in four runtimes instead of once per app.

### The tree is sanitized

Every node in `tree` survived its vocabulary. Every prop on it is declared by that vocabulary (or is a protocol prop), and every prop *value* passed the sink that prop declares: a URI prop holds a URI with an allowed scheme, a style prop holds sanitized style, an HTML-valued prop holds sanitized HTML. Event-handler props (`on*`) are gone in every vocabulary.

A renderer does not sanitize. A renderer does not check whether a node is allowed. If the node is in the tree, the vocabulary declared it and the renderer may draw it.

### The tree is bound

`data-bind` has already been resolved against the host's bindings and written into the node — into its children as a text node, or into the prop the vocabulary's `bindTo` names, routed through that prop's sink. The renderer never sees a bindings map. **The renderer is not given one, on purpose.**

> **Bound values keep their JSON type.** A `data-bind` that resolves to `0.62` writes the number `0.62`, not the string `"0.62"`. This is what makes a numeric widget — a gauge ratio, a sparkline series — drawable from the tree alone. Where a vocabulary's `bindTo` prop is textual, the runtime stringifies; where the profile types it as something else, it does not.

`data-bind` and `data-if` props remain on the bound node as authoring residue. A renderer ignores them. They are not removed because the HTML projection and round-tripping still need them, and removing them would be a breaking change to hosts that read them today.

### Repeats are expanded

Every `data-each` template has already been replaced by its copies, one per element, each bound against its own item. The template itself is not in `tree`, and the copies carry no `data-each` or `data-key`, so nothing a renderer walks can be mistaken for a template and expanded twice. Paths in `conditions` address the expanded tree.

`repeats` says where each expansion landed (`path`, `start`, `count`), how its copies are keyed, and a `patch` describing how the previous render's copies become these: `remove`, `insert`, `reuse`, or `move`, by key. A renderer that redraws from `tree` every update is correct and may ignore `repeats` entirely. A renderer that retains drawn nodes, and wants a moved item to keep its focus, scroll position, or animation state, applies the patch instead of remounting the range. The full shape is in [fragments.md](./fragments.md#what-the-host-receives).

### Interpolation is resolved

`{{ expr }}` sites inside text have been evaluated and substituted. A text node's `value` is final, literal text. A renderer that prints `value` is correct in every vocabulary. There is no segment structure to walk and no expression to evaluate.

### Visibility is evaluated, not applied

Every `data-if` in the tree appears in `conditions` with its `visible` boolean already computed. The tree is **not pruned** — fragments stay inert, and what "hidden" means is a rendering decision, not a protocol one. A terminal renderer skips the subtree; a browser renderer may set `display:none` and keep the node addressable; an accessibility-minded renderer may prefer `aria-hidden`.

The renderer's entire visibility implementation is a set lookup:

```
hidden = conditions.any(c => c.path is a prefix of, or equal to, this node's path && !c.visible)
```

A renderer must **not** evaluate `expression`. It is carried for diagnostics, tooling, and debugger display only. Evaluating it means reimplementing the expression grammar, which is the exact failure this contract removes.

### The HTML projection is not for renderers

`html` exists so hosts that mounted HTML before the tree existed keep working byte-for-byte. It is a serialization of `tree`, downstream of it, and lossy for any vocabulary that is not HTML. A renderer that reads `html` and re-parses it has re-entered the parsing business and reacquired every divergence this contract exists to prevent. `contentType` tells a *host* which surface is meaningful; a renderer reads `tree` unconditionally, including when `contentType` is `"html"`.

### What is left for the renderer

Exactly four things, and all of them are drawing:

1. map `element.name` to a component / widget / DOM node
2. map each prop value to that component's input, converting representation only
3. recurse into `children`
4. decide what hidden means, and what to do with a `severity: "error"` diagnostic

That is the whole tree-walk. If step 2 has to consult anything other than the prop value and the renderer's own vocabulary knowledge, file it as a contract bug.

## Where the contract stops

> **xript owns node *shape*. The vocabulary owner owns node *meaning*.**

xript validates that a prop's value is one of the strings the vocabulary declared. xript must never know what any of those strings mean.

| | xript's | The vocabulary owner's / renderer's |
|---|---|---|
| node names | that a name is declared, and drops it if not | which widget the name is |
| props | that a prop is declared on that node; its type; its `enum`; its sink | what the value does |
| sinks | the sink *mechanism* — uri, style, html, text — and its sanitization | which props declare which sink |
| child rules | the `children` constraint mechanism and its enforcement | which nodes take which children |
| enums | that `borders: "ALL"` is one of the declared strings | that `"ALL"` is `Borders::ALL` |
| binding | resolving `data-bind` and routing it through `bindTo` | which prop a node binds into |
| layout, style, geometry | nothing | everything |

The canonical test case: a Ratatui vocabulary declares `nodes.Block.props.borders.enum = ["NONE","ALL","TOP",…]`. xript validates that a fragment's `borders` is one of those strings, and drops it with a diagnostic if it is not. xript has no idea what a border is, has never heard of Ratatui, and contains the string `"Gauge"` nowhere. The mapping `"ALL"` → `ratatui::widgets::Borders::ALL` is renderer code and must stay renderer code.

What the **vocabulary owner supplies**: a format profile (nodes, props, types, enums, sinks, `bindTo`, `children` constraints) declared in the host manifest under `formats["<media-type>"]`, and a renderer that maps the declared vocabulary onto a component set.

What **xript guarantees in return**: that no node, prop, or value reaching that renderer violates the profile the owner declared, in any of the four runtimes, verified against a shared conformance corpus.

The mechanism ships with xript. The vocabulary ships with the host. Neither reaches into the other.

## The command buffer, both directions

### Inbound: ops a renderer consumes

After a fragment hook runs, the runtime hands the host a finalized op list — already parsed, already vocabulary-checked, already value-sanitized. The renderer applies them to what it drew.

| op | fields | effect |
|---|---|---|
| `toggle` | `target`, `value: boolean` | show the targeted node when `value` is true, hide it when false; a set, not a flip |
| `setText` | `target`, `value: string` | replace the node's text content **as text**, never as markup |
| `setProp` | `target`, `prop`, `value: PropValue` | set a prop; the value keeps its JSON type |
| `removeAttr` | `target`, `prop` | remove the prop from the node |
| `replaceChildren` | `target`, `value: string \| string[] \| FragmentNode[]` | replace the node's children; an empty list clears |

Every op carries `target`, the parsed node reference:

```ts
type NodeRef =
  | { by: "id",   id: string }            // "#name"; resolvable in every vocabulary
  | { by: "path", path: number[] }        // "@0.2.1"; same grammar as FragmentCondition.path
  | { by: "selector", selector: string }; // HTML vocabularies only
```

**A renderer must implement `by: "id"` and `by: "path"`. A renderer must ignore `by: "selector"`** unless it is a DOM renderer — a tree vocabulary never receives one, because the runtime drops selector-targeted ops against a tree vocabulary with an `unsupported-target` diagnostic before the host sees them.

The path sigil is `@` because no CSS selector begins with one, so adding the grammar cannot reinterpret a target that already parsed as a selector. `@` alone and `@media` are still selectors.

`selector` remains on the op as a raw string for DOM hosts that pass it to `querySelectorAll`. It is not part of the tree contract. Resolving targets by re-querying the drawn output, or by matching on expression text, is outside this contract and will collide.

#### A tree path is not a DOM path

A `path` indexes **the tree**, and a host that mounts the `html` projection must not walk that path against the parsed DOM. An HTML parser is free to insert nodes the tree does not contain, and it does: a browser parsing

```html
<table><tr><td data-if="hp < 50">x</td></tr></table>
```

inserts a `tbody`, so the DOM is `table > tbody > tr > td` while the tree is `table > tr > td`. The condition on the cell carries `path: [0, 0, 0]`. Walked against the tree it reaches the `td`; walked against the DOM it reaches the `tr`, and a host applying visibility there hides the whole row. Foster-parenting, implicit `p` closing, and `option`/`select` coercion all diverge the same way.

A path is safe against a tree the host built itself by walking `tree`. It is not safe against markup a parser produced. This is a real constraint on an HTML-projection host today, and it is why such a host still reads the deprecated `visibility` map — the successor is not yet expressible for it.

`setAttr`, `addClass`, and `removeClass` are **not in the contract**. They are HTML sugar; a `xript-tree/1` consumer never receives them, because the runtime expands `setAttr` to `setProp` and drops the class ops against a non-HTML vocabulary. A renderer that ignores unknown op names is already correct if one leaks.

### Outbound: events a renderer emits

The reverse direction is one call, and it is the only thing a renderer sends back:

```
dispatchFragmentEvent(fragmentId, target: NodeRef, event: string, payload?: PropValue)
```

The renderer detects that something happened to a node it drew, names that node the same way an op names one, and hands it back. The runtime matches it against the fragment's declared event handlers, invokes the mod's handler in the sandbox, collects the resulting command buffer, and returns it — which arrives back at the renderer as an inbound batch.

A renderer does not decide which events are wired, does not call mod code, and does not touch the sandbox. `event` is a vocabulary-defined string (`"click"`, `"submit"`, `"select"`), and xript does not know what any of them mean either.

### Ordering

Ops apply in list order. The list is a batch: a renderer should apply all of it before redrawing, not redraw per op. An op whose target resolves to nothing is a no-op, not an error.

## Conformance: what a renderer must do to claim `xript-tree/1`

1. refuse a `contract` string it does not recognize
2. read `tree`; never read `html`; never read `visibility`
3. never evaluate `FragmentCondition.expression`
4. never accept, request, or consult a bindings map
5. ignore unknown element names, unknown props, unknown diagnostic codes, and unknown op names, without failing the render
6. resolve `by: "id"` and `by: "path"` targets
7. apply an op batch in order, redrawing once

A renderer that does all seven is a tree-walk and a switch statement. That is the point.

## Runtime parity

| | `@xriptjs/runtime` | `@xriptjs/runtime-node` | `xript-runtime` (Rust) | `Xript.Runtime` (C#) |
|---|---|---|---|---|
| `contract` on every result | yes | yes | yes | not yet |
| bound, sanitized `tree` | yes | yes | yes | yes |
| path-keyed `conditions` | yes | yes | yes | yes |
| expanded `data-each` and `repeats` patches | yes | yes | yes | yes |
| resolved interpolation in text | yes | yes | yes | yes |
| `diagnostics` | yes | yes | yes | yes |
| ops targetable by `path` | yes | yes | yes | not yet |
| typed (non-stringified) bound values | not yet | not yet | yes | not yet |
| engine-free consumption of the tree types | yes (plain objects) | yes (plain objects) | yes (`xript-tree`) | yes (plain records) |

Nothing in the remaining column is a per-engine fidelity limit. Unlike the debug protocol, where rquickjs genuinely cannot offer a per-line hook, the tree contract asks nothing of the JS engine at all: it is produced after the sandbox has finished. All four can hand back the same shape, and the ways they currently do not are decisions, not constraints.

Parity is held the same way the rest of the fragment surface is: by shared conformance corpora. `spec/fragment-vocabulary-tests.json` and `spec/fragment-op-tests.json` cover the tree and the ops, and `spec/repeat-tests.json` covers expansion and patches; the renderer contract adds no new corpus, it constrains what those already assert.

## Reference implementation

`renderers/ratatui` (`xript-ratatui`) is the reference `xript-tree/1` consumer. It takes `xript-tree` as its only xript dependency, has no bindings map in its public API, and its visibility implementation is one path-prefix lookup.
