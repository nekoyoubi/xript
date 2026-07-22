# CLAUDE.md

## What is xript?

xript is a platform specification for making any application moddable. Users write JavaScript; xript standardizes the bindings, capability model, sandboxing guarantees, documentation, and tooling. See [spec/vision.md](spec/vision.md) for the full vision.

## Repository Structure

This is a monorepo managed via npm workspaces.

```
xript/
├── spec/           # the specification (manifest schema, capability model, etc.)
├── crates/         # shared Rust crates
│   └── xript-expr/ # the xript Expression Grammar (XEG), parser + evaluator, zero deps
├── runtimes/       # language-specific runtime implementations
│   ├── js/         # universal runtime (@xriptjs/runtime, QuickJS WASM sandbox)
│   ├── node/       # Node.js-optimized runtime (@xriptjs/runtime-node, vm-based)
│   ├── rust/       # native Rust runtime (xript-runtime, QuickJS via rquickjs)
│   └── csharp/     # C# runtime (Xript.Runtime, Jint sandbox)
├── renderers/      # fragment renderer implementations
│   └── ratatui/    # terminal renderer (xript-ratatui, Ratatui widgets)
├── tools/          # ecosystem tooling (validator, typegen, docgen, init, sanitize, wiz)
│   └── wiz/        # interactive TUI wizard (xript-wiz, powered by xript fragments)
├── docs/           # documentation site (Astro + Starlight), deployed to xript.dev
└── examples/       # example manifests and integrations
```

## Tech Stack

- **Docs site**: Astro with Starlight, deployed to GitHub Pages via GitHub Actions (live demos depend on `@xriptjs/runtime` -- CI builds sanitize then runtime before docs)
- **Package management**: npm workspaces
- **Language**: TypeScript throughout
- **Runtime sandbox (js)**: QuickJS compiled to WASM via `quickjs-emscripten-core` plus the two release variants (`@jitl/quickjs-wasmfile-release-sync` for `initXript`, `@jitl/quickjs-wasmfile-release-asyncify` for `initXriptAsync`); each variant sits in its own module (`src/quickjs-sync.ts` / `src/quickjs-async.ts`) so a sync-only host never bundles the asyncify build. Runs in browser, Node, Deno, and more
- **Runtime sandbox (node)**: Node.js `vm` module with `codeGeneration: { strings: false, wasm: false }`
- **Runtime sandbox (rust)**: QuickJS via `rquickjs` (native), for Rust host applications
- **Runtime sandbox (csharp)**: Jint (pure C# JS interpreter), for .NET host applications
- **Fragment renderer (ratatui)**: `xript-ratatui` crate renders `application/x-ratatui+json` fragments as native Ratatui terminal widgets
- **Expression grammar**: `xript-expr` (Rust) and `@xriptjs/sanitize`'s `expr`/`interpolate` modules (TS) implement XEG, the one grammar behind `data-if`, `data-bind`, and `{{ }}` interpolation. Held to `spec/expression-tests.json` by every runtime and the Ratatui renderer
- **Test runner**: Node.js built-in test runner (`node --test`), xUnit for C#

## Development Commands

```sh
npm install                            # install all workspace dependencies
npm run dev                            # run the docs site locally on port 4351 (alias of docs:dev)
npm run docs:dev                       # run the docs site locally on port 4351
npm run docs:build                     # build the docs site for production

# build and test individual packages (build sanitize first — runtimes depend on it)
npm run build --workspace=tools/sanitize           # build the HTML sanitizer
npm test --workspace=tools/sanitize                # run sanitizer tests (93 tests)
npm run build --workspace=runtimes/js              # build the universal runtime
npm test --workspace=runtimes/js                   # run universal runtime tests (256 tests)
npm run build --workspace=runtimes/node            # build the Node.js runtime
npm test --workspace=runtimes/node                 # run Node.js runtime tests (252 tests)
npm run build --workspace=tools/validate            # build the validator
npm test --workspace=tools/validate                 # run validator tests (169 tests)
npm run build --workspace=tools/typegen            # build the type generator
npm test --workspace=tools/typegen                 # run typegen tests (82 tests)
npm run build --workspace=tools/docgen             # build the doc generator
npm test --workspace=tools/docgen                  # run docgen tests (61 tests)
npm run build --workspace=tools/init               # build the init CLI
npm test --workspace=tools/init                    # run init tests (44 tests)
npm run build --workspace=tools/cli                # build the unified CLI
npm test --workspace=tools/cli                     # run CLI tests (76 tests)

# build and test Rust packages
cd crates/xript-expr && cargo test                 # run the expression grammar corpus (13 suites)
cd runtimes/rust && cargo build                    # build the Rust runtime
cd runtimes/rust && cargo test                     # run Rust runtime tests (185 tests)
cd renderers/ratatui && cargo build                # build the Ratatui fragment renderer
cd renderers/ratatui && cargo test                 # run Ratatui renderer tests (58 tests)
cd tools/wiz && cargo build                        # build the TUI wizard
cd tools/wiz && cargo test                         # run TUI wizard tests (38 tests)

# build and test the C# runtime
dotnet build runtimes/csharp/Xript.Runtime.sln     # build the C# runtime
dotnet test runtimes/csharp/Xript.Runtime.sln      # run C# runtime tests (298 tests)

# unified CLI (run from repo root after npm install)
npx xript validate <manifest.json>     # validate a manifest (resolves `extends` first)
npx xript typegen <manifest.json>      # generate TypeScript definitions (stdout)
npx xript typegen <m.json> -o out.d.ts # generate TypeScript definitions (file)
npx xript typegen <m.json> --ambient   # emit ambient .d.ts declaring the `xript` global (mod authoring)
npx xript docgen <m.json> -o docs/     # generate markdown documentation
npx xript init                         # scaffold a new xript project (interactive)
npx xript init --yes                   # scaffold with defaults (no prompts)
npx xript init --mod                   # scaffold a new mod project
npx xript init --mod --typescript      # scaffold an ESM TypeScript mod project
npx xript sanitize <file.html>         # sanitize an HTML fragment
npx xript scan src/ --manifest m.json  # scan @xript annotations into manifest
npx xript describe <m.json>            # summarize a host's bindings/hooks/slots/capabilities
npx xript score <m.json> --min N       # rate moddability capacity, with a CI gate
npx xript score-diff <m.json> --baseline b.json  # capacity regression gate (--min-delta N)
npx xript lint <m.json> --strict       # findings-based reviewer (errors/warnings/info)
npx xript run <mod> <entry.js> --export <name>  # load a mod, invoke an export (bare run supplies no host bindings)
npx xript run --app h.json --harness x.json --steps s.json  # run a scenario against a synthetic (stub-binding) host
npx xript guide <topic>                # print xript authoring doctrine by topic
npx xript mcp                          # run @xriptjs/cli as a Model Context Protocol server (stdio)

# run example demos
node examples/expression-evaluator/src/demo.js  # tier 1 demo
node examples/plugin-system/src/demo.js          # tier 2 demo
node examples/game-mod-system/src/demo.js        # tier 3 demo
node examples/ui-dashboard/src/demo.js           # fragment protocol demo
```

## Conventions

- TypeScript for all new code
- Self-documenting code preferred over inline comments (see global rules)
- JSDoc for public API documentation
- Commit messages follow the project's commit style guide (short header < 50 chars, past tense, markdown bullets for details)
- PRs merged with merge commits (not squash) to preserve full history

## Release Process

Versions are unified across all 12 published packages. Two scripts handle the mechanics:

1. **`npm run version:bump <version>`** — syncs the version across all 14 package files (npm, Rust, C#) and internal dependency references. Run `npm install` after to refresh the lockfile.
2. **`npm run release`** — creates a GitHub Release from the current version in the packages and the matching `CHANGELOG.md` section. Triggers all publish workflows automatically.

**When preparing a release PR, always:**
- Run `npm run version:bump <version>` and `npm install`
- Add/update the `CHANGELOG.md` entry for the new version (run through Elle — it's user-facing copy)
- The user runs `npm run release` after merge — no arguments needed, it reads the version from the packages

**The user should never need to run `version:bump` directly.** That's Claude's job during PR prep.

## Changelog

A top-level `CHANGELOG.md` tracks all releases. Follow these rules:

- **When to update**: every PR that ships user-facing changes (features, fixes, breaking changes, new packages). Skip internal refactors, CI tweaks, and doc typo fixes.
- **Format**: version header, followed by past-tense bullet points. Sub-bullets for implementation detail. Backtick all code references. Versions are not named — the header carries the version and nothing else. Entries through v0.8.0 carry themes for historical reasons; nothing after them does.
- **Voice**: run changelog entries through Elle before committing — this is user-facing copy.
- **Scope**: one top-level changelog for the whole monorepo. Reference specific packages inline with backticked names when a change is package-specific (`@xriptjs/sanitize`, `xript-runtime`, etc.).
- **No dates in headers**: versions are tagged in git; dates go stale in text.
- **Test counts table**: include a before/after test count table at the bottom of each version entry.

## Current State

v0.8.1 shipped — a consistency pass on the toolchain over v0.8.0's fragment-formats-and-hardening base (5112 tests across 14 packages): unknown top-level manifest keys now warn instead of error on both host and mod manifests (a deliberate change from v0.8.0's host-side hard error — the runtime ignores a stray top-level key anyway, and the warning still catches the silent typo of an optional key), the mod-manifest schema opens at the top level so `$schema`+`allOf` overlays compose symmetrically with the host, and MCP `xript_validate` routes a file argument through the same file-aware validators the CLI uses. The v0.8.0 pillar underneath: the fragment protocol had always been documented as format-agnostic while every runtime collapsed a fragment to an HTML string before the host saw it, and an unregistered format silently fell through to `sanitizeHTML()`. Now a host declares which formats it intakes and which vocabularies each speaks, the runtime returns a validated tree instead of a flattened string, and an unregistered format is a hard error. Under that pillar ran a long security and correctness pass — a real `data-if` sandbox escape closed (expression evaluation was leaking to host JS outside QuickJS), the three expression sites unified under one grammar (XEG) held to a shared corpus across all five evaluators, the HTML sanitizer rebuilt on a shared allow-list port with mXSS/content-loss holes closed and a URI-scheme allow-list refusing `javascript:`/`vbscript:`, and `@xriptjs/runtime`'s install cut from 9.32 MiB to 1.52 MiB by loading only the QuickJS variant a host selects. All four runtimes are kept at parity against shared contracts (capability corpus, extends corpus, sanitizer corpus, fragment-vocabulary corpus, fragment-op corpus, expression corpus).

- **Spec**: manifest schema (`spec/manifest.schema.json`, `$id` at v0.8 with v0.7/v0.6/v0.3 alias resolution) with `slots`, `extends` inheritance, `reserved` flags, top-level `events`, a top-level `vocabularies` block (reusable node vocabularies, `html` a built-in referenced by name), a `libraries` allow-list (capability-gated importable libraries), open enums, and `$schema` overlay extensibility; capability model (`spec/capabilities.md`, prefix-subsumption + read/write mode lattice, `capabilityRef` grammar, conformance corpus `spec/capability-tests.json`); mod manifest built around `fills` keyed by host slot id (fragment, role, hook-handler, and pure-data fills are all slot fills; legacy `fragments[]`/`contributions` accepted as deprecated, mixing them with `fills` is an error); fragment protocol + format registry + vocabulary model (`spec/fragments.md`, `spec/fragment-formats.md` — a host declares which formats it intakes and the ordered vocabularies each format scopes; the runtime returns a validated tree, an unregistered format is a hard error, conformance corpora `spec/fragment-vocabulary-tests.json` + fragment-op tests generated from the reference impl and asserted by every runtime); one expression grammar (XEG, `spec/expressions.md`) behind `data-if`/`data-bind`/`{{ }}`, held to `spec/expression-tests.json` across all five evaluators; hooks as event-typed slots with live `events.on`/`emit` delivery (`spec/hooks.md`); ES module authoring + approved libraries (`spec/modules.md` — default-deny imports, allow-list lift, import-clean rule); host harness (`spec/harness.md` + descriptor/steps schemas — stub bindings, journals, library sources, replayable scenarios); naming grammars split on purpose (`spec/bindings.md` Two Grammars); DAP-shaped debug protocol; capability-grant data shapes; HTML sanitizer conformance suite; annotation tags
- **HTML Sanitizer**: `@xriptjs/sanitize` -- pure string-based HTML+JSML sanitizer, no DOM dependency, rebuilt on a shared allow-list port that serializes from the tree it already builds (one traversal for markup and removal report, always well-formed output), URI-scheme allow-list refusing `javascript:`/`vbscript:`, mXSS and content-loss holes closed, XEG `expr`/`interpolate` modules, 679 tests
- **Universal Runtime**: `@xriptjs/runtime` -- QuickJS WASM sandbox (install trimmed to 1.52 MiB via `quickjs-emscripten-core`, loading only the sync or asyncify variant a host selects) with subsumption-based capability enforcement (+ audit), live events, approved-library module loading, `fills`-native `loadMod`, format registry + vocabulary validation returning a validated fragment tree, export-backed hook fills, ES modules, host-invoke exports, slot/role resolution, `extends`, debug protocol, hard caps + cancellation, 879 tests
- **Node.js Runtime**: `@xriptjs/runtime-node` -- Node vm sandbox at full parity (`SourceTextModule` linking for approved libraries, fills, events, subsumption, format registry + vocabulary trees), 880 tests
- **Rust Runtime**: `xript-runtime` -- native QuickJS via rquickjs at parity (library resolver/loader with load-phase gating, `normalize_mod_fills`, `cap_match` subsumption, events, hooks, `XriptHandle`, vocabulary model + tree contract on the `j5ml` crate), 385 tests
- **C# Runtime**: `Xript.Runtime` -- Jint sandbox at full parity (Modules.Add library registration, `FillsNormalizer`, subsumption, events, vocabulary model hand-rolled on `System.Text.Json`, HTML sanitizer replaced with the shared allow-list port), 1304 tests
- **Ratatui Renderer**: `xript-ratatui` -- fragment renderer for Ratatui terminal apps, 58 tests
- **Expression Grammar**: `xript-expr` -- Rust parser + evaluator for XEG (the one grammar behind `data-if`/`data-bind`/`{{ }}`), zero deps, held to `spec/expression-tests.json`, 13 suites
- **TUI Wizard**: `xript-wiz` -- interactive TUI wizard dogfooding the ecosystem, 38 tests
- **Unified CLI**: `@xriptjs/cli` -- single `xript` command (validate, typegen, docgen, init, sanitize, scan, describe, score, score-diff, lint, run, guide) plus the host harness (`run --harness --steps`, `createHarnessSession`/`runSteps` exported) and `xript mcp` with persistent harnessed sessions (`xript_host_load`/`xript_host_step`/`xript_host_journal`/`xript_host_list`/`xript_host_unload`), `xript://spec/*` and `xript://guidance/*` resources, 115 tests
- **Toolchain**: validator (subsumption-aware `crossValidate`/`lint`/`score`, exported `satisfies`/`grantedSatisfies` bound to the capability corpus, fill-payload checks, fragment-tree vocabulary validation, resolved-scope `lint` findings, `extends` + `$schema` resolution, 430 tests), typegen (ambient mod declarations incl. `declare module` stubs for approved libraries, per-node `[name, props, ...children]` tuple types over a vocabulary, event-typed-slot hook fold, open enums, 163 tests), docgen (Libraries section, per-format node tables, hook-slot fold, shared capability predicate, 109 tests), init (modern `fills` scaffolds with a runnable harness demo, 53 tests), sanitizer (679 tests)
- **Examples**: `expression-evaluator/`, `plugin-system/`, `game-mod-system/`, `ui-dashboard/` and `svelte-fragment-renderer/` (both loading `fills` natively, no conversion shims)
- **Developer Experience**: xript.dev restructured by reader role (Start Here / Doctrine / Hosting xript / Authoring Mods / Specification / Runtimes / Tools); spec pages and the `/changelog/` page generated from the repo sources at build; every schema served at its `$id` URL with version aliases; a zero-to-first-mod walkthrough; explicit prerequisites and `command not found` rescue notes on the entry pages
- **Publishing**: all npm packages under `@xriptjs` scope (OIDC trusted publishing), Rust crates on crates.io, C# on NuGet; publish workflows trigger on GitHub Release creation

## Key Design Decisions

- **The manifest is the product**: everything derives from the manifest schema (types, docs, validation)
- **Safety is non-negotiable**: no eval, no sandbox escape, default-deny capabilities
- **JavaScript is the modding language**: not because it's perfect, but because it's known
- **Incremental adoption**: four tiers (expressions only, simple bindings, advanced scripting, full feature)
- **Universal portability**: QuickJS WASM sandbox runs anywhere JavaScript runs (browser, Node, Deno, Bun, Cloudflare Workers)
- **Fragments are inert templates**: all dynamic behavior routes through the sandbox (data-bind for values, data-if for visibility, events for interaction, command buffer for mutations)
- **Two smart attributes only**: `data-bind` and `data-if` are the hard wall — everything beyond that goes through the sandbox fragment API. Both carry XEG, one grammar with one set of semantics in all five evaluators; `{{ }}` interpolation is that same grammar in a text position, opt-in per fill, and refused in attribute values because a prop's sink judges a whole value and cannot judge one assembled from halves
- **Host declares slots, mods fill them**: the contribution surface is one concept — a host declares typed slots (each slot's `accepts` type governs what a valid fill looks like and what the host does with it: mount, call, resolve, or fire), and a mod contributes through a single `fills` object keyed by slot id. Fragments, provider roles, and hook handlers are all just fills of slots of a particular type, not separate top-level surfaces. Legacy `fragments[]` / `contributions` / standalone `hooks` are accepted with deprecation warnings
- **More extensible, not less**: the framework defaults toward openness; a restriction is permitted only when it genuinely buys convenience or security the framework couldn't otherwise provide, and must justify itself plainly. This is why the manifest top level accepts `$schema` overlays, remote schema resolution is allowed-unless-opted-out, and the mod `license` field exists
- **Manifests inherit**: a manifest names base manifests in `extends`, resolved and deep-merged base-then-child before validation. A child can add-new, fill an `abstract` base type, or `refine` a concrete one; any other collision errors so inheritance never silently clobbers. The same resolver runs across all four runtimes and across `validate` / `typegen` / `docgen`
- **Score measures capacity, lint finds problems**: `xript score` rates how much extension surface a host exposes against the ceiling of exposing all of it (capacity, not how much a mod set exercises it); `xript lint` is the actionable findings list behind the number. Analyzers live in `@xriptjs/validate` so hosts can import them
- **Fragments carry a validated tree, not a flattened string**: the fragment protocol is genuinely format-agnostic — a host declares a format registry (which formats it intakes) and a `vocabularies` block (reusable node sets, `html` built-in), a format names its syntax plus the ordered vocabularies in scope, and the runtime returns a validated tree. An unregistered format is a hard error, not a silent pass to `sanitizeHTML()`. A declared vocabulary is checkable (`validate` rejects a misspelled node at CI), typeable (`typegen` emits a `[name, props, ...children]` tuple per node), and documentable (`docgen` publishes a node table per format). All four runtimes cut at parity against shared fragment-vocabulary/fragment-op corpora generated from the reference impl
- **JSML is core**: `application/jsml+json` (J5ML array format) is a built-in fragment format — native JSON markup with no escaping, case-sensitive with an open tag namespace so PascalCase component nodes survive; attribute order is Unicode-code-point normalized on serialization; every runtime depends on the published j5ml implementation (`@nxis/j5ml`, the `j5ml` crate, the `J5ml` package)
- **Mods compile to ES modules**: `entry.format: "module"` evaluates a real ES module; top-level named exports auto-register as host-invokable. No external imports, no CommonJS — `require`/`module.exports` fail loudly. TypeScript authoring is first-class via `typegen --ambient`
- **Runtimes stay persistence-agnostic**: record types are described through the `types` surface; the host owns storage. Capability-grant shapes are schemas only — grant policy and prompt UX stay host-side
- **Engine fidelity is documented, not faked**: the debug protocol uses DAP vocabulary across all four runtimes but per-engine limits (rquickjs has no per-line hook, QuickJS-WASM needs the async sandbox, Jint pauses on the engine thread) are surfaced rather than papered over
