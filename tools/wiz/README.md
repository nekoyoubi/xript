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

That's it. The wizard presents a menu with three tools:

- **Validate** a manifest file (with file path completion via Tab)
- **Scaffold** a new xript project (app or mod, TypeScript or JavaScript)
- **Sanitize** an HTML fragment (shows what was stripped and the clean output)

All results render as xript fragments via `xript-ratatui`, so the wizard itself is a dogfooding exercise for the fragment protocol.

## Keyboard

| Key | Action |
|---|---|
| Arrow keys / `j`/`k` | Navigate menu |
| Enter | Select / submit |
| Tab | File path completion |
| Esc | Back to menu |
| `q` | Quit |

## Documentation

[xript.dev](https://xript.dev): full docs, getting started guide, and live demos.

## License

MIT
