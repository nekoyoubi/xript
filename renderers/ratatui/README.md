# xript-ratatui

Fragment renderer for [xript](https://github.com/nekoyoubi/xript): turns `application/x-ratatui+json` fragments into native Ratatui terminal widgets.

[![Crates.io](https://img.shields.io/crates/v/xript-ratatui)](https://crates.io/crates/xript-ratatui)

## Install

```toml
[dependencies]
xript-ratatui = "0.3"
```

## Usage

```rust
use std::collections::HashMap;
use xript_ratatui::render_json_fragment;
use serde_json::json;

let fragment = json!(["Block", {"title": "Status", "borders": "ALL"},
    ["Layout", {"direction": "Vertical", "constraints": ["Length:1", "Length:1"]},
        ["Paragraph", {},
            ["Line", {}, ["Span", {"data-bind": "name"}, "Unknown"]]
        ],
        ["Gauge", {
            "data-bind": "health",
            "ratio_bind": {"numerator": "health", "denominator": "maxHealth"},
            "gauge_style": {"fg": "Green"}
        }]
    ]
]);

let mut bindings = HashMap::new();
bindings.insert("name".into(), json!("Hero"));
bindings.insert("health".into(), json!(75));
bindings.insert("maxHealth".into(), json!(100));

// Inside your Ratatui draw closure:
terminal.draw(|frame| {
    render_json_fragment(frame, frame.area(), &fragment, &bindings);
})?;
```

## What it does

- Parses `application/x-ratatui+json` fragments (JsonML format) into a widget tree
- Renders the tree as native Ratatui widgets (Block, Paragraph, Gauge, Layout, List, Table, Sparkline)
- Resolves `data-bind` attributes against a bindings map at render time
- Supports `data-if` for conditional widget visibility
- Handles nested layouts with directional constraints (`Length`, `Percentage`, `Fill`, `Min`, `Max`, `Ratio`)
- No runtime JavaScript; this is pure Rust parsing and rendering

## API

### `render_json_fragment(frame, area, json, bindings)`

One-call render. Parses a JSON fragment and renders it into the given frame area. Bindings are resolved during parsing.

### `parse_fragment(json, bindings) -> Option<WidgetNode>`

Parses a `serde_json::Value` into a widget tree. Returns `None` for unrecognized or empty input.

### `render_fragment(frame, area, node, bindings)`

Renders a previously parsed `WidgetNode` tree into the frame.

### `parse_style(value) -> Style`

Parses a JSON style object (`{"fg": "Green", "bg": "Black", "bold": true}`) into a Ratatui `Style`.

### `parse_constraint(value) -> Option<Constraint>`

Parses a constraint string (`"Length:1"`, `"Percentage:50"`, `"Fill:1"`) into a Ratatui `Constraint`.

## Supported widgets

| Widget | Attributes | Children |
|---|---|---|
| `Block` | `title`, `borders`, `border_type`, `border_style` | Any widget |
| `Paragraph` | `alignment`, `style`, `data-if` | `Line` elements |
| `Gauge` | `data-bind`, `ratio_bind`, `gauge_style`, `label`, `data-if` | None |
| `Layout` | `direction`, `constraints`, `data-if` | Any widget |
| `List` | `style`, `data-if` | String items |
| `Table` | `header`, `widths`, `style`, `data-if` | Row arrays |
| `Sparkline` | `data`, `data-bind`, `style`, `data-if` | None |

## Documentation

[xript.dev](https://xript.dev): full docs, fragment specification, and format catalog.

## License

MIT
