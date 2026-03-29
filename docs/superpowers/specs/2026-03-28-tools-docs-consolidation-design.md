# Tools Documentation Consolidation

## Problem

The v0.4 unified CLI collapsed five separate tools into one `xript` command, but the docs still have five separate pages — each repeating the same install instructions and framing themselves as standalone tools. The Tools sidebar is bloated and redundant. The TUI Wizard (`xript-wiz`) has no docs at all.

## Decision

Consolidate to three pages reflecting the three actual tools: CLI, TUI Wizard, Fragment Workbench.

## Sidebar

```
Tools
├── CLI                  (tools/cli)
├── TUI Wizard           (tools/wiz)
└── Fragment Workbench   (tools/fragment-workbench)  [unchanged]
```

## CLI Page (`tools/cli.md`)

Single page covering all six subcommands.

### Structure

1. **Intro** — one paragraph: what the CLI is, what it covers
2. **Install** — `npm install -g @xriptjs/cli` / `npx xript` (stated once)
3. **Quick reference table** — all six subcommands with one-liner descriptions
4. **Subcommand sections** — one `##` per subcommand:
   - Brief description
   - Usage / flags / options
   - Example output
   - Programmatic API subsection (library import, key functions, brief code example)

### Subcommand order

`validate`, `typegen`, `docgen`, `init`, `sanitize`, `scan` — workflow order (check manifest, generate types, generate docs, scaffold, sanitize fragments, scan annotations).

### Content sources

Each subcommand section pulls content from its existing standalone page. Programmatic API sections are kept but folded into subsections under each subcommand. No content is dropped — it's reorganized.

The `scan` subcommand has no existing docs page; its section is written fresh based on the implementation in `tools/cli/src/scan/` and `spec/annotations.md`.

## TUI Wizard Page (`tools/wiz.md`)

New page. The wiz has zero docs presence today.

### Structure

1. **Intro** — what it is: interactive terminal wizard for manifest analysis, built in Rust, renders fragments via `xript-ratatui`
2. **Install** — `cargo install xript-wiz` / build from source
3. **Screens** — one `##` per screen with ASCII mockup, description, and keybindings

### Screens

- **Home** — menu entry point (6 items)
- **Audit** — capability coverage analysis (ungated bindings, unused capabilities, gaps, risk distribution)
- **Diff** — manifest comparison against last git tag (added/removed bindings, capabilities, slots)

ASCII mockups for each screen (no screenshots).

## Fragment Workbench

No changes. Existing `tools/fragment-workbench.mdx` stays as-is, re-slotted in the new sidebar.

## Deletions

Five files removed:
- `docs/src/content/docs/tools/validator.md`
- `docs/src/content/docs/tools/typegen.md`
- `docs/src/content/docs/tools/docgen.md`
- `docs/src/content/docs/tools/init.md`
- `docs/src/content/docs/tools/sanitize.md`

## Other changes

- **`docs/astro.config.mjs`** — sidebar Tools section updated to three entries
- **`CLAUDE.md`** — page count updated from 31 to 28 (removed 5 pages, added 2)

## Page count math

- 31 existing pages
- -5 removed (validator, typegen, docgen, init, sanitize)
- +2 added (cli, wiz)
- = 28 pages
