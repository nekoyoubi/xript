# Fragment Formats

The fragment protocol is format-agnostic. That sentence has been at the top of this page since the protocol shipped, and until v0.8 it was not true.

What was true is that the *protocol* — slots, fills, `data-bind`, `data-if`, handlers, the lifecycle, the command buffer — never mentioned HTML. What was not true is that the *implementation* honored that. The sanitizer lowercased every node name, dropped every node that was not an HTML element (silently, with no diagnostic), lowercased and allow-listed every attribute name against HTML's attribute set, and stringified every attribute value. A fragment could not carry a node called `Panel`, could not carry a prop called `maxHealth`, and could not carry a value that was a number, a boolean, an array, or an object. The one format the page claimed was universal, JSML, is a case-sensitive open-vocabulary markup language; xript is what narrowed it.

This page describes the model that makes the opening claim honest.

## The Thesis

A fragment format is **a syntax plus a scope of node vocabularies, declared by the host**. A vocabulary is nodes and props; a prop's declared **sink** says where its value lands, and that — not the node's name — is the only thing sanitization ever needed to know.

Every rule below follows from that one sentence.

Consider why `href` is dangerous. It is not dangerous because of the string `"href"`. It is dangerous because a component eventually hands its value to something that navigates. `maxHealth` is not dangerous, because nothing ever hands its value to anything that navigates. The old sanitizer could not tell these apart, so it did the only thing an HTML-shaped sanitizer can do: it assumed every node was an HTML element and every value was a string that would be pasted into an HTML attribute, and it rejected everything it could not recognize as such.

xript cannot know which props are dangerous. The vocabulary's owner can — and the vocabulary's owner is the host. So the host says so, once, in the manifest, and the runtime routes exactly those values through exactly the sanitizer they need.

This is strictly *more* precise than what came before. Nothing was thrown away. The sanitizers still exist and still do the same work. They just stopped running blindly over the whole document and started running where the vocabulary says a value is dangerous.

## Declaring a Format

A host declares its fragment formats in a top-level `formats` block, a sibling of `slots`. A format's key is the media type a slot's `accepts` names. A format says how a fill is parsed and which node vocabularies are in scope while it is read; the smallest useful declaration puts its nodes inline, and the next section covers naming them so several formats can share one set.

```json
{
  "formats": {
    "application/x-panel+json": {
      "description": "The component vocabulary the sidebar renderer speaks.",
      "syntax": "j5ml",
      "nodes": {
        "Panel": {
          "description": "A titled container.",
          "props": {
            "heading": { "type": "string" },
            "collapsible": { "type": "boolean", "default": false }
          }
        },
        "Link": {
          "children": "text",
          "props": {
            "href": { "type": "string", "sink": "uri" }
          }
        },
        "Icon": {
          "children": "none",
          "props": {
            "svg": { "type": "string", "sink": "html" }
          }
        },
        "Progress": {
          "children": "none",
          "bindTo": "value",
          "props": {
            "value": { "type": "number" },
            "max": { "type": "number", "default": 100 }
          }
        }
      }
    }
  },
  "slots": [
    { "id": "sidebar.left", "accepts": ["application/x-panel+json"], "multiple": true }
  ]
}
```

### Format Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `syntax` | `"j5ml"` \| `"jsml"` \| `"html"` | yes | — | How a fill's `source` is parsed. `j5ml` reads JSON in J5ML array form; `html` tokenizes an HTML string. `jsml` is a deprecated spelling of `j5ml` and parses identically. |
| `vocabularies` | string[] | see below | — | The node vocabularies in scope, in resolution order. Entries are built-in ids or ids declared in the top-level `vocabularies` block. |
| `nodes` | object | see below | — | An inline, single-use vocabulary, always first in resolution order. At least one entry when present. |
| `schemes` | string[] | no | `["http", "https", "mailto", "data"]` | The URI schemes a `uri` or `image-uri` sink admits, named without the colon. A declaration **replaces** the default rather than extending it. See [Which Schemes a URI Sink Admits](#which-schemes-a-uri-sink-admits). |
| `description` | string | no | — | What the format is for. Shown in generated docs. |
| `refines` | boolean | no | `false` | Marks this format as a refinement of a base manifest's format of the same id. See [Inheritance](#inheritance). |

A format must admit at least one node: it carries a `nodes` block, or a non-empty `vocabularies` array, or both. A declaration with neither is refused.

`syntax` is a closed enum on purpose. Its value names a parser the runtime must actually possess; an unrecognized value has nothing to fall back on, so there is no such thing as a "custom syntax" a manifest can name into existence. A format is a *scope* declaration, not a parser declaration. If your renderer speaks JSON node trees, its syntax is `j5ml`.

## Vocabularies

A format welds together two questions that are not the same question: *how is this authored*, and *what nodes may it contain*. `syntax` answers the first. `vocabularies` answers the second, and it answers it by reference, so the same answer can be given to several formats without being written down twice.

A **vocabulary** is nodes and their props, and nothing about how they are authored. It is declared in a top-level `vocabularies` block, a sibling of `formats`.

```json
{
  "vocabularies": {
    "acme.components": {
      "description": "The component set the design system ships.",
      "nodes": {
        "acme-icon": {
          "children": "none",
          "props": { "name": { "type": "string" } }
        },
        "acme-panel": {
          "props": { "heading": { "type": "string" } }
        }
      }
    }
  },
  "formats": {
    "text/x-acme-html": {
      "description": "The library's own components, authored as HTML.",
      "syntax": "html",
      "vocabularies": ["acme.components", "html"]
    },
    "application/x-acme+json": {
      "description": "The same components, exposed to mods. No HTML in scope.",
      "syntax": "j5ml",
      "vocabularies": ["acme.components"]
    }
  }
}
```

Those two formats share one declaration of `acme-icon` and `acme-panel`. The first is authored as HTML with the whole built-in HTML vocabulary reachable behind the components, which is what a component library's own pages want. The second parses J5ML and reaches nothing but the components: a mod filling it can contribute an `acme-panel` and cannot contribute a `<div>`, a `<style>`, or anything else HTML-shaped, because HTML is simply not in scope. Same nodes, different syntax, different scope, declared once.

That separation is the point. A vocabulary that could only be reached through the format that declared it would force a host wanting both surfaces to maintain two copies of the same node table and keep them honest by hand.

### Vocabulary Ids

A host-declared vocabulary id is two or more lowercase dot-separated segments: `acme.components`, `xript.ratatui.widgets`. A **single**-segment id names a built-in vocabulary. There is currently exactly one, `html`, and it is the built-in HTML element and attribute allow-list described under [The Built-In Vocabulary](#the-built-in-vocabulary).

The two grammars are disjoint by construction, which buys two things. A reader can tell what kind of thing a reference names without looking it up, and a host can never shadow a built-in, because the schema will not let it declare a single-segment id in the first place.

### Scope

A format's **scope** is the ordered list of vocabularies a node name may be resolved through. It is built like this:

1. If the format carries a `nodes` block, that inline vocabulary goes first.
2. Then each entry of `vocabularies`, in the order written.

Resolution walks the scope in order and **the first vocabulary that claims a node name wins**. Order is authoritative and literal: there is no implicit reordering, no merge of two same-named declarations, and no error when two vocabularies both declare a name. `xript lint` reports the shadowing as `vocabulary-node-shadowed` at info severity, so it is visible without being fatal.

Default-deny is unchanged. A node resolvable through none of the vocabularies in scope raises `unknown-node`, at error severity for a host-declared scope and at warning severity for a built-in format. A format whose scope is exactly its inline `nodes` admits those nodes and nothing else.

> A format's `nodes` block is exactly equivalent to declaring a vocabulary containing those nodes and naming it as the first entry of `vocabularies`, except that the resulting vocabulary has no id and cannot be referenced by any other format.

That non-referenceability is the whole reason inline `nodes` survives as sugar rather than becoming a second way to declare a shared vocabulary. The rule for choosing: **name a vocabulary when more than one format will speak it; inline it otherwise.**

### `html` Goes Last

When the built-in `html` vocabulary appears in a format's `vocabularies`, it must be the **last** entry. An HTML element name may only be reached after every declared vocabulary has declined it.

This is the structural form of a guarantee the model has always made: a declared node wins over a same-named HTML element. With one vocabulary per format that guarantee was automatic. With several, it has to be enforced, and enforcing it as an ordering rule at declaration time is cheaper and far more legible than special-casing HTML inside the resolution walk. A host that lists `["html", "acme.components"]` is asking for its own `acme-panel` to be unreachable if HTML ever grows an element by that name, which is not a thing anyone means.

### Refusals

A format whose scope cannot be built is refused outright; the format does not resolve and fills naming it do not mount.

| Condition | What it means |
|-----------|---------------|
| An entry names no declared vocabulary | The id is well-formed but nothing in the top-level `vocabularies` block declares it. |
| A single-segment entry that is no built-in | The reference is shaped like a built-in and is not one. Built-ins are `html`. A host-declared id needs two or more dot-separated segments. |
| `html` present but not last | See [`html` Goes Last](#html-goes-last). |
| Empty scope | No inline `nodes` and no non-empty `vocabularies`. The format admits nothing. |
| A stripped element name shadowed | See below. |

The schema refuses the empty-scope case before a runtime ever sees it. Runtimes refuse it anyway: a runtime does not require its manifest to have passed `xript validate`, and a profile can be built by hand.

### Stripped Names May Not Be Shadowed

The sanitizer's strip list — `script`, `iframe`, `object`, `embed`, `form`, `base`, `link`, `meta`, `title`, `noscript`, `applet`, `frame`, `frameset`, `param`, `foreignObject`, `animate`, `set` — names elements that are removed with their subtree wherever they appear. A vocabulary in scope alongside the built-in `html` vocabulary **may not declare a node whose lowercased name is on that list.** The format is refused.

The check exists because the strip decision lives inside the HTML arm of resolution. A declared node with a stripped name is reached first, never touches that arm, and survives into the tree the host receives — a `script` node handed to a renderer that may well be a DOM. With everything inline in one format that was an odd thing to type. With named vocabularies it can arrive from an `extends` base the host did not author and did not read, which is precisely the case where a warning would be seen by no one.

Without `html` in scope the name carries no meaning worth protecting: a `script` node in a pure J5ML widget vocabulary is a node called `script` and nothing more. There it resolves normally, and `xript lint` notes it at info severity.

### Vocabularies Contribute Nodes, Never Attributes

A declared vocabulary adds **nodes**. It never adds attributes to HTML elements, and it cannot widen the built-in HTML attribute allow-list for elements resolved through the `html` vocabulary. That is why names like `slot` and `part` are in the built-in list rather than being something a host adds from the side.

The rule is easy to lose sight of once several vocabularies are in scope at once, so it is worth stating flatly: scope changes which *names* resolve, not what the HTML rules do once a name has resolved as HTML.

### Containment Is a Separate Axis, and It Defaults Open

A vocabulary declares what a node **is**. It never declares what a node may **parent**.

Anything in scope may nest inside anything else in scope. Two nodes from different vocabularies compose without either vocabulary knowing the other exists, and a vocabulary shared by two formats does not acquire different containment rules in each. Containment narrows only where a node explicitly narrows it, through its own `children` field — which is per node, not per vocabulary, and is unaffected by which vocabulary a candidate child came from.

Defaulting open is the same call the rest of the manifest makes: the restriction has to buy something. A closed-by-default containment model would require every vocabulary to enumerate its permitted children before it composed with anything, which is a large amount of declaration in exchange for a constraint most hosts express better in their renderer.

### Routing an Op's Value Across Scope

`setProp` resolves a prop's sink by **union across the entire resolved scope**, and an ambiguous sink is refused. Every node declared by every vocabulary in scope is consulted; if two of them declare the prop with different non-`text` sinks, the op is refused with `prop-sink-conflict`. First-listed-wins does not apply.

This is not an exception to first-listed-wins; it is a different question that first-listed-wins never answered.

Node resolution asks *which vocabulary owns this **name***. There is a name, the author put the vocabularies in an order, and order disambiguates it — first listed wins.

An op names a prop but never the node it lands on. There is no name to order and nothing to disambiguate against, so resolution order carries no information here at all. Picking the first-listed vocabulary's sink would mean a prop's sanitizer is chosen by an ordering the author wrote for *node shadowing*, silently reused for a decision about *where a value lands* — the worst kind of coupling, because it is invisible and it fails toward the less strict sink. So the sink is resolved by union and an ambiguous sink is not a sink: the op is refused rather than guessed.

This is not new policy. Op routing already unions over every node in a single format and already refuses on conflicting non-`text` sinks; scope simply widens the set of nodes it unions over. The behavior a host sees for a one-vocabulary format is unchanged.

Two consequences follow, and both are load-bearing:

- The union spans the **entire** scope, not the first vocabulary that declares the prop.
- The built-in HTML sink fallback fires only when no declared vocabulary in scope declares the prop, and it is **position-independent**: because this is not a name lookup, `html`'s last-place requirement does not gate it.

### Vocabulary Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `nodes` | object | — | Required. The node table. At least one entry. |
| `description` | string | — | What the vocabulary is for. Shown in generated docs. |
| `refines` | boolean | `false` | Marks this vocabulary as a refinement of a base manifest's vocabulary of the same id. See [Inheritance](#inheritance). |

### Node Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `props` | object | `{}` | The props this node accepts, each a JSON Schema. Default-deny: an undeclared prop is dropped and reported. |
| `children` | `"any"` \| `"none"` \| `"text"` \| `string[]` | `"any"` | What may appear inside. `"none"` is a void node; an array is an explicit list of permitted child node names. The default is open across the whole scope — see [Containment Is a Separate Axis](#containment-is-a-separate-axis-and-it-defaults-open). |
| `bindTo` | string | `"children"` | Where a resolved `data-bind` value is written. See [Binding into a vocabulary](#binding-into-a-vocabulary). |
| `description` | string | — | Shown in generated docs. |
| `refines` | boolean | `false` | Marks this node as a refinement of a base manifest's node of the same name, in the vocabulary or format that declares it. |

Node names are **case-sensitive** and matched verbatim. `Panel` and `panel` are different nodes. One optional namespace segment is permitted (`svg:rect`).

Five **protocol props** are legal on every node of every vocabulary and never need declaring: `id`, `data-bind`, `data-if`, `data-each`, and `data-key`. They are always strings, they are never sanitized (they are inert by construction), and they are never dropped. `id` is universal because it anchors the [node-reference model](#node-references); without it, a component node could not be targeted by an op or a handler.

One prop name is universally *illegal*: any prop beginning with `on`. That is a hard floor, not an allow-list decision. `xript validate` errors if a vocabulary declares one, and the runtime rejects one at every layer.

## The Safety Model

A prop's body is a JSON Schema. `sink` is the one xript-specific keyword inside it, and it declares where the value lands.

| `sink` | The value is… | What the runtime runs |
|--------|---------------|-----------------------|
| `text` (default) | inert data | nothing |
| `uri` | a navigational URL | the URI sanitizer in `href` mode: `javascript:`, `vbscript:`, and **all** `data:` URIs rejected |
| `image-uri` | a media source | the URI sanitizer in `src` mode: as above, except safe `data:image/(png\|jpeg\|gif\|svg+xml)` permitted |
| `css` | an inline style value | the style sanitizer: `url()`, `expression()`, `-moz-binding`, and `behavior:` stripped |
| `html` | a raw markup string the component will inject | the HTML sanitizer, in full |

**A prop with no `sink` is inert data.** A number, a boolean, an enum, an array, an object, a plain string that a component reads and never renders as markup — none of it ever becomes markup, so there is nothing to sanitize, and pretending otherwise is exactly what `String(val)` was doing.

`uri` and `image-uri` are two sinks rather than one because the URI sanitizer genuinely has two behaviors, and until now it picked between them by *guessing from the attribute name*. A vocabulary owner has to be able to say which one they mean: a `Link.href` must not accept a `data:` URI; an `Avatar.src` must.

`html` exists because a component that takes a raw SVG string is a real, common shape. Without a sink for it, that component has no safe path at all, and every host will invent an unsafe one — a hole with no door is a hole people climb through.

Two rules bind the model:

- **A sink other than `text` requires `"type": "string"`.** `xript validate` errors (`sink-requires-string`) if it does not. At runtime, a non-string value at a non-`text` sink is dropped with an `invalid-prop` diagnostic.
- **A bound value written to a prop routes through that prop's sink.** Otherwise `data-bind` would be a straight injection bypass on any `sink: "html"` prop.

A sink that *rejects* a value (the URI sanitizer returning nothing) drops the prop with an `unsafe-prop` diagnostic. A sink that *cleans* a value writes the cleaned value with no diagnostic, matching how HTML attribute sanitization has always behaved.

### Which Schemes a URI Sink Admits

The `uri` and `image-uri` sinks resolve a value against an **allow-list of schemes**, declared per format as `schemes`. Absent, it is the default safe set:

```json
["http", "https", "mailto", "data"]
```

A format that declares the key **replaces** that set wholesale. It does not extend it, and there is no syntax for extending it — one key both widens and narrows, which is the point:

```json
{
  "formats": {
    "application/x-panel+json": {
      "syntax": "j5ml",
      "schemes": ["https", "mailto", "tauri"],
      "nodes": {
        "Link": { "children": "text", "props": { "href": { "type": "string", "sink": "uri" } } }
      }
    }
  }
}
```

That host resolves its own `tauri:` scheme and no longer resolves plain `http:`. Both facts come out of the same declaration, and neither is expressible against a deny-list, which was the shape this replaced: a deny-list can only ever say what is already known to be bad, so a host with a scheme of its own had no way to say so, and a host that wanted `https` alone had no way to say that either.

Replace-not-extend is the rule because the alternative reads as a trap. A key that unioned with the default would make narrowing impossible — declaring `["https"]` would silently still admit `http`, `mailto`, and `data`, and a host tightening its surface would believe it had done so. A set that says exactly what it says has no such failure mode. The cost is that a host widening the default restates it: `["http", "https", "mailto", "data", "tauri"]` is the whole declaration, not the delta.

#### Under `extends`

> **Absent inherits. Present replaces wholesale. `[]` means deliberate closure.**

The same three-line rule `vocabularies` follows, for the same reason. A refining child that carries no `schemes` key inherits the base's set unchanged. A child that carries one replaces the base's set entirely. An empty array is a present value, not an absent one: it closes the format to absolute URLs completely, and `xript lint` notes it as `closed-schemes` at info severity so it reads as a decision rather than a typo.

#### The Floor

`javascript` and `vbscript` are not schemes a host may grant. They are refused at three independent layers:

| Layer | What happens |
|-------|--------------|
| `spec/manifest.schema.json` | the manifest does not validate — the scheme grammar excludes both names |
| `xript lint` | reports `prohibited-scheme` at error severity |
| The sink itself | refuses the value regardless of the set it was handed |

Three layers for one rule is deliberate. The schema catches it at authoring time, `lint` catches it in CI with a message explaining why, and the sink catches it in a runtime whose profile was built by hand and never passed through either. A profile built by hand is not hypothetical: a runtime does not require its manifest to have been validated.

Naming one is an **error rather than a silent no-op**. The declaration would have no effect either way, but a manifest that reads as though it permits `javascript:` misrepresents the format to everyone who reads it afterward, including `docgen`. Better to refuse the manifest than to ship a lie that happens to be harmless.

#### `data:` Is Unchanged

Listing `data` grants exactly what it always granted, and the allow-list adds nothing to it. The gate is the one the sink model already described: `data:` passes on an **image sink only**, and only for `image/png`, `image/jpeg`, `image/gif`, and `image/svg+xml`. A `data:` URI on a `uri` sink is refused whether or not `data` is in the set; a `data:text/html` is refused on either sink.

The scheme list decides *whether the scheme is reachable at all*. What a reachable scheme then permits is the sink's business, and `data` is the one scheme with more to say on the subject.

#### Values With No Scheme Are Never Consulted

The list governs absolute URLs. A value that carries no scheme is relative, is not a navigation to anywhere in particular, and never reaches the allow-list:

| Value | Shape |
|-------|-------|
| `about.html` | relative |
| `/assets/icon.png` | absolute-path |
| `//cdn.example.com/x.js` | scheme-relative |
| `#anchor` | fragment-only |
| `?q=1` | query-only |

All five survive whatever `schemes` says, including `[]`. The scheme pattern is anchored, so a value matching nothing returns before the list is consulted at all — closure closes absolute URLs, not links.

This is the same distinction that keeps JSON Schema's `format: "uri"` out of the safety model: `/img/icon.png` is safe and extremely common, and a rule that treats "has no scheme" as "suspicious" fights the data every time.

The scheme is read from the **normalized** value — after tab, newline, and control-character stripping, and tolerating whitespace before the colon. Reading it from anything less normalized would put the allow-list behind the same smuggling trick (`java&#9;script:`) that normalization exists to defeat.

### Shape at Runtime, Schema at Validate

The prop body is a full JSON Schema, but the two readers of it enforce different amounts.

> The **runtime** enforces the vocabulary's *shape*: it checks the `type` keyword, and nothing else.
> **`xript validate`** enforces the vocabulary's *schema*: `enum`, `pattern`, `minimum`, `format`, and everything else the body declares.

That split is deliberate. Safety is delivered entirely by the sink model, and a sink only ever needs to know "is this a string". Shipping a full JSON Schema validator inside a QuickJS-WASM sandbox package so it can check a `minimum` on a number that will never become markup is not a trade worth making. The constraints still get enforced — they get enforced in CI, where a violation is a build failure instead of a dropped prop.

`format` remains available inside a prop body as an ordinary JSON Schema annotation. It is **not** the safety keyword; `sink` is. The two are easy to conflate and must not be: JSON Schema's `uri` format rejects a relative URL like `/img/icon.png`, which is a perfectly safe and extremely common value. Routing safety decisions through a keyword whose validation semantics fight the data is a bug factory. `sink` says where the value lands. `format` says what the string looks like. Only one of them is load-bearing.

### Default-Deny, and What "Deny" Means

| Situation | Declared vocabulary | Built-in HTML vocabulary |
|-----------|--------------------|-----------------------|
| Undeclared node | **error** — the mod fails to load | dropped, `warning` diagnostic |
| Undeclared prop | dropped, `warning` diagnostic | dropped, `warning` diagnostic |
| Prop value fails the schema's `type` | dropped, `warning` diagnostic | dropped, `warning` diagnostic |
| Child violates the node's `children` rule | dropped child, `error` | dropped child, `warning` |
| A prop named `on…` | rejected, always | rejected, always |
| `script`, `iframe`, `object`, … | n/a (not in the vocabulary) | stripped with its subtree, `warning` |

The asymmetry on the first row is the deliberate part, and it is worth stating why.

HTML is an **open, externally-defined** language. xript's allow-list covers roughly ninety of its hundred-plus elements; the rest of the language keeps growing without asking. A host that ships a `<dialog>` in an HTML fragment today gets it dropped, silently, and its page still works. Hardening that to a hard failure would break working hosts and buy no safety at all, because the node was already being dropped — it was already inert. So the built-in vocabulary gets the diagnostic it was always missing, and keeps its permissive drop. (`strictHtmlVocabulary` on the runtime options promotes it to an error for hosts that want the tighter contract.)

A host-declared vocabulary is a **closed contract the host authored**. There is no upstream adding nodes to it. An unknown node there means the mod is speaking a language the host does not have, and quietly rendering nothing is a lie — the mod believes it contributed a `Panel`; the user sees a hole. That was the original bug, and the fix is to say so out loud.

Undeclared *props* are dropped in both worlds, never fatal, always reported.

### An Element's Reachable Props

The props a fragment can set on a node are the ones the vocabulary lists for it, plus the protocol props (`id`, `data-bind`, `data-if`) and the inert `data-*`/`aria-*` prefixes. They are **not** the attribute surface of whatever component the host eventually renders. A host that maps `x-chart` onto a charting widget with forty options has exposed exactly the options its vocabulary declares; the other thirty-odd are unreachable from a fragment until the host names them. That is the closed-props rule below applied at authoring time, and it is what keeps a renderer from receiving a value nobody reviewed.

Every path a prop value can take is held to that list, and every refusal is reported rather than silent:

- **In the source.** An undeclared prop is dropped with an `unknown-prop` warning.
- **Through `data-bind`.** A bound value aimed at a prop the node does not declare (a `bindTo` naming an undeclared prop, or the implicit `value` target of a void node that declares none) writes nothing and raises `unknown-prop` on the `getContent()` result. A bound value the prop's sink rejects raises `unsafe-prop`. Bind-time diagnostics follow the sanitizer's own in the result's `diagnostics`, with a path into the bound tree.
- **Through `replaceChildren`.** The markup or node list an op carries is sanitized against the same vocabulary, and every finding the nested pass makes is reported through `onFragmentDiagnostic`, its path prefixed with the op's (`/0` + `/1/0` = `/0/1/0`). For a list of markup strings the item's index sits between them: `/0/2/1` is node `/1` of item 2 of op 0. A nested finding keeps the severity the sanitizer gave it; the op still applies with the offending node or prop removed.

### Diagnostics

Everything the sanitizer drops, cleans, or refuses is reported. A diagnostic carries a code, a severity, an index path into the tree (`/0/2/1`), the node name, and the prop name where one applies.

| Code | Raised when |
|------|-------------|
| `unknown-node` | the node is not in the vocabulary |
| `stripped-node` | the node is in the strip list (`script`, `iframe`, …) and was removed with its subtree |
| `unknown-prop` | the prop is not declared on this node |
| `invalid-prop` | the value failed the prop's JSON Schema `type` |
| `unsafe-prop` | the prop's sink rejected the value (a `javascript:` URI, say) |
| `illegal-child` | the child violated the node's `children` rule |
| `unsupported-op` | a command-buffer op has no meaning in this vocabulary (`addClass` on a tree format) |
| `unsupported-target` | a CSS-selector target was used against a non-HTML vocabulary |

Diagnostics reach the host three ways, and all three are additive: on `FragmentInstance.diagnostics`, on every `getContent()` result, and through an `onFragmentDiagnostic` callback on the runtime options (which is how op-time findings surface, since ops are produced long after load). Any `error`-severity diagnostic at load time throws instead: the fill does not mount.

### Why Props Are Closed and Slot Payloads Are Open

A slot's `payload` is open by default: an extra key on a fill's payload passes validation and the host ignores it. A node's `props` is closed by default: an extra prop is dropped. That looks like an inconsistency. It is not, and the rule that separates them is the same one the whole safety model turns on.

> A slot payload is data **the host reads**. An extra key is inert: the host ignores what it does not know.
>
> A node prop is a value **that lands in a rendered tree the host hands to a renderer**. An unknown prop reaches the renderer, and the renderer may do anything with it, including spreading it onto a DOM element. An unknown prop is an unreviewed value in a rendering position.
>
> The question, in both cases, is: *where does this value land?*

## The Tree Contract

The runtime hands the host a sanitized **tree**, not only a flattened HTML string.

```
FragmentNode  = FragmentElement | FragmentText
FragmentText  = { kind: "text",    value: string }
FragmentElement = {
  kind: "element",
  name: string,                        // case preserved, exactly as the vocabulary declares it
  props: Record<string, PropValue>,    // declaration order preserved
  children: FragmentNode[]
}
PropValue     = string | number | boolean | null | PropValue[] | { [k: string]: PropValue }
```

The array and object variants of `PropValue` are not speculative. xript's own shipped `application/x-ratatui+json` format writes `"gauge_style": {"fg": "Green"}` and `"constraints": ["Length:1"]`. A tree model without them cannot represent a format xript already documents, which is a fair summary of how the old model got where it got.

The element is **tagged** rather than JsonML's positional array because the array form is ambiguous at position 1 — a plain object there is props, anything else is a child — and that ambiguity is what forced heuristics into the sanitizer. The tagged tree is unambiguous and cheaply walkable, and it round-trips: a JSML source parses to a tree, and a tree serializes back to JSML.

`getContent()` returns the bound tree for **every** format, HTML included, alongside a `contentType` discriminator:

```ts
{
  contract: "xript-tree/1";
  fragmentId: string;
  format: string;
  contentType: "html" | "tree";
  html: string;                        // the bound HTML serialization; "" when the format has no HTML projection
  tree: FragmentNode[];                // always present
  conditions: FragmentCondition[];     // every data-if, keyed by tree position
  repeats: FragmentRepeat[];           // every data-each expansion, with keys and an update patch
  visibility: Record<string, boolean>; // DEPRECATED, text-keyed, collides. Read `conditions`.
  diagnostics: FragmentDiagnostic[];
}
```

`html` stays a required, non-optional string. Existing hosts read `.html` and mount it, and they keep working byte-for-byte. A host that renders components reads `.tree` and walks it. `contentType` says which one is meaningful.

A host-declared format that is HTML plus custom elements (the built-in `html` vocabulary in scope, and every declared node a valid custom element name) has an HTML projection even though its `contentType` is `"tree"`, and `getContent()` fills `html` from the bound tree for it exactly as it does for a built-in format. Any other declared format leaves `html` empty.

### Structured Props in the HTML Projection

A prop keeps its JSON type in the tree. When the tree is projected to HTML, a structured value has to become attribute text, and JavaScript's `String()` turns an object into `[object Object]`, which is never what anyone meant. So the projection encodes it instead:

| Value | Prop declared `type: "array"` or `"object"` | Otherwise |
|-------|-------------------------------------------|-----------|
| a plain object | JSON | JSON |
| an array holding an object at any depth | JSON | JSON |
| an array of scalars | JSON if the declared type includes `array` | comma-joined `String()` form (`1,2,3`), as before |
| a scalar | `String()` | `String()` |

Declared types come from the vocabulary in scope (props are JSON Schema bodies, so `type` may be a name or a list of names). A built-in HTML node declares no types, so its props follow the right-hand column.

The JSON is canonical so every runtime writes the same bytes: compact, `JSON.stringify` string escaping and number formatting, and **object keys ordered by Unicode code point**. Key order is fixed rather than inherited from the source because not every runtime's JSON object type remembers insertion order, and a projection that varied by runtime would break the parity the corpora hold. The encoded text is then attribute-escaped like any other value.

### Binding into a Vocabulary

`data-bind`, `data-if`, and `data-each` work the same in every vocabulary. A repeat copies whatever node carries it, `Row` as readily as `li`, and each copy is held to the same vocabulary as the template. What changes is *where* a bound value lands, and the node's `bindTo` says so.

- **`bindTo: "children"` (the default)** — the node's children are replaced with a single text node. This is the HTML `<span data-bind="health">` behavior.
- **`bindTo: "<prop>"`** — the value is written to that prop, **through that prop's sink**. This is the HTML `<input data-bind="name">` behavior generalized: an `<input>` binds to `value` because it is void, and a `Progress` binds to `value` because its vocabulary says so.

A void node (`children: "none"`) defaults to `bindTo: "value"`. Everything else defaults to `"children"`. `xript validate` errors (`bind-target-undeclared`) if a node's `bindTo` names a prop the node does not declare.

`data-if` never prunes the tree. It evaluates the expression and reports the result in `visibility`; the host decides what "hidden" means for its renderer. Fragments stay inert.

## Node References

There is **one** targeting model, and it works in every vocabulary.

> A target string is an **ID reference** if it matches `^#[A-Za-z][A-Za-z0-9_.:-]*$`. It resolves to the node whose `id` prop equals that name, in any vocabulary. Any other string is a **CSS selector**, which is meaningful only for HTML-vocabulary formats; on a tree format it is dropped with an `unsupported-target` diagnostic.

This applies to both places a fragment is targeted: a fill's `handlers[].selector`, and the `selector` argument of every command-buffer op.

An earlier version of this page claimed that terminal formats used "widget IDs (`#heal-button`) instead of CSS selectors", describing a second targeting model. No such model was ever implemented. There was one implemented model and one documented ghost. The grammar above is the reconciliation, and it costs nothing: `#heal-button` is simultaneously a valid CSS ID selector, so an HTML host that resolves the raw string with `querySelectorAll` gets exactly the node it always got, while a component host reads the parsed `target` and matches on `id`.

## The Built-In Vocabulary

One vocabulary is **built in**: `html`, the HTML element and attribute allow-list. It lives in code rather than in a manifest, because it is ninety-odd elements against a global attribute allow-list, and expressing it as manifest JSON would fork the sanitizer's rules a fourth time to no one's benefit. It is referenced from a format's `vocabularies` exactly like any host-declared vocabulary, and it is the only id a format may reference without declaring.

The built-in formats each bring that one vocabulary into scope and declare nothing ahead of it.

| Format | `syntax` | Scope | `contentType` | Notes |
|--------|----------|-------|---------------|-------|
| `text/html` | `html` | `html` | `html` | The canonical HTML format. |
| `text/html+jsml` | `html` | `html` | `html` | **Deprecated alias of `text/html`.** Identical behavior. |
| `application/j5ml+json` | `j5ml` | `html` | `html` | JSON-native HTML. |
| `application/jsml+json` | `j5ml` | `html` | `html` | **Deprecated alias of `application/j5ml+json`.** Identical behavior. |

Three further media types are **reserved** and never sanitized, because they carry no markup at all: `application/x-xript-role`, `application/x-xript-hook`, and `application/x-xript-command`. They name slot kinds rather than syntaxes; when a slot's `accepts` lists more than one, they are matched in that order. See [commands.md](./commands.md#slot-kind-precedence).

**A host cannot redeclare a built-in or reserved id in `formats`.** The schema forbids it, and `xript validate` errors (`builtin-format-redeclared`). Allowing it would be a footgun: declaring `formats["text/html"]` would silently change the format's `contentType` and empty every existing host's `.html`. A host that wants a component vocabulary registers **a new media type of its own**.

**A manifest with no `formats` block behaves exactly as it did before v0.8.** That is the entire back-compat story, and it is structural rather than a special case: a built-in format's scope is the built-in `html` vocabulary and nothing else, so every lookup reaches the HTML rules, which are unchanged.

### Unknown Formats

A fragment fill whose `format` resolves to no vocabulary — not built in, not declared — is now a **hard error at load** in the JS and Node runtimes.

It used to fall through to the HTML sanitizer. A typo'd media type would run a JSON document through an HTML tokenizer and hand the host the wreckage, which is the sort of thing that turns into a bug report about "JSML being broken". The sanitizer package itself already errored in this situation; the runtimes did not. The runtimes were wrong.

A fill is a **fragment fill** if and only if it carries both a string `format` and a string `source`. Code-renderer fills (which carry `entry`) and pure-data fills (which carry neither) are not fragments, are never sanitized, and are unaffected by this rule.

## The Formats, Recast

### `text/html`

The default for web hosts. The built-in vocabulary, HTML syntax, unchanged in every particular.

```html
<div class="health-panel">
  <div class="player-name" data-bind="name">Unknown</div>
  <div class="health-bar">
    <span data-bind="health">0</span> / <span data-bind="maxHealth">0</span>
  </div>
  <div data-if="health < 50" class="warning">Low health!</div>
  <div data-if="health < 20" class="critical">Critical!</div>
</div>
```

Needs no `formats` entry. Node names are case-insensitive (`DIV` normalizes to `div`), attribute names are case-insensitive, values are strings, and the allow-lists are the ones in [the fragment protocol](./fragments.md#the-built-in-html-vocabulary).

### `application/j5ml+json`

The same structure as nested JSON arrays. No escaping, no HTML parser, JSON-native. (`application/jsml+json` is a deprecated alias that behaves identically.)

```json
["div", {"class": "health-panel"},
  ["div", {"class": "player-name", "data-bind": "name"}, "Unknown"],
  ["div", {"class": "health-bar"},
    ["span", {"data-bind": "health"}, "0"],
    " / ",
    ["span", {"data-bind": "maxHealth"}, "0"]
  ],
  ["div", {"data-if": "health < 50", "class": "warning"}, "Low health!"],
  ["div", {"data-if": "health < 20", "class": "critical"}, "Critical!"]
]
```

**Shape:** `["tag", {props}, ...children]`. First element is the node name. An optional second element is a props object. Everything after is children — strings for text, arrays for elements.

Also built in, and it also brings the built-in `html` vocabulary into scope, which is why the example above is HTML tag names. JSML the *notation* has always been able to carry any vocabulary; it is `formats` and `vocabularies` that let a host say which ones.

The fill lives in the mod manifest under `fills`, keyed by the host slot id:

```json
{
  "fills": {
    "sidebar.left": [
      {
        "format": "application/j5ml+json",
        "source": "fragments/panel.j5ml.json",
        "bindings": [
          { "name": "health", "path": "player.health" },
          { "name": "maxHealth", "path": "player.maxHealth" },
          { "name": "name", "path": "player.name" }
        ]
      }
    ]
  }
}
```

The former top-level `fragments[]` array (a flat list of `{ slot, format, source, bindings }` entries) is a deprecated alias; each legacy fragment's `slot` becomes the `fills` key. Validators still accept it with a deprecation warning. See [the fragment protocol](./fragments.md) for the full fill shape.

### `application/x-ratatui+json`

For Rust terminal applications using [Ratatui](https://ratatui.rs). Widget names map 1:1 to Ratatui structs. Layouts split on constraints. This is the format that proves the model, because it is the one xript already shipped that the old sanitizer could not have represented: PascalCase names, snake_case props, object values, array values.

The host declares it:

```json
{
  "formats": {
    "application/x-ratatui+json": {
      "description": "Ratatui widget tree. Node names are Ratatui struct names.",
      "syntax": "j5ml",
      "nodes": {
        "Block": {
          "props": {
            "title": { "type": "string" },
            "borders": { "type": "string", "enum": ["NONE", "ALL", "TOP", "BOTTOM", "LEFT", "RIGHT"] },
            "border_type": { "type": "string", "enum": ["Plain", "Rounded", "Double", "Thick"] },
            "border_style": { "type": "object" }
          }
        },
        "Layout": {
          "props": {
            "direction": { "type": "string", "enum": ["Horizontal", "Vertical"] },
            "constraints": { "type": "array", "items": { "type": "string" } }
          }
        },
        "Paragraph": {
          "props": {
            "alignment": { "type": "string", "enum": ["Left", "Center", "Right"] },
            "style": { "type": "object" }
          }
        },
        "Line": { "props": { "style": { "type": "object" } } },
        "Span": {
          "children": "text",
          "props": { "style": { "type": "object" } }
        },
        "Gauge": {
          "children": "none",
          "bindTo": "ratio",
          "props": {
            "ratio": { "type": "number", "minimum": 0, "maximum": 1 },
            "ratio_bind": { "type": "object" },
            "gauge_style": { "type": "object" }
          }
        }
      }
    }
  }
}
```

And a mod fills it:

```json
["Block", {
    "title": "Health",
    "borders": "ALL",
    "border_type": "Rounded",
    "border_style": {"fg": "Cyan"}
  },
  ["Layout", {"direction": "Vertical", "constraints": ["Length:1", "Length:1", "Length:1"]},
    ["Paragraph", {"alignment": "Left"},
      ["Line", {},
        ["Span", {"style": {"fg": "Gray"}}, "Player: "],
        ["Span", {"data-bind": "name", "style": {"fg": "White", "mod": ["BOLD"]}}, "Unknown"]
      ]
    ],
    ["Gauge", {
        "data-bind": "health",
        "ratio_bind": {"numerator": "health", "denominator": "maxHealth"},
        "gauge_style": {"fg": "Green"}
      }
    ],
    ["Paragraph", {
        "data-if": "health < 50",
        "alignment": "Center",
        "style": {"fg": "Red", "mod": ["BOLD", "SLOW_BLINK"]}
      },
      ["Line", {}, ["Span", {}, "LOW HEALTH WARNING"]]
    ]
  ]
]
```

Read that against the model:

- `Block`, `Gauge`, `Span` survive with their case intact, because the vocabulary declares them.
- `border_style` and `gauge_style` arrive as **objects**, `constraints` as an **array of strings**, and `ratio` as a **number**. None of them is a sink, so none of them is touched.
- `data-bind` on a `Span` replaces its text, because a `Span` defaults to `bindTo: "children"`. `data-bind` on a `Gauge` writes the `ratio` prop, because the vocabulary says `bindTo: "ratio"`. Two behaviors, one mechanism, declared rather than special-cased.
- Nothing in this vocabulary is dangerous, so nothing in it declares a sink. That is the correct outcome, and the old sanitizer could not have reached it — it would have dropped every node in the tree.

Note what the `formats` block does *not* contain: any mention of Ratatui's renderer, its crate, its layout solver, or its terminal. The **vocabulary** is a contract, and belongs in the manifest. The **renderer** is host code, and does not.

### `application/x-winforms+json` (illustrative)

No renderer ships for this. It is here to show the same protocol landing on a desktop toolkit: control names map to `System.Windows.Forms` classes, and the bindings, `data-if`, handlers, and lifecycle are identical to every format above.

```json
["Panel", {
    "Dock": "Top",
    "Padding": [8, 8, 8, 8],
    "BackColor": "#1A1A2E",
    "BorderStyle": "FixedSingle"
  },
  ["TableLayoutPanel", {
      "Dock": "Fill",
      "Columns": ["AutoSize", "Percent:100"],
      "Rows": ["AutoSize", "AutoSize", "AutoSize"]
    },
    ["Label", {"Text": "Player:", "ForeColor": "Gray", "Cell": [0, 0], "AutoSize": true}],
    ["Label", {
        "data-bind": "name",
        "Text": "Unknown",
        "ForeColor": "White",
        "Font": {"Size": 9, "Style": ["Bold"]},
        "Cell": [1, 0]
      }
    ],
    ["ProgressBar", {
        "data-bind": "health",
        "Maximum": 100,
        "ForeColor": "LimeGreen",
        "Cell": [1, 1],
        "Dock": "Fill"
      }
    ],
    ["Label", {
        "data-if": "health < 50",
        "Text": "Low health!",
        "ForeColor": "Red",
        "Font": {"Size": 10, "Style": ["Bold"]},
        "Cell": [0, 2],
        "ColumnSpan": 2
      }
    ]
  ]
]
```

Its `formats` declaration would be unremarkable: PascalCase node names, PascalCase props, `Cell` and `Padding` typed as number arrays, `Font` as an object, `Label.Text` a plain string with no sink. `data-bind` on a `Label` sets `Text` (`bindTo: "Text"`); on a `ProgressBar` it sets `Value` (`bindTo: "Value"`). `data-if` maps to `Visible`, which is the host's reading of the `visibility` map, not a fragment concern.

The interesting thing about this example is that under the old model it was pure fiction — every node in it would have been dropped. Under the new model it is a manifest away from real.

## Inheritance

`formats` and `vocabularies` participate in `extends` like every other manifest surface, and neither ever silently clobbers.

| Level | Collision without `refines` | With `refines: true` |
|-------|-----------------------------|----------------------|
| Format id | resolution error | scalars are child-wins; `nodes` key-merges; `vocabularies` and `schemes` replace (see below) |
| Vocabulary id | resolution error | `description` is child-wins; `nodes` key-merges |
| Node name | resolution error | `description` / `children` / `bindTo` are child-wins; `props` key-merges |
| Prop name | — | the child's prop **replaces** the base's wholesale |

A format's two arrays, `vocabularies` and `schemes`, are the places a list does not behave like a list:

> **Absent inherits. Present replaces wholesale. `[]` means deliberate closure.**
>
> A child format that does not carry the key inherits the base's array unchanged. A child that carries one replaces the base's array entirely — never a union, never a merge, never a prepend or append. An empty array is a present value, not an absent one: for `vocabularies` it closes the scope to the format's inline `nodes` alone, and for `schemes` it closes the format to absolute URLs.

`vocabularies` is ordered and the order is semantic, so there is no defensible union order: prepending and appending give different resolution, and either would be a guess made on the author's behalf. Worse, a silent union could re-inject `html` into a scope a child deliberately closed, which is exactly the silent-clobber class `refines` exists to prevent.

`schemes` is unordered, and the argument lands somewhere else on the same conclusion: a union makes narrowing structurally impossible. A child declaring `["https"]` against a base that permits four schemes means to tighten, and a union would hand it all four back while it believed otherwise. Both arrays therefore replace, and a child wanting the base's list plus one entry restates the list — the same way a child widening a prop restates its `sink`.

The asymmetry with `nodes`, which key-merges, is deliberate. `nodes` is a keyed map of independent declarations; each array is a single value that happens to be written with brackets.

The prop rule is the other one worth explaining. Deep-merging two JSON Schemas produces subtly wrong constraints: a leftover `enum` narrowing a widened `type`, a `minimum` surviving a change to `string`. Worse, if a child widens `Link.href` from a string to an object, a deep merge would **silently inherit `sink: "uri"` onto a now-object prop**. Replacing wholesale forces the child to restate the safety annotation, which is exactly when it should be thinking about it.

The corpus at [`extends-tests.json`](./extends-tests.json) carries the canonical merge cases; every runtime implements the same ones.

## What Stays the Same

| Concept | Universal |
|---------|-----------|
| Slot targeting | the `fills` key is the host slot id (e.g. `"sidebar.left"`) |
| Bindings | `{ "name": "health", "path": "player.health" }` |
| `data-bind` | a prop on the node that displays the value; the node's `bindTo` says where it lands |
| `data-if` | a prop controlling visibility; the host applies it, the tree is never pruned |
| `data-each` | a prop that repeats its node once per element; `data-key` identifies the copies across updates |
| Handlers | `{ "selector": "...", "on": "...", "handler": "..." }` in the fill's `handlers` array |
| Node references | `#id` in any vocabulary; a CSS selector in HTML vocabularies |
| Lifecycle | mount, unmount, update, suspend, resume |
| Sandbox API | `hooks.fragment.update(id, callback)` with a command buffer |
| Sanitization | vocabulary-checked nodes and props; sink-routed values |

The fill shape, the lifecycle, and the sandbox API are the interop surface. Whether a fragment renders as DOM elements, terminal widgets, or desktop controls is the host's concern — and now the host's *declaration*.

A fragment fill's event-handler array is `handlers` (entries shaped `{ selector, on, handler }`). The older key `events` is a deprecated alias kept for back-compat; `handlers` wins if both are present. Do not confuse it with the host's separate top-level `events` catalog, which declares the named events a host broadcasts. The shorthand: bindings are what you call, slots and handlers are what handles, `events` is what the host emits.

## Runtime Parity

The vocabulary model, the tree contract, and the sink model ship in all four runtimes.

| | `@xriptjs/runtime` | `@xriptjs/runtime-node` | `xript-runtime` (Rust) | `Xript.Runtime` (C#) |
|---|---|---|---|---|
| `text/html`, `text/html+jsml` | yes | yes | yes | yes |
| `application/j5ml+json`, `application/jsml+json` | yes | yes | yes | yes |
| Host-declared `vocabularies` and multi-vocabulary scopes | yes | yes | yes | yes |
| Sanitized tree on `getContent()` | yes | yes | yes | yes |
| Unknown format rejected at load | yes | yes | yes | yes |
| `setProp`, node references, op-value sanitization | yes | yes | yes | yes |

Every runtime reads JSML, resolves host-declared vocabularies, carries the sanitized tree alongside the HTML projection, refuses an unrecognized format at load rather than falling back to the HTML sanitizer, and routes every command-buffer value through the same sink model.

Parity here is held by contract rather than by inspection. `spec/fragment-vocabulary-tests.json` and `spec/fragment-op-tests.json` are shared conformance corpora generated from the reference implementation, and all four runtimes are asserted against them: same sources, same format declarations, same trees, same HTML, same diagnostics. A change that forks one runtime from the others fails the other three.

`xript-wiz` — a Rust host whose slots accept `application/x-ratatui+json` — declares that vocabulary in its own `formats` block. That is the migration path the model was designed around, and it is why the permissive unknown-format fallback could be removed rather than kept.
