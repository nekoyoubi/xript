# Changelog

## v0.6.0 — Manifest Inheritance & the Agent CLI

Two stories in one release. Manifests learned to **inherit**: a manifest can `extends` a base, fill the abstract holes the base leaves open, refine the concrete pieces it declares, and the same resolution runs identically across all four runtimes. The CLI grew an **agent**: `@xriptjs/cli` now speaks Model Context Protocol, exposing every capability a human runs at the terminal to an agent over stdio. No separate package, no logic to drift.

### Manifest inheritance (`extends`)

- added manifest inheritance: a manifest names one or more base manifests in `extends`, resolved and deep-merged base-then-child before validation, transitively, with cycle detection
  - three moves on a name that collides with the base; **add-new** introduces a name the base does not have (additive, no marker), **fill** redeclares an `abstract: true` base type with concrete fields or values (abstractness is the opt-in, so no marker), and **refine** redeclares a concrete base type or slot with `refines: true` to deep-merge (child wins per key, nested objects recurse, arrays and scalars replace wholesale)
  - any other collision is an error, so inheritance never silently clobbers; concrete-on-concrete without `refines`, a duplicate binding, a duplicate capability, or a duplicate hook all fail
  - an inherited abstract type left unfilled is an `abstract-type-unfilled` error, so a base can declare a typed hole a child is required to concretize
- made a slot's `payload` carry a full JSON Schema, so a slot can describe exactly what a valid fill looks like (patterns, nested `required`, the lot) instead of a flat field list
- added open enums: a type's `values` or a field's inline `enum` can set `open: true` to mean "these known values, plus any other string"; `typegen` emits `... | (string & {})` so the known values autocomplete while any string still type-checks, and `docgen` marks the type extensible
- brought `extends` resolution to parity across all four runtimes (the universal QuickJS-WASM, Node, Rust, and C#) against an 18-case conformance corpus, so a manifest resolves identically wherever it loads
- consolidated the resolver: `typegen` and `docgen` now reuse `@xriptjs/validate`'s resolver instead of carrying their own copies; one resolution implementation per language, not one per tool
- taught the analyzers (`validate`, `score`, `cross-validate`) to resolve `extends` before they run, so inherited slots and capabilities are seen rather than reported missing

### Contribution model

- redesigned the contribution surface around "host declares typed slots, mod fills them"; a host slot's `accepts` type governs what a valid fill looks like and what the host does with it (mount, call, resolve, or fire)
  - folded fragments, provider roles, and hook handlers into one concept: each is a fill of a slot of a particular type, not a separate top-level surface
  - mods now contribute through a single `fills` object keyed by host slot id; a fragment is a fill of a fragment-format slot, a provider role is a fill of a role-typed slot, a lifecycle hook handler is a fill of an event-typed slot
  - standalone `hooks` is deprecated in favor of event-typed slots; a hook is a slot whose `accepts` is the event-handler kind, and firing it calls that slot's fills, with host-side hook firing unchanged
  - validation stays tolerant of legacy `fragments[]` and `contributions` for smooth migration (still validated, now with a deprecation warning); the fill contract checks that a filled slot exists and the mod holds its capability, and leaves the inner fill shape to the slot's type
  - clarified that format renderers (`xript-ratatui`, the DOM fragment processor) are runtime infrastructure, not manifest concepts; a slot's `accepts` names the format the runtime must be able to paint

### Manifest surfaces

- renamed a fragment fill's DOM event handler array from `events` to `handlers`; the entries are event _handlers_, not events, and the old name said the wrong thing
  - `events` stays accepted as a deprecated alias for back-compat (mirroring the standalone-`hooks` to event-slot precedent): a reader takes `handlers` or `events`, `handlers` wins if both are present, and `events` warns; the entry shape (`selector`, `on`, `handler`) is unchanged, so migration is a key rename
- added a top-level `events` catalog: an optional array declaring the named events a host broadcasts and each one's payload type
  - it is a consumer-agnostic discovery declaration (what the host emits, with no listener presupposed) and is deliberately distinct from event-typed slots (extension points a mod fills) and fragment `handlers` (DOM responses on a fill); one line: bindings are what you can call, slots and handlers are what handles, `events` is what the host emits
  - `typegen` emits a typed event catalog and `docgen` renders an events section
- let a domain extend the top-level manifest vocabulary with a schema overlay, and taught the validator to honor a manifest's declared `$schema`
  - the core manifest's top level no longer rejects unknown top-level properties, so an `allOf` overlay can add domain surfaces and still validate; deeper objects stay closed, so typos inside known surfaces are still caught
  - schema resolution leans open: a known schema id resolves to bundled core, a local path resolves relative to the manifest the way `extends` does, and a remote `http(s)` URL is fetched and cached (keyed by URL, pinned per run); offline or uncached-remote falls back to bundled core with a surfaced warning rather than hard-failing
  - remote resolution is allowed unless a host opts out (allowlist or disable-remote); you opt out of openness, not into it, and honoring a declared schema grants no power, since the capability model, not schema validation, is the security boundary
- bumped the manifest schema `$id` from the v0.3 line to v0.6, with a legacy-id alias so a manifest or overlay still pinning the old id resolves
- added an optional `license` field to the mod manifest (an SPDX id or short label); forbidding it bought nothing under the openness doctrine

### Extensibility scoring & lint

- reshaped `xript score` to measure **moddability capacity**: how much of the extension surface a host exposes (bindings to call, slots to fill, events to observe, a capability model to gate them), against a ceiling of exposing all of it, rather than how much a supplied mod set happens to exercise it
  - exposing a slot the host does not fill itself now reads as moddability, not waste, and resolving `extends` can only raise the score, never drag it down; "find the unused surface" stays `lint`'s job
  - slot and capability utilization survive as informational mod-coverage, now excluding `reserved` and inherited surface from their denominators
  - `score-diff` diffs capacity too, and its regression gate keys off the capacity headline
- taught `cross-validate` to check each fill's payload against the target slot's `payload` schema, closing the gap where a fill could name a real slot, hold its capability, and still carry a payload the slot forbids
  - the schema is applied as authored: a fill carrying more than the payload declares still passes unless the slot explicitly closes its payload; only declared shape is enforced, extras are not policed
  - on by default; `--no-fill-payloads` on the CLI and `checkFillPayloads` in the library and MCP tool flex it off
- added `xript lint`, a findings-based reviewer that complements `score`: where score is the number, lint is the actionable list behind it
  - checks are set arithmetic over manifest fields; filled-but-undeclared slots and undeclared capabilities are errors, dead slots and vestigial capabilities are warnings, ungated and undescribed surfaces are info
  - each finding carries a severity, a stable code, a message, and a suggestion; `--strict` promotes warnings to failures for CI, and the exit code gates accordingly
  - a `legacy-shape` finding flags a mod still on the deprecated `fragments` / `contributions` shape, so migration progress is visible in the linter instead of by grep
- added `xript score-diff`: it compares a current run against a saved baseline and reports whether the surface moved toward or away from xript, naming the capacity delta, the slots and capabilities gained or lost, and the integrity violations introduced or fixed; `--min-delta N` is the regression gate
- added a `reserved` flag to slots and capabilities, so a surface declared ahead of a filler (for forward-compat or inherited parity) is treated as aspirational, never flagged dead or vestigial, and is excluded from coverage
- counted capabilities that gate bindings and hooks (not just slots and mod requests) toward "used," so a capability doing real gating work is never called vestigial
- moved the analyzers (`scoreManifests`, `diffScores`, `lintManifests`) out of the CLI into `@xriptjs/validate`, so a host application can surface a modder's problems in its own UI by importing the validation library it already depends on; the CLI commands and MCP tools are thin front-ends over them

### Agent tooling

- taught `@xriptjs/cli` to run as a Model Context Protocol server via `xript mcp`
  - tools mirror the CLI one-to-one (`xript_validate`, `xript_cross_validate`, `xript_typegen`, `xript_docgen`, `xript_sanitize`, `xript_scaffold`, `xript_scan`, `xript_manifest_describe`, `xript_run`, `xript_score`, `xript_score_diff`, `xript_lint`, and `xript_guide`), each calling the same core its matching command does
  - resources serve the spec straight from source (`xript://spec/*`) alongside authoring guidance (`xript://guidance/*`), and prompts (`adopt-xript`, `is-this-xript-native`, `choose-a-surface`, `author-a-mod`) carry the doctrine as reusable templates
  - manifest-taking tools accept a file path or inline JSON, so a large host manifest needn't ride through the tool-call tokens; relative paths resolve against the client's workspace root
- added `xript_server_info`, reporting the server's name, version, build timestamp, and runtime; the timestamp comes from the running module's own file mtime, so a stale server process whose binary predates a repo change is detectable rather than silently serving old results
- added four commands so the human gets every capability too, not just the agent
  - `xript run` loads a mod into the QuickJS-WASM sandbox and optionally invokes an export
  - `xript describe` summarizes what a host manifest exposes: bindings, hooks, slots, capabilities
  - `xript score` rates a host's moddability capacity, with a `--min` gate for CI
  - `xript guide` prints xript's authoring doctrine by topic
- authored the doctrine as markdown content rather than code; one source of truth behind the `xript guide` command, the `xript_guide` tool, and the `xript://guidance/*` resources

### Doctrine

- added xript's "More extensible, not less" doctrine: the framework defaults toward openness, and a restriction is permitted only when it genuinely buys convenience or security the framework couldn't otherwise provide, and must justify itself plainly
  - authored as guidance content like the other doctrine topics, so it surfaces through the `xript guide` command, the `xript_guide` MCP tool, the `xript://guidance/*` resources, and a Doctrine page on the site from one source

### Docs

- surfaced three subsystems that lived in the spec but never reached the site: Hooks, Module-Format Mods (the TypeScript authoring guide v0.5 promised), and the DAP-shaped Debugging protocol
- documented the v0.5 manifest surfaces the site had missed: provider roles, owned record types, manifest `extends`, the mod `family` field, and the `entry` module form
- added an `extends` / inheritance page, MCP server, Extensibility Score, and Lint pages, surfaced the authoring doctrine as a Doctrine section (derived from one source), and expanded the CLI reference with the new commands
- reframed the manifest, mod-manifest, fragments, and hooks spec pages around the host-slots / mod-fills model; fragments and provider roles and hooks are now documented as typed slot fills, with `fills` as the canonical contribution surface
- generated `llms.txt` and `llms-full.txt` at build time: a curated index and a full-corpus one-pager for agents, linked from the home page
- fixed the CommonJS error in `@xriptjs/validate` pointing at a guide URL that never existed; it now points at the published Module-Format Mods page

### Tests

| Package | Before | After |
|---------|--------|-------|
| `@xriptjs/validate` | 68 | 155 |
| `@xriptjs/typegen` | 52 | 64 |
| `@xriptjs/docgen` | 35 | 42 |
| `@xriptjs/cli` | 38 | 60 |
| `@xriptjs/runtime` | 166 | 187 |
| `@xriptjs/runtime-node` | 165 | 185 |
| `xript-runtime` (Rust) | 125 | 150 |
| `Xript.Runtime` (C#) | 201 | 229 |

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
