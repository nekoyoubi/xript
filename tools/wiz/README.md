# xript-wiz

Interactive TUI wizard for the [xript](https://github.com/nekoyoubi/xript) toolchain. Validate manifests, scaffold projects, and sanitize fragments from one terminal interface.

[![Crates.io](https://img.shields.io/crates/v/xript-wiz)](https://crates.io/crates/xript-wiz)

## Install

```sh
cargo install xript-wiz
```

## Usage

```sh
xript-wiz
```

That's it. The wizard presents a menu with five tools:

- **Validate** a manifest file (with file path completion via Tab)
- **Scaffold** a new xript project (app or mod, TypeScript or JavaScript)
- **Sanitize** an HTML fragment (shows what was stripped and the clean output)
- **Audit** a manifest's capability coverage — ungated bindings and hooks, unused capabilities, and capabilities referenced but never defined
- **Diff** a manifest against its version at the last git tag, by bindings, capabilities, and slots

Validate, Scaffold, and Sanitize are interactive versions of the corresponding CLI subcommands. Audit and Diff are unique to the wizard; for the canonical analysis surfaces reach for `xript score`, `xript score-diff`, and `xript lint`.

All results render as xript fragments via `xript-ratatui`, so the wizard itself is a dogfooding exercise for the fragment protocol.

## Keyboard

| Key | Action |
|---|---|
| `↑`/`↓`, `k`/`j` | Navigate the menu, or move through completion suggestions |
| `←`/`→` | Cycle the choice on a Scaffold option field (app/mod, TypeScript/JavaScript) |
| Enter | Select, advance to the next field, or submit |
| Tab | Apply a completion suggestion, or advance to the next Scaffold field |
| Shift+Tab | Back to the previous Scaffold field |
| Esc | Back to the menu, or quit from the menu |
| `q` | Quit — from the menu only; elsewhere it types into the field |
| Ctrl+C | Quit from anywhere |

## Documentation

[xript.dev](https://xript.dev): full docs, getting started guide, and live demos.

## License

MIT
