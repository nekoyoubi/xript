# Changelog

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
