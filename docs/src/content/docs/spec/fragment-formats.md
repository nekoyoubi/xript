---
title: Fragment Formats
description: "The same fragment protocol across HTML, JSML, terminal UI, and desktop apps."
---

The fragment protocol is format-agnostic by design. Hosts declare what formats their slots accept; mods provide fragments in those formats. The bindings, events, and lifecycle are universal. Only the rendering changes.

This page shows the same health panel fragment in four formats. Each one uses `data-bind` for value display and `data-if` for conditional visibility.

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

In the mod manifest:

```json
{
  "id": "health-panel",
  "slot": "sidebar.left",
  "format": "application/jsml+json",
  "source": "fragments/panel.jsml.json",
  "bindings": [
    { "name": "health", "path": "player.health" },
    { "name": "maxHealth", "path": "player.maxHealth" },
    { "name": "name", "path": "player.name" }
  ]
}
```

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

## `application/x-winforms+json`

For .NET desktop applications using WinForms. Control names map to `System.Windows.Forms` classes.

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
| Slot targeting | `"slot": "sidebar.left"` |
| Bindings | `{ "name": "health", "path": "player.health" }` |
| `data-bind` | Attribute on the element/widget that displays the value |
| `data-if` | Attribute controlling visibility based on an expression |
| Events | `{ "selector": "...", "on": "...", "handler": "..." }` |
| Lifecycle | mount, unmount, update, suspend, resume |
| Sandbox API | `hooks.fragment.update(id, callback)` with command buffer |
| Sanitization | Allowlisted elements/widgets, stripped dangerous content |

The manifest shape, the lifecycle, and the sandbox API are the interop surface. Whether the fragment renders as DOM elements, terminal widgets, or desktop controls is the host's concern.
