# Declaring a fragment format

A **vocabulary** is a set of nodes and props, declared by the host. A **fragment format** names a syntax and the vocabularies in scope when a fill of that format is read. The host owns both exactly the way it owns its slots and its bindings: xript does not know what a `Panel` is, what props it takes, or which of those props are dangerous. The host does. So the host says so, once, in the manifest, and the runtime enforces it generically.

This is the host-side declaration behind [rendering fragments](/guidance/host-fragments/). If you only ever render HTML, you need none of it: the built-in HTML vocabulary is there and unchanged. Read this when your renderer speaks something other than HTML: components, terminal widgets, native controls, a design system.

## The vocabulary is part of the contract

A slot's `accepts` names a media type. Until you declare that media type, the name is the whole contract, and a mod author has to guess what may legally go inside a fill of that format. Declaring it closes the gap:

```json
{
	"formats": {
		"application/x-panel+json": {
			"description": "The component vocabulary the sidebar renderer speaks.",
			"syntax": "j5ml",
			"nodes": {
				"Panel": {
					"props": {
						"heading": { "type": "string" },
						"collapsible": { "type": "boolean", "default": false }
					}
				},
				"Link": {
					"children": "text",
					"props": { "href": { "type": "string", "sink": "uri" } }
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

Node names are **case-sensitive**. Props keep their declared type: a number arrives as a number, an object as an object, an array as an array. A prop's body is a JSON Schema, so the vocabulary is checkable, typeable, and documentable: `xript validate` catches a misspelled node at CI time, `xript typegen` types the node tree a mod author writes (a `[name, props, ...children]` tuple per node, with children nesting as openly as each node declares), and `xript docgen` publishes the node table.

`syntax` names the parser (`j5ml` for JSON node trees, `html` for markup strings). It is a closed enum: it names a parser the runtime must actually possess, so there is no "custom syntax" a manifest can conjure. Syntax is the only thing a format borrows from the runtime; the nodes themselves always come from the host.

The `nodes` block above is an **inline vocabulary**: it belongs to this format, has no id, and nothing else can point at it. That is the right shape when one format speaks one vocabulary. When more than one format speaks the same nodes, name the vocabulary instead.

## Naming a vocabulary, and putting it in scope

A top-level `vocabularies` block declares nodes once, under an id, for any number of formats to bring into scope. A vocabulary id is two or more lowercase dot-separated segments (`acme.components`); single-segment ids name the built-in vocabularies and cannot be declared.

A format then names its `syntax` and an ordered `vocabularies` array of what is in scope:

```json
{
	"vocabularies": {
		"acme.components": {
			"description": "The component set the design system renders.",
			"nodes": {
				"acme-icon": { "children": "none", "props": { "name": { "type": "string" } } },
				"acme-card": { "props": { "heading": { "type": "string" } } }
			}
		}
	},
	"formats": {
		"text/x-acme-html": {
			"description": "How the design system authors its own components.",
			"syntax": "html",
			"vocabularies": ["acme.components", "html"]
		},
		"application/x-acme+json": {
			"description": "What an application embedding the design system exposes to mods.",
			"syntax": "j5ml",
			"vocabularies": ["acme.components"]
		}
	}
}
```

Those two formats share one node declaration and agree on nothing else. The library authors its own components in HTML with the full HTML element set alongside them. An application embedding that library exposes the **same** components to mod authors as a JSON node tree with no HTML in scope at all, so a mod cannot reach an HTML element and the application cannot be HTML-extended. Same nodes, different syntax, different scope, declared once.

Four rules govern scope:

- **The array is ordered, and the first vocabulary that claims a node name wins.** A format's inline `nodes` block, when it has one, always resolves first, ahead of every named entry.
- **`html` is a vocabulary like any other, referenced by name**: there is no separate switch for it. It must be the last entry, so an HTML element name is only ever reached after every declared vocabulary has declined it, and a node you declared always beats a same-named element.
- **An empty array is deliberate closure**, legal alongside an inline `nodes` block: the inline nodes are the whole scope and nothing else resolves.
- **A node that resolves through nothing in scope is an error, not a silent drop.** Default-deny applies to the scope as a whole.

Name a vocabulary when more than one format will speak it. Inline the nodes otherwise.

### Containment is a separate axis, and it defaults open

A vocabulary declares what a node **is** (its props, its sinks, whether it takes children) and never what it may parent. Anything in scope may nest inside anything in scope unless a node narrows it explicitly with `children`. Vocabulary membership is not a boundary: a node from one vocabulary parenting a node from another is ordinary, and a design system component wrapping an HTML element (or the reverse) needs no declaration to permit it.

This is the openness default doing its job. A containment matrix would be a large, hand-maintained restriction that buys nothing a renderer cannot decide for itself, and hosts would spend their time restating that a card may contain a link.

## Safety is about where a value lands, not what a node is called

This is the reason the vocabulary lives in the manifest at all.

`href` is not dangerous because of the string `"href"`. It is dangerous because something eventually hands its value to a thing that navigates. `maxHealth` is not dangerous, because nothing hands its value to anything at all; a component reads it and draws a bar. A generic sanitizer cannot tell those two apart, so historically xript's did the only thing it could: it assumed every node was an HTML element and every value was a string about to be pasted into an HTML attribute, and it dropped everything else. That is what made a `Panel` disappear.

The fix is not a bigger allow-list. It is to let the party who *knows* say so. Each prop declares a **sink**, where its value lands, and the runtime routes exactly those values through exactly the sanitizer they need:

| `sink` | The value is… | What the runtime runs |
|--------|---------------|-----------------------|
| `text` (default) | inert data | nothing |
| `uri` | a navigational URL | the URI sanitizer in `href` mode (`javascript:`, `vbscript:`, and all `data:` rejected) |
| `image-uri` | a media source | the URI sanitizer in `src` mode (safe `data:image/*` permitted) |
| `css` | an inline style value | the style sanitizer (`url()`, `expression()`, `-moz-binding`, `behavior:` stripped) |
| `html` | a raw markup string the component injects | the HTML sanitizer, in full |

**A prop with no sink is inert data.** A number, a boolean, an enum, an object of style keys: none of it becomes markup, so there is nothing to sanitize, and stringifying it "to be safe" only destroys it.

Nothing was thrown away here. The same sanitizers do the same work; they stopped running blindly over the whole document and started running where the vocabulary says a value is dangerous. That is strictly *more* precise than a global attribute allow-list, which is why the model can be more open and safer at the same time.

Two rules bind it:

- A sink other than `text` requires `"type": "string"`. Validation errors otherwise.
- A `data-bind` value written into a prop routes through that prop's sink. Otherwise binding would be an injection bypass on any `sink: "html"` prop.
- A prop whose name begins with `on` is illegal in every vocabulary. That is a floor, not an allow-list decision.

Declaring a sink you do not need is the mistake to avoid in the other direction. If your renderer never navigates with `Card.label`, `label` has no sink, and running it through a URI sanitizer would be a guard with nothing to point at.

## Choosing which schemes your URIs may name

A `uri` or `image-uri` sink checks its value against an allow-list of schemes. Declare none and you get the default safe set (`http`, `https`, `mailto`, `data`), which is the right answer for most web hosts and the reason the key is optional.

Declare `schemes` when your answer differs, and know that **a declaration replaces the default rather than adding to it**:

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

That host added `tauri:` and dropped plain `http:` in one line. If you meant to add without dropping, restate the default alongside your addition: `["http", "https", "mailto", "data", "tauri"]`. There is no extend syntax, deliberately: a key that unioned with the default would make narrowing unexpressible, and `["https"]` would quietly keep admitting `http` while you believed you had locked it down.

How to pick:

- **A desktop or embedded host with a custom protocol.** Add your scheme. A Tauri host resolving `tauri://localhost/...` or an app with an `acme:` deep-link handler has a real scheme the default set cannot know about, and this is the key that teaches it.
- **A host that only ever loads over TLS.** Narrow to `["https"]`. Dropping `data` at the same time is usually intended: if no component takes an inline image, nothing is lost.
- **A host whose fragments never link out at all.** `[]` is legal and means what it says: no absolute URL survives. Relative links still work (see below), so this is a smaller hammer than it sounds. `xript lint` flags it as `closed-schemes` at info severity, purely so an empty array reads as a decision rather than a slip.
- **Anything else.** Leave the key off.

Three things worth knowing before you tune it:

**`javascript` and `vbscript` are a floor, not a default.** You cannot declare them. The schema rejects the manifest, `xript lint` reports `prohibited-scheme`, and the sink refuses the value regardless of what set it was handed. Naming one is an error rather than a no-op on purpose: the declaration would be harmless, but a manifest that reads as though it permits `javascript:` misinforms every human and every generated doc downstream.

**`data` grants no more than it ever did.** Listing it does not open a door; it keeps the one that was already there. A `data:` URI passes on an **image sink only** (`image-uri`), and only for `image/png`, `image/jpeg`, `image/gif`, and `image/svg+xml`. `data:text/html` is refused on every sink, and any `data:` on a plain `uri` sink is refused. The scheme list decides whether a scheme is reachable; what a reachable scheme then permits is still the sink's call.

**Relative values are never checked against the list.** `about.html`, `/assets/icon.png`, `//cdn.example.com/x.js`, `#anchor`, and `?q=1` all carry no scheme, so they pass whatever `schemes` says, including `[]`. Do not reach for the scheme list expecting it to stop a mod from linking within your app; it governs absolute URLs and nothing else.

Under `extends`, `schemes` behaves exactly like `vocabularies`: **absent inherits, present replaces wholesale, `[]` is deliberate closure.** A refining child that wants the base's set plus one scheme restates the set.

## Default-deny, and what "deny" means

The vocabulary is closed. What xript does about a violation depends on **who owns the language**:

| | Your declared vocabulary | Built-in HTML |
|---|---|---|
| Undeclared node | **error**: the fill does not mount | dropped, `warning` diagnostic |
| Undeclared prop | dropped, `warning` | dropped, `warning` |
| Value fails the prop's `type` | dropped, `warning` | dropped, `warning` |

The asymmetry is deliberate. HTML is an open language defined elsewhere and still growing; a host that ships a `<dialog>` has always had it dropped, and hardening that to a hard failure would break working hosts while buying no safety; the node was already inert. So the built-in vocabulary keeps its permissive drop and finally gets the diagnostic it was always missing. (`strictHtmlVocabulary` in the runtime options promotes it to an error for hosts that want the tighter contract.)

A vocabulary **you** declared is a closed contract with no upstream. An unknown node in it means the mod is speaking a language you do not have, and rendering nothing while reporting nothing is a lie: the mod believes it contributed a `Panel`, and the user sees a hole. Fail, and say why.

Everything dropped, cleaned, or refused produces a diagnostic carrying a code, a severity, a path into the tree, and the node and prop names. Read them on `FragmentInstance.diagnostics`, on every `getContent()` result, or through the `onFragmentDiagnostic` runtime option. Do not swallow them: a dropped prop that nobody reports is the bug this whole model exists to retire.

## Why props are closed when slot payloads are open

xript's default [leans open](/guidance/openness/), and a slot's `payload` is open: an extra key passes validation, and the host ignores what it does not know. A node's `props` is closed. That looks like a contradiction, and the rule that resolves it is the same one the safety model turns on.

A slot payload is data **the host reads**. An extra key is inert; nothing acts on it.

A node prop is a value **that lands in a rendered tree the host hands to a renderer**. An unknown prop reaches the renderer, and a renderer may do anything with it, up to and including spreading it onto a DOM element. An unknown prop is an unreviewed value in a rendering position.

The question, in both cases, is *where does this value land?*, and openness doctrine already supplies the test: a restriction has to name the cost it prevents. This one can.

## The built-in vocabulary, and the honest parity note

`html` is the one built-in vocabulary: the HTML element and attribute allow-list, which lives in code rather than in a manifest. It is referenced by name from a format's `vocabularies` array exactly like a declared one, and because built-in ids are single-segment while declared ids are dotted, a host can never shadow it.

Two formats are built in and carry `html` as their whole scope: `text/html` and `application/j5ml+json`. Each has a deprecated alias that behaves identically: `text/html+jsml` for `text/html`, and `application/jsml+json` for `application/j5ml+json`. Two further media types are reserved and never sanitized because they carry no markup at all: `application/x-xript-role` and `application/x-xript-hook`.

You **cannot redeclare a built-in id** in `formats`. A host that wants a component vocabulary registers a new media type of its own. A manifest with no `formats` block gets the built-in profiles unchanged, so every fill resolves against the HTML rules and nothing else.

A fill whose `format` resolves to no vocabulary (not built in, not declared) is a **hard error at load** on every runtime. It used to fall through to the HTML sanitizer, which ran JSON documents through an HTML tokenizer and handed the host the wreckage.

The model has landed everywhere:

| | `@xriptjs/runtime` | `@xriptjs/runtime-node` | `xript-runtime` (Rust) | `Xript.Runtime` (C#) |
|---|---|---|---|---|
| `text/html`, `text/html+jsml` | yes | yes | yes | yes |
| `application/j5ml+json`, `application/jsml+json` | yes | yes | yes | yes |
| Host-declared `formats` vocabularies | yes | yes | yes | yes |
| Sanitized tree on `getContent()` | yes | yes | yes | yes |
| Unknown format rejected at load | yes | yes | yes | yes |
| `setProp`, node references, op-value sanitization | yes | yes | yes | yes |

Whichever runtime your host targets, the vocabulary you declare is read the same way, the tree you get back has the same shape, and the diagnostics you get are the same diagnostics. Shared conformance corpora (`spec/fragment-vocabulary-tests.json`, `spec/fragment-op-tests.json`) pin all four to the same expected output.

## Common mistakes

- **Putting the renderer in the manifest.** The **vocabulary** is a contract and belongs there: node names, prop schemas, sinks, `bindTo`. The **renderer** (the widget library, the layout solver, the mounting code) is host code and never appears. A `formats` block that names a crate or a component import has crossed the line.
- **Declaring a sink on inert data.** A sink is an assertion that a value lands somewhere dangerous. If nothing navigates, injects, or styles with it, it has no sink.
- **Reaching for `format` instead of `sink`.** JSON Schema's `format: "uri"` rejects `/img/icon.png`, a perfectly safe relative URL. `format` describes what a string looks like; `sink` describes where it goes. Only one of them is load-bearing.
- **Declaring `schemes` as a delta.** It replaces the default set, so `["tauri"]` adds your scheme *and* drops `http`, `https`, `mailto`, and `data`. Restate the ones you still want.
- **Redeclaring `text/html` to "extend" it.** Register a new media type, and list `"html"` last in its `vocabularies` if you want HTML elements in scope alongside your nodes.
- **Copying a vocabulary to give it a second syntax.** Two formats naming the same vocabulary id is the supported shape, and the only one where a later node addition reaches both.
- **Swallowing diagnostics.** A silent drop is the original bug. Surface them in dev, and fail the build on them in CI with `xript validate`.
