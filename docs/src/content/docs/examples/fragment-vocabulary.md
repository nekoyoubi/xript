---
title: "Fragment Vocabulary"
description: "A host that declares its own typed fragment vocabulary. Mods author UI as a node tree instead of HTML, and validate, typegen, and docgen treat the vocabulary as a checked, typed, documented contract."
---

A host does not have to speak HTML. It can declare its own vocabulary of nodes, name their props and prop types, and say which nodes may nest inside which. A mod then authors UI as a typed node tree, and the toolchain holds it to the contract.

This is the same fragment surface as the [UI Dashboard](/examples/ui-dashboard/), pointed at a custom format instead of `text/html`.

## What It Shows

- **A declared vocabulary** of three nodes (`Panel`, `Link`, `Progress`) over a `j5ml` format the host names `application/x-panel+json`
- **Typed props** with sinks and defaults: `Panel { heading, collapsible }`, `Link { href (a uri sink) }`, `Progress { value, max, tone }`
- **Containment as a separate axis** that defaults open: `Panel` leaves `children` unset so it nests anything to any depth, `Link` takes `text`, and `Progress` is a childless leaf
- **A mod that authors an open-nested tree**, a `Panel` holding a `Link`, a `Progress`, and a nested `Panel`, resolved against the vocabulary with node names and prop types intact
- **The toolchain as a contract**: `validate` fails a misspelled node, `typegen` types the node tree a mod author writes, and `docgen` publishes the node table

## Running the Demo

```bash
node examples/fragment-vocabulary/src/demo.js
```

The demo loads the mod, resolves its fragment against the vocabulary, and prints the resulting node tree with props preserved (`value` stays a number, `collapsible` stays a boolean).

## App Manifest

The host declares the format and its nodes inline. A single format inlines its `nodes`; a vocabulary shared by more than one format is declared once under a top-level `vocabularies` block and named from each format's scope.

```json
{
  "slots": [
    {
      "id": "sidebar",
      "accepts": ["application/x-panel+json"],
      "capability": "ui-mount",
      "multiple": true,
      "style": "isolated"
    }
  ],
  "formats": {
    "application/x-panel+json": {
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
            "max": { "type": "number", "default": 100 },
            "tone": { "type": "string", "enum": ["ok", "warn", "error"] }
          }
        }
      }
    }
  }
}
```

A node that declares no `children` accepts any node in scope to any depth; `children: "text"` takes only text; `children: "none"` is a leaf; and a named allow-list (`children: ["Panel", "Link"]`) narrows to exactly those nodes. A prop's `sink` (`uri`, `image-uri`, `css`, `html`) tells the sanitizer how to treat its value.

## The Mod — Authoring a Node Tree

The mod fills the slot with a fragment whose source is a `j5ml` node tree rather than HTML. Each node is a `[name, props, ...children]` tuple:

```json
["Panel", { "heading": "Session", "collapsible": true },
  ["Link", { "href": "https://xript.dev" }, "docs"],
  ["Progress", { "value": 72, "tone": "ok" }],
  ["Panel", { "heading": "Nested" },
    ["Link", { "href": "https://xript.dev/changelog" }, "changelog"]
  ]
]
```

The nested `Panel` is what "containment defaults open" buys: no declaration is needed to let a panel hold another panel.

## The Toolchain as a Contract

Because the vocabulary is declared data, the tools can hold a mod author to it. Run each against the host manifest:

```bash
npx xript validate examples/fragment-vocabulary/manifest.json
npx xript typegen  examples/fragment-vocabulary/manifest.json
npx xript docgen   examples/fragment-vocabulary/manifest.json -o docs/
```

- `validate` rejects a misspelled node or an out-of-set enum before it ever mounts.
- `typegen` emits a tuple type per node and a union over the vocabulary, so a mod author writing `["Panel", { heading }, ...]` gets the props, the children, and the nesting checked by the compiler.
- `docgen` publishes a node table listing each node's props and what it may parent.

See the [source code](https://github.com/nekoyoubi/xript/tree/main/examples/fragment-vocabulary) for the complete example.
