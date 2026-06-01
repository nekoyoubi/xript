# Changelog

## v0.5.0 — Hardening, Roles & a Debugger

The biggest release since the fragment protocol: a security fix that touches every host, a full pass of runtime lifecycle controls, a clutch of new extensibility surfaces, a DAP-shaped debugger across all four runtimes, and first-class TypeScript authoring with real ES module evaluation. Every runtime kept in lockstep against a shared contract.

### Security

- closed a `data:` URI XSS hole in the Rust sanitizer that any host embedding the runtime inherited
  - `xript_runtime::sanitize_html` registered `data:` as a blanket allowed scheme, so `data:text/html,<script>…</script>` survived on `<img src>` and `<a href>`
  - added a subtype gate that keeps only `data:image/{png,jpeg,gif,svg+xml}` and strips everything else, matching the TS and C# runtimes that already conformed
  - brought the Rust serializer the rest of the way onto the canonical 56-case corpus: XHTML self-closing void elements and bare boolean attributes, byte-for-byte

### Runtime lifecycle

- added host-driven cooperative cancellation: a `CancellationToken` on `RuntimeOptions` that interrupts in-flight execution at the next check point and surfaces a distinct cancellation error (not a timeout)
  - QuickJS, rquickjs, and Jint interrupt mid-run; Node's `vm` has no mid-run hook, so it checks the token at execute/invoke entry
- added an opt-in per-capability audit channel: a fire-and-forget hook that reports every allowed binding invocation as `{ binding, capability, at }`
- gave `ConsoleHandler` a severity enum (log/info/warn/error/debug) and a trace channel
- finished the sandbox hard caps (memory, CPU time, and stack depth) and brought every runtime to parity

### Extensibility

- added the host-invoke export seam: mods declare named exports the host can call and whose return value it honors (the non-streaming core; streaming is reserved)
- gave slots runtime teeth (ordering by priority, single/multiple cardinality, and capability enforcement on contributions); they were advisory-only before
- added provider-role resolution as a first-class mechanism, retiring the pattern of core UI hardcoding addon-specific globals
  - mods declare `contributions.provides: [{ role, fns }]` where `fns` maps logical names to concrete exports
  - the host calls `resolve_role(role) → { addon, fns }` (first-installed-wins, settings-overridable) or `resolve_role_all` to build its own picker
  - declaring a role grants nothing; the named fns stay gated by their own capabilities
- let addons describe owned record types through the existing `types` surface rather than a new persistence concept
  - `fieldDefinition` gained `default` and inline `enum`; `typegen` emits typed accessors; the runtimes stay persistence-agnostic
- added manifest `extends` with deep-merge so a manifest can inherit and override host bindings
- added an optional top-level `family` field to the mod-manifest schema for addon grouping
- added capability-grant data shapes (schemas only): a prompt payload (capability + description + risk + scope), an install descriptor, and a discovery result; grant policy and prompt UX stay host-side

### Debugging

- added a DAP-shaped debug protocol the host can drive: set/clear breakpoints by source position, pause/resume/step in/over/out, and inspect scopes, locals, and stack frames
  - implemented across rquickjs (Rust), QuickJS-WASM (the async sandbox), Node's `vm` (AST instrumentation), and Jint (C#) using Debug Adapter Protocol vocabulary
  - engine fidelity differs and is documented per runtime; rquickjs 0.10 exposes no per-line hook, QuickJS-WASM debugging requires the async sandbox, Jint pauses synchronously on the engine thread

### TypeScript & ES modules

- made `entry.format: "module"` real — the runtimes now evaluate a mod entry as an ES module instead of treating the value as a reserved no-op
  - implemented across rquickjs (Rust), QuickJS-WASM (async sandbox), Node's `vm` (`SourceTextModule`), and Jint (C#)
  - top-level named function exports become host-invokable exports automatically — `export function transcribe()` needs no `xript.exports.register` call; the two paths coexist and an explicit `register` wins on a name collision
  - external imports stay denied (`import x from "fs"` fails at load) — the sandbox's no-external-modules guarantee is unchanged
- added a CommonJS guardrail: `require(`, `module.exports`, and top-level `exports.` in a mod entry now fail loudly with a fix-it message instead of breaking silently, so a mis-set `tsconfig` can't quietly produce unrunnable output
- added first-class typed authoring for TypeScript mods
  - `@xriptjs/typegen --ambient` emits a `.d.ts` declaring the `xript` global — host bindings, `exports.register`, and the mod's own declared exports and types — so authors get real intellisense and typecheck
  - `xript init --mod --typescript` now scaffolds an ESM `tsconfig`, an `export`-based example, and the ambient types wired in
  - a new "Authoring Mods in TypeScript" guide documents the canon: compile to ESM, use top-level exports, no external imports, no CommonJS

### Tooling & ergonomics

- added a reference Svelte fragment renderer under `examples/svelte-fragment-renderer/` — copy-adaptable host glue that renders inert fragment output (`html` + visibility + command-buffer dispatch) as Svelte, staying inside the inert-fragment wall (not a published package, not core-runtime code)
- fixed `@xriptjs/validate` and the CLI failing to locate `manifest.schema.json` from the published package, with a packaging regression test
- updated `@xriptjs/typegen` and `@xriptjs/docgen` for the new manifest surfaces (provider roles, record accessors, grant payloads)
- added a `namespace_builder` combinator for async namespaces and `add_mixed_namespace` (property values alongside callable functions) to the Rust runtime
- made the Rust runtime recurse into nested namespace members instead of silently dropping them
- fixed the Rust runtime swallowing uncaught throws in async workflows; a rejected top-level promise read as a successful `undefined`, but now surfaces the real rejection

### Test counts

| package | v0.4.2 | v0.5.0 |
|---------|--------|--------|
| `@xriptjs/sanitize` | 93 | 93 |
| `@xriptjs/validate` | 25 | 68 |
| `@xriptjs/typegen` | 31 | 52 |
| `@xriptjs/docgen` | 28 | 35 |
| `@xriptjs/init` | 34 | 41 |
| `@xriptjs/cli` | 29 | 38 |
| `@xriptjs/runtime` | 97 | 166 |
| `@xriptjs/runtime-node` | 97 | 165 |
| `xript-runtime` (Rust) | 48 | 125 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 35 | 35 |
| `Xript.Runtime` (C#) | 116 | 201 |
| **total** | **691** | **1077** |

## v0.4.2 — Sanitizer + Rust Runtime Fixes

- expanded the sanitizer's allowed element list across all four implementations (TypeScript, Rust/ammonia, C#)
  - added `button`, `progress`, `meter`, `output`, `fieldset`, and `legend`; `button` was the big miss since it's the primary element for `data-action` event handlers in fragments
  - added 14 SVG elements: `svg`, `g`, `defs`, `symbol`, `use`, `circle`, `ellipse`, `path`, `rect`, `line`, `polygon`, `polyline`, `text`, `tspan` for icons and data visualization in mod UIs
  - added `foreignObject`, `animate`, and `set` to the stripped elements list (dangerous SVG elements that shouldn't survive sanitization)
- added missing attributes: `open` for `<details>`, `low`/`high`/`optimum` for `<meter>`, plus 18 SVG attributes covering geometry and presentation
- fixed SVG attribute casing; `viewBox` and `preserveAspectRatio` were being lowercased by the tokenizer, which silently breaks SVG rendering in browsers
- updated the fragment spec documentation in `fragments.md` with the new element and attribute lists
- added 11 new conformance test cases to `spec/sanitizer-tests.json` and 11 new unit tests across the implementations
- fixed a serialization bug in `xript-runtime` (Rust) where `js_value_to_json` silently returned `Null` for objects and arrays from `execute()` (#89)
  - the fallback code evaluated `((v) => JSON.stringify(v))` which returned the function's _string representation_ instead of actually calling it with the value
  - replaced the broken eval with a proper `Function::call` through rquickjs's API
  - added 3 new tests for object, array, and nested object serialization

### Test counts

| package | v0.4.1 | v0.4.2 |
|---------|--------|--------|
| `@xriptjs/sanitize` | 71 | 93 |
| `@xriptjs/validate` | 25 | 25 |
| `@xriptjs/typegen` | 31 | 31 |
| `@xriptjs/docgen` | 28 | 28 |
| `@xriptjs/init` | 34 | 34 |
| `@xriptjs/cli` | 29 | 29 |
| `@xriptjs/runtime` | 97 | 97 |
| `@xriptjs/runtime-node` | 97 | 97 |
| `xript-runtime` (Rust) | 45 | 48 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 35 | 35 |
| `Xript.Runtime` (C#) | 116 | 116 |
| **total** | **666** | **691** |

## v0.4.1 — npm housekeeping

- added a README for `@xriptjs/cli` so the npm package page isn't a blank stare
- bootstrapped `@xriptjs/cli` on the npm registry; it was built and published in CI but had never been seeded locally, so npm didn't know it existed
- all eight `@xriptjs/*` packages now have READMEs on npmjs.com

## v0.4.0 — Unified CLI, Tier 4 & Rust Runtime

- consolidated five separate CLI tools into `@xriptjs/cli`, published as the `xript` command
  - `xript validate`, `xript typegen`, `xript docgen`, `xript init`, `xript sanitize` all route to the existing library packages
  - individual tool packages (`@xriptjs/validate`, `@xriptjs/typegen`, etc.) dropped their `bin` entries but remain published as libraries
  - one command to remember instead of five separate `npx xript-*` invocations
- added `xript scan`, a new subcommand that reads `@xript` and `@xript-cap` JSDoc tags from TypeScript source and generates manifest bindings and capabilities
  - spec document at `spec/annotations.md` defining the tag convention
  - scanner parses TypeScript ASTs via `ts-morph` (optional dependency; the CLI prompts if it's missing)
  - merge mode reads an existing manifest, adds new bindings, warns about removals, and auto-generates capability entries
  - outputs to stdout, to a file, or directly into an existing manifest with `--write`
- `xript-runtime` (Rust) gained three headline features
  - `load_mod()` now executes mod entry scripts after fragment validation (#87)
  - async host bindings with `Promise`/`await` support via `pollster` (#86) — host functions return real Promises, JS callers can `await` them, chained awaits work
  - `XriptHandle` — a `Send + Sync` wrapper that owns an `XriptRuntime` on a dedicated thread, communicates via `mpsc` channels, mirrors the full runtime API (#88)
- introduced **tier 4 "Full Feature"** adoption tier covering slots, mod manifests, fragments, and the sandbox fragment API
  - updated adoption tiers docs, spec, vision, README, and CONTRIBUTING
  - `xript init` scaffolds tier 4 apps with slots, companion mod manifests, and fragment HTML
  - UI Dashboard example linked as the tier 4 reference implementation
- improved `@xriptjs/docgen` with two new flags
  - `--link-format no-extension` strips `.md` from generated links for static site generators that don't want them
  - `--frontmatter` injects YAML frontmatter into all generated files
- built the **Fragment Workbench** (#85), an interactive tool page on the docs site for building and testing xript UI fragments
  - tabbed workflow (Manifest, Author, Preview, Export) with collapsible inline guides
  - CodeJar syntax highlighting for manifest JSON and fragment HTML editors
  - slot contract panel, JSML toggle, validation-as-you-type, dynamic state simulation
  - Export tab with live mod manifest preview and one-click download
- overhauled the **Fragment Builder** demo
  - RPG dungeon theme ("Realm of Xript") with ASCII roguelike map
  - radio-pill slot selection, individual fragment close buttons, CodeJar editor
- added two new screens to `xript-wiz`
  - audit: capability coverage analysis showing ungated bindings, unused capabilities, capability gaps, and risk distribution
  - diff: compares the current manifest against the last git tag, surfacing added/removed bindings, capabilities, and slots
  - home menu expanded from 4 to 6 items
- consolidated docs site tool pages from 6 separate pages to 3 (CLI, TUI Wizard, Fragment Workbench)
  - unified CLI reference page with all subcommands, flags, examples, and programmatic API links
  - new TUI Wizard page with `Terminal.astro` component mockups for home, audit, and diff screens
  - added Annotations spec page to the Specification sidebar section
  - updated all four runtime doc pages with `loadMod`, fragment hooks, async bindings, and `XriptHandle`
  - fixed stale tool references (`xript-validate` to `xript validate`, etc.) across the entire docs site
- updated the publish pipeline for 8 npm packages (added `@xriptjs/cli`); `scripts/bump-version.mjs` now handles 14 files

### Test counts

| package | v0.3.1 | v0.4.0 |
|---------|--------|--------|
| `@xriptjs/sanitize` | 71 | 71 |
| `@xriptjs/validate` | 25 | 25 |
| `@xriptjs/typegen` | 31 | 31 |
| `@xriptjs/docgen` | 22 | 28 |
| `@xriptjs/init` | 27 | 34 |
| `@xriptjs/cli` | — | 29 |
| `@xriptjs/runtime` | 97 | 97 |
| `@xriptjs/runtime-node` | 97 | 97 |
| `xript-runtime` (Rust) | 31 | 45 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 33 | 35 |
| `Xript.Runtime` (C#) | 116 | 116 |
| **total** | **608** | **666** |

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
