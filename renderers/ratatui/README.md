# xript-ratatui

Fragment renderer for [xript](https://github.com/nekoyoubi/xript): turns `application/x-ratatui+json` fragments into native Ratatui terminal widgets.

[![Crates.io](https://img.shields.io/crates/v/xript-ratatui)](https://crates.io/crates/xript-ratatui)

## Install

```toml
[dependencies]
xript-ratatui = "0.9"
```

## Usage

The renderer draws an `xript-tree/1` fragment, the value a host gets from a fragment instance's `get_content(data).to_rendered()` in `xript-runtime`. By the time it arrives, the tree is sanitized against the host's vocabulary, `data-bind` is resolved, `{{ }}` interpolation is substituted, every `data-each` is expanded into its copies, and every `data-if` is evaluated into `conditions`.

```rust
use xript_ratatui::render_fragment;

let fragment = instance.get_content(&data).to_rendered();

terminal.draw(|frame| {
    render_fragment(frame, frame.area(), &fragment);
})?;
```

A source like this draws one `Line` per party member, with no script involved:

```json
["Paragraph", {},
    ["Line", {"data-each": "member in party", "data-if": "member.alive"},
        ["Span", {"data-bind": "member.name"}, "?"]
    ]
]
```

## What it does

- Draws the tree as native Ratatui widgets (Block, Paragraph, Line, Span, Gauge, Layout, List, Table, Sparkline)
- Hides a node when a false `data-if` sits on it or on an ancestor, by a path-prefix lookup against `conditions`
- Draws repeats as the copies the runtime already expanded; it never sees a template or a list
- Handles nested layouts with directional constraints (`Length`, `Percentage`, `Fill`, `Min`, `Max`, `Ratio`)
- Refuses a fragment whose `contract` it does not recognize
- Evaluates nothing: there is no bindings map and no expression parser anywhere in its API

## API

### `render_fragment(frame, area, fragment)`

Draws a `RenderedFragment` into the frame area.

### `build_widgets(fragment) -> Vec<WidgetNode>`

Turns a `RenderedFragment` into widget nodes, skipping hidden subtrees.

### `render_widget_node(frame, area, node)`

Draws one widget node.

### `apply_ops(tree, ops)`

Re-exported from `xript-tree`: applies a command-buffer batch to a tree before redrawing.

### `parse_style(value) -> Style`

Parses a JSON style object (`{"fg": "Green", "bg": "Black", "bold": true}`) into a Ratatui `Style`.

### `parse_constraint(value) -> Option<Constraint>`

Parses a constraint string (`"Length:1"`, `"Percentage:50"`, `"Fill:1"`) into a Ratatui `Constraint`.

## Supported widgets

| Widget | Props | Children |
|---|---|---|
| `Block` | `title`, `borders`, `border_type`, `border_style` | Any widget |
| `Paragraph` | `alignment`, `style` | `Line` elements |
| `Line` | `style` | `Span` elements |
| `Span` | `style` | Text |
| `Gauge` | `ratio`, `gauge_style`, `label` | None |
| `Layout` | `direction`, `constraints` | Any widget |
| `List` | `style` | String items |
| `Table` | `header`, `widths`, `style` | Row arrays |
| `Sparkline` | `data`, `style` | None |

Every node also takes the protocol props `id`, `data-bind`, `data-if`, `data-each`, and `data-key`. Which prop a `data-bind` writes is the host vocabulary's `bindTo`, not the renderer's choice.

## Documentation

[xript.dev](https://xript.dev): full docs, fragment specification, and the renderer contract.

## License

MIT
