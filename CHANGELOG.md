# Changelog

## v0.4.0 — Unified CLI & Annotation Scanning

- consolidated five separate CLI tools into `@xriptjs/cli`, published as the `xript` command
  - `xript validate`, `xript typegen`, `xript docgen`, `xript init`, `xript sanitize` all route to the existing library packages
  - individual tool packages (`@xriptjs/validate`, `@xriptjs/typegen`, etc.) dropped their `bin` entries but remain published as libraries
  - one command to remember instead of five separate `npx xript-*` invocations
- added `xript scan`, a new subcommand that reads `@xript` and `@xript-cap` JSDoc tags from TypeScript source and generates manifest bindings and capabilities
  - spec document at `spec/annotations.md` defining the tag convention
  - scanner parses TypeScript ASTs via `ts-morph` (optional dependency; the CLI prompts if it's missing)
  - merge mode reads an existing manifest, adds new bindings, warns about removals, and auto-generates capability entries
  - outputs to stdout, to a file, or directly into an existing manifest with `--write`
- improved `@xriptjs/docgen` with two new flags
  - `--link-format no-extension` strips `.md` from generated links for static site generators that don't want them
  - `--frontmatter` injects YAML frontmatter into all generated files
- built the **Fragment Workbench** (#85), an interactive tool page on the docs site for building and testing xript UI fragments
  - first interactive page in the Tools section of the sidebar
  - manifest-driven: load an app manifest and the workbench configures itself from its slots
  - slot contract panel shows available bindings, capabilities, and types per slot
  - JSML toggle with lossless HTML/JSML conversion
  - validation-as-you-type: unresolved `data-bind`/`data-if` refs flagged inline, sanitizer stripping highlighted
  - dynamic state simulation with controls generated from manifest type info
  - export as a downloadable mod manifest JSON
- added two new screens to `xript-wiz`
  - audit: capability coverage analysis showing ungated bindings, unused capabilities, capability gaps, and risk distribution
  - diff: compares the current manifest against the last git tag, surfacing added/removed bindings, capabilities, and slots
  - home menu expanded from 4 to 6 items
- updated the publish pipeline for 8 npm packages (added `@xriptjs/cli`); `scripts/bump-version.mjs` now handles 13 files

### Test counts

| package | v0.3.1 | v0.4.0 |
|---------|--------|--------|
| `@xriptjs/sanitize` | 71 | 71 |
| `@xriptjs/validate` | 25 | 25 |
| `@xriptjs/typegen` | 31 | 31 |
| `@xriptjs/docgen` | 22 | 28 |
| `@xriptjs/init` | 27 | 27 |
| `@xriptjs/cli` | — | 29 |
| `@xriptjs/runtime` | 97 | 97 |
| `@xriptjs/runtime-node` | 97 | 97 |
| `xript-runtime` (Rust) | 31 | 31 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 33 | 35 |
| `Xript.Runtime` (C#) | 116 | 116 |
| **total** | **608** | **645** |

## v0.3.1 — Publishing & Release Tooling

- fixed the docs deploy workflow; `@xriptjs/sanitize` wasn't being built before the runtime, so the docs site build was failing
- switched all publish workflows to fire on GitHub Release creation (`release: published`) with `workflow_dispatch` as a manual fallback
  - `publish.yml` (npm), `publish-nuget.yml`, and `publish-crates.yml` all use the same trigger pattern now
  - previously npm and NuGet were manual-only; crates.io had no workflow at all
- created `publish-crates.yml` for crates.io publishing
  - publishes `xript-runtime`, `xript-ratatui`, and `xript-wiz` in dependency order
- unified all 11 published packages (7 npm, 3 Rust crates, 1 NuGet) to version `0.3.1`
  - internal dependency references updated to match
- created `scripts/bump-version.mjs` (`npm run version:bump <version>`) to sync versions across all 12 package files
  - covers `package.json`, `Cargo.toml`, and `.csproj` files plus their internal dependency references
- created `scripts/release.mjs` (`npm run release`) to cut a GitHub Release from the current package version and matching `CHANGELOG.md` section
- added `readme`, `keywords`, and `categories` to `xript-ratatui` and `xript-wiz` Cargo.toml files; added `version` fields to path dependencies so `cargo publish` works
- wrote package READMEs for `@xriptjs/sanitize`, `xript-ratatui`, `xript-wiz`, and `Xript.Runtime` so they're not bare on their respective registries
- wired `PackageReadmeFile` in the C# `.csproj` so the README shows on nuget.org
- documented the full release process in `CLAUDE.md`

## v0.3.0 — Fragment Protocol

- introduced **mod manifests**: mods declare themselves, their capabilities, entry scripts, and UI fragment contributions in a single JSON file (`spec/mod-manifest.schema.json`)
- extended app manifests with **slots**: host-declared UI mounting points where mods contribute fragments
  - each slot declares accepted formats, capability gating, multiplicity, and styling mode (`inherit`, `isolated`, `scoped`)
- added the **fragment protocol** to the spec (`spec/fragments.md`): the full lifecycle for host-declared slots, mod-contributed UI, sanitization, data binding, conditional visibility, event routing, and the sandbox fragment API
  - `data-bind` for value binding — attributes persist in the DOM for O(1) updates at game-loop speed
  - `data-if` for conditional visibility — expressions evaluated by the same tier 1 engine
  - only two "smart" attributes; everything else goes through the sandbox fragment API
- built `@xriptjs/sanitize` — pure string-based HTML sanitizer with no DOM dependency (`tools/sanitize/`)
  - works inside QuickJS WASM, Node, Deno, browsers — anywhere
  - 45-case conformance test suite at `spec/sanitizer-tests.json` that all runtime implementations must pass
  - JSML support (`application/jsml+json`) — JSON Markup Language as a native fragment format, no escaping needed
- added `loadMod()` to all four runtimes
  - `@xriptjs/runtime` — JS/WASM via QuickJS, JSML support, sandbox fragment API with command buffer pattern
  - `@xriptjs/runtime-node` — Node.js vm-based, same API surface
  - `xript-runtime` (Rust) — `load_mod()` with ammonia-based sanitization, cross-validation, fragment hooks
  - `Xript.Runtime` (C#) — `LoadMod()` with regex-based sanitization, Jint fragment hooks
- added the **sandbox fragment API** to the JS and Node runtimes: `hooks.fragment.update(id, callback)` with a command buffer proxy (`toggle`, `addClass`, `setText`, `setAttr`, `replaceChildren`)
- `@xriptjs/validate` gained mod manifest validation, auto-detection (app vs mod), and `--cross` flag for cross-validation against app slots
- `@xriptjs/typegen` now generates `FragmentProxy` interface, `hooks.fragment` namespace, and `XriptSlots` types
- `@xriptjs/docgen` produces slot documentation tables and a Fragment API reference page
- `@xriptjs/init` gained a `--mod` flag for mod project scaffolding: generates `mod-manifest.json`, fragment HTML, and entry script
- built `xript-ratatui` — fragment renderer for Ratatui terminal applications (`renderers/ratatui/`)
  - parses `application/x-ratatui+json` fragment trees into native Ratatui widgets
  - layout engine, style mapper, color/modifier support, `data-bind`/`data-if` processing
  - reusable logo module with ANSI art rendered via `ansi-to-tui`
- built `xript-wiz` — interactive TUI wizard for the xript toolchain (`tools/wiz/`)
  - dogfoods the xript ecosystem: app manifest with slots, fragments rendered by `xript-ratatui`
  - card-style menu with icons, tab-completion file input, scaffold form with toggle cards
  - validate, scaffold, and sanitize workflows
- added `examples/ui-dashboard/` — full fragment protocol demo with two mods (health panel, inventory panel)
  - demonstrates `data-bind`, `data-if`, sandbox fragment API iteration, cross-validation, and mod loading
- added four new fragment format examples to the docs — HTML, JSML, Ratatui JSON, WinForms JSON
  - same health panel rendered in four formats showing the protocol is rendering-agnostic
- added 6 new docs pages — mod manifest spec, fragment protocol spec, fragment formats, sanitizer tool, UI dashboard example, Fragment Builder interactive demo
  - updated all tool docs pages (validator, typegen, docgen, init) with v0.3 features
  - sidebar expanded to 30 pages
- fixed a binding-name injection vulnerability in `evaluateCondition` — mod-authored binding names are now validated against a safe identifier pattern before interpolation
- created tracking issues for future fragment renderer packages (#76 hub, #77 xript-ratatui, #78 xript-winforms)

### Test counts

| package | v0.2 | v0.3 |
|---------|------|------|
| `@xriptjs/sanitize` | — | 71 |
| `@xriptjs/runtime` | 69 | 97 |
| `@xriptjs/runtime-node` | 71 | 97 |
| `xript-runtime` (Rust) | 17 | 31 |
| `xript-ratatui` | — | 58 |
| `xript-wiz` | — | 33 |
| `Xript.Runtime` (C#) | 72 | 116 |
| `@xriptjs/validate` | 11 | 25 |
| `@xriptjs/typegen` | 24 | 31 |
| `@xriptjs/docgen` | 17 | 22 |
| `@xriptjs/init` | 20 | 27 |
| **total** | **301** | **608** |
