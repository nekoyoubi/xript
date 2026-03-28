---
title: TUI Wizard
description: Interactive terminal wizard for manifest analysis — audit capability coverage, diff against git tags, and more.
---

`xript-wiz` is an interactive terminal wizard for working with xript manifests. Built in Rust, it dogfoods the xript ecosystem — its UI is rendered via `xript-ratatui`, the same fragment renderer available to any Rust host application.

## Install

```bash
cargo install xript-wiz
```

Or build from source:

```bash
cd tools/wiz
cargo build --release
```

## Home

The home screen is a menu of six actions. Use arrow keys or `j`/`k` to navigate, `Enter` to select, `q` to quit.

```
╭────────────────────────────────────────────╮
│ ✓ Validate                                 │
│ Check a manifest against the xript spec    │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ⚡ Scaffold                                │
│ Create a new app or mod project            │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ≡ Sanitize                                 │
│ Clean dangerous content from HTML fragments│
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ⚙ Audit                                   │
│ Analyze manifest capability coverage       │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ Δ Diff                                     │
│ Compare manifest against last git tag      │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ✕ Quit                                     │
│ Exit the wizard                            │
╰────────────────────────────────────────────╯

          ↑↓ navigate · Enter select · q quit
```

The selected item is highlighted with colored borders. Validate, Scaffold, and Sanitize are interactive versions of the corresponding CLI subcommands. Audit and Diff are unique to the wizard.

## Audit

Analyzes a manifest's capability coverage and identifies security gaps. Enter a path to a manifest file (with tab completion), then the wizard produces a report.

```
Enter path to a manifest file:
> manifest.json

╭ Audit Report ────────────────────────────╮
│ ✓ Audit: my-app                          │
│                                          │
│ Capabilities: 4 defined                  │
│   Risk: 2 low, 1 medium, 1 high         │
│                                          │
│ Ungated (2):                             │
│   • auth.login                           │
│   • api.call                             │
│                                          │
│ Unused capabilities (1):                 │
│   • deprecated.feature                   │
│                                          │
│ Capability gaps (1):                     │
│   • new.feature                          │
╰──────────────────────────────────────────╯

    Tab complete · Enter audit · Esc back
```

The report covers:

- **Capabilities summary** — count and risk distribution (low, medium, high)
- **Ungated bindings** — bindings without capability gates (potential security surface)
- **Unused capabilities** — defined but never referenced (dead weight)
- **Capability gaps** — referenced in bindings but never defined (incomplete manifest)

The report border is green when clean, yellow when issues are found, red on errors.

## Diff

Compares the current manifest against the version at the last git tag, surfacing what changed in bindings, capabilities, and slots.

```
Enter path to a manifest file:
> manifest.json

╭ Manifest Diff ───────────────────────────╮
│ Diff: my-app (current vs v1.0.0)        │
│                                          │
│ Added bindings (2):                      │
│   + auth.mfa                             │
│   + player.inventory.sort                │
│                                          │
│ Removed bindings (1):                    │
│   - legacy.api                           │
│                                          │
│ Added capabilities (1):                  │
│   + mfa.verify                           │
│                                          │
│ Added slots (1):                         │
│   + settings-panel                       │
╰──────────────────────────────────────────╯

    Tab complete · Enter diff · Esc back
```

The wizard runs `git describe --tags` to find the last tag, retrieves the old manifest via `git show`, and diffs the two. Sections with no changes are omitted. If nothing changed, the report reads "No changes since last tag."

## Keybindings

| Key | Action |
|-----|--------|
| `↑` / `k` | Navigate up |
| `↓` / `j` | Navigate down |
| `Enter` | Select / submit |
| `Tab` | Apply completion suggestion |
| `Esc` | Back to home (or quit from home) |
| `q` | Quit (from home) |
| `Ctrl+C` | Force quit |
