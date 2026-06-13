# Fragment Formats

The fragment protocol is format-agnostic by design. A host declares a fragment-format slot whose `accepts` names the formats it takes; a mod fills that slot with an inert fragment in one of those formats. The bindings, DOM handlers, and lifecycle are universal. Only the rendering changes.

This page shows the same health panel fragment across several formats. Each one uses `data-bind` for value display and `data-if` for conditional visibility. The `text/html`, `application/jsml+json`, and `application/x-ratatui+json` formats have shipping processors (the JS/Node runtimes for the first two; the `xript-ratatui` crate for the third). The `application/x-winforms+json` example below is illustrative; it shows how the same protocol would map onto a desktop UI toolkit, but no renderer ships for it yet.

## `text/html`

The default for web hosts. Raw HTML with `data-bind` and `data-if` attributes.

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

## `application/jsml+json`

JSML (JSON Markup Language) represents the same structure as nested JSON arrays. No escaping, no HTML parser needed, fully JSON-native.

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

**Format:** `["tag", {attributes}, ...children]`. First element is the tag name. Optional second element is an attribute object. Everything after is children (strings for text, arrays for elements).

JSML sanitization follows the same rules as HTML: dangerous elements stripped, `on*` attributes removed, `javascript:` URIs blocked. The `@xriptjs/sanitize` package handles both formats.

In the mod manifest, a fragment is a fill of a fragment-format slot. The `fills` object is keyed by the host slot id:

```json
{
  "fills": {
    "sidebar.left": [
      {
        "format": "application/jsml+json",
        "source": "fragments/panel.jsml.json",
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

The former top-level `fragments[]` array (a flat list of `{ slot, format, source, bindings }` entries) is a deprecated alias; each legacy fragment's `slot` becomes the `fills` key. Validators still accept it with a deprecation warning. See [the fragment protocol](/spec/fragments/) for the full fill shape.

## `application/x-ratatui+json`

For Rust terminal applications using [Ratatui](https://ratatui.rs). Widget names map 1:1 to Ratatui structs. Layouts use constraint-based splitting.

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

**Key differences from HTML:**
- Widget names are PascalCase (`Paragraph`, `Gauge`, `Block`)
- Layouts are explicit nodes with constraint arrays
- Styling uses terminal color names and modifier flags
- `data-bind` on a `Gauge` updates the ratio; on a `Span` updates text
- Event targeting uses widget IDs (`#heal-button`) instead of CSS selectors

## `application/x-winforms+json` (illustrative)

This format is illustrative; no renderer ships for it. It shows how the same protocol would map onto a .NET desktop toolkit: control names map to `System.Windows.Forms` classes, but the bindings, `data-if`, handlers, and lifecycle would be identical to the formats above.

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
    ["Label", {
        "Text": "Player:",
        "ForeColor": "Gray",
        "Cell": [0, 0],
        "AutoSize": true
      }
    ],
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

**Key differences from HTML:**
- Control names are PascalCase matching WinForms classes (`Label`, `Panel`, `ProgressBar`)
- Layout uses `Dock`/`Anchor` or `TableLayoutPanel` with column/row definitions
- `Cell` is shorthand for grid positioning: `[column, row]`
- `data-bind` on a `Label` sets `Text`; on a `ProgressBar` sets `Value`
- `data-if` controls the `Visible` property
- Event names are PascalCase: `Click`, `TextChanged` (matching .NET conventions)

## What Stays the Same

Across all four formats, the fragment protocol is identical:

| Concept | Universal |
|---------|-----------|
| Slot targeting | `fills` key is the host slot id (e.g. `"sidebar.left"`) |
| Bindings | `{ "name": "health", "path": "player.health" }` |
| `data-bind` | Attribute on the element/widget that displays the value |
| `data-if` | Attribute controlling visibility based on an expression |
| Handlers | `{ "selector": "...", "on": "...", "handler": "..." }` in the fill's `handlers` array |
| Lifecycle | mount, unmount, update, suspend, resume |
| Sandbox API | `hooks.fragment.update(id, callback)` with command buffer |
| Sanitization | Allowlisted elements/widgets, stripped dangerous content |

The fill shape, the lifecycle, and the sandbox API are the interop surface. Whether the fragment renders as DOM elements, terminal widgets, or desktop controls is the host's concern.

A fragment fill's DOM event handler array is `handlers` (entries shaped `{ selector, on, handler }`). The older key `events` is a deprecated alias kept for back-compat; `handlers` wins if both are present. Do not confuse it with the host's separate top-level `events` catalog, which declares the named events a host broadcasts. The shorthand: bindings are what you call, slots and handlers are what handles, `events` is what the host emits.
