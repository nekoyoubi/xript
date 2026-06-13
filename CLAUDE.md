# CLAUDE.md

## What is xript?

xript is a platform specification for making any application moddable. Users write JavaScript; xript standardizes the bindings, capability model, sandboxing guarantees, documentation, and tooling. See [spec/vision.md](spec/vision.md) for the full vision.

## Repository Structure

This is a monorepo managed via npm workspaces.

```
xript/
├── spec/           # the specification (manifest schema, capability model, etc.)
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
- **Runtime sandbox (js)**: QuickJS compiled to WASM via `quickjs-emscripten`, runs in browser, Node, Deno, and more
- **Runtime sandbox (node)**: Node.js `vm` module with `codeGeneration: { strings: false, wasm: false }`
- **Runtime sandbox (rust)**: QuickJS via `rquickjs` (native), for Rust host applications
- **Runtime sandbox (csharp)**: Jint (pure C# JS interpreter), for .NET host applications
- **Fragment renderer (ratatui)**: `xript-ratatui` crate renders `application/x-ratatui+json` fragments as native Ratatui terminal widgets
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
npx xript run <mod> --invoke export    # load a mod into the QuickJS-WASM sandbox
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
- **Format**: version header with a descriptive theme (`## v0.3.0 — Fragment Protocol`), followed by past-tense bullet points. Sub-bullets for implementation detail. Backtick all code references.
- **Voice**: run changelog entries through Elle before committing — this is user-facing copy.
- **Scope**: one top-level changelog for the whole monorepo. Reference specific packages inline with backticked names when a change is package-specific (`@xriptjs/sanitize`, `xript-runtime`, etc.).
- **No dates in headers**: versions are tagged in git; dates go stale in text.
- **Test counts table**: include a before/after test count table at the bottom of each version entry.

## Current State

v0.7.0 shipped — Capability Hierarchy & Live Events (1612 tests across 12 packages). Five pillars: hierarchical capabilities, live event delivery, xript libs, the host harness, and `fills` consumption in every runtime. All four runtimes are kept at parity against shared contracts (capability corpus, extends corpus, sanitizer corpus).

- **Spec**: manifest schema (`spec/manifest.schema.json`, `$id` at v0.7 with v0.6/v0.3 alias resolution) with `slots`, `extends` inheritance, `reserved` flags, top-level `events`, a `libraries` allow-list (capability-gated importable libraries), open enums, and `$schema` overlay extensibility; capability model (`spec/capabilities.md`, prefix-subsumption + read/write mode lattice, `capabilityRef` grammar, conformance corpus `spec/capability-tests.json`); mod manifest built around `fills` keyed by host slot id (fragment, role, hook-handler, and pure-data fills are all slot fills; legacy `fragments[]`/`contributions` accepted as deprecated, mixing them with `fills` is an error); fragment protocol + format catalog (`spec/fragments.md`, `spec/fragment-formats.md`); hooks as event-typed slots with live `events.on`/`emit` delivery (`spec/hooks.md`); ES module authoring + approved libraries (`spec/modules.md` — default-deny imports, allow-list lift, import-clean rule); host harness (`spec/harness.md` + descriptor/steps schemas — stub bindings, journals, library sources, replayable scenarios); naming grammars split on purpose (`spec/bindings.md` Two Grammars); DAP-shaped debug protocol; capability-grant data shapes; HTML sanitizer conformance suite; annotation tags
- **HTML Sanitizer**: `@xriptjs/sanitize` -- pure string-based HTML+JSML sanitizer, no DOM dependency, 93 tests
- **Universal Runtime**: `@xriptjs/runtime` -- QuickJS WASM sandbox with subsumption-based capability enforcement (+ audit), live events, approved-library module loading, `fills`-native `loadMod`, export-backed hook fills, ES modules, host-invoke exports, slot/role resolution, `extends`, debug protocol, hard caps + cancellation, fragment processing, 256 tests
- **Node.js Runtime**: `@xriptjs/runtime-node` -- Node vm sandbox at full parity (`SourceTextModule` linking for approved libraries, fills, events, subsumption), 252 tests
- **Rust Runtime**: `xript-runtime` -- native QuickJS via rquickjs at parity (library resolver/loader with load-phase gating, `normalize_mod_fills`, `cap_match` subsumption, events, hooks, `XriptHandle`), 185 tests
- **C# Runtime**: `Xript.Runtime` -- Jint sandbox at full parity (Modules.Add library registration, `FillsNormalizer`, subsumption, events), 298 tests
- **Ratatui Renderer**: `xript-ratatui` -- fragment renderer for Ratatui terminal apps, 58 tests
- **TUI Wizard**: `xript-wiz` -- interactive TUI wizard dogfooding the ecosystem, 35 tests
- **Unified CLI**: `@xriptjs/cli` -- single `xript` command (validate, typegen, docgen, init, sanitize, scan, describe, score, score-diff, lint, run, guide) plus the host harness (`run --harness --steps`, `createHarnessSession`/`runSteps` exported) and `xript mcp` with persistent harnessed sessions (`xript_host_load`/`xript_host_step`/`xript_host_journal`/`xript_host_list`/`xript_host_unload`), `xript://spec/*` and `xript://guidance/*` resources, 76 tests
- **Toolchain**: validator (subsumption-aware `crossValidate`/`lint`/`score`, exported `satisfies`/`grantedSatisfies` bound to the capability corpus, fill-payload checks, `extends` + `$schema` resolution, 169 tests), typegen (ambient mod declarations incl. `declare module` stubs for approved libraries, event-typed-slot hook fold, open enums, 82 tests), docgen (Libraries section, hook-slot fold, shared capability predicate, 61 tests), init (modern `fills` scaffolds with a runnable harness demo, 44 tests), sanitizer (93 tests)
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
- **Two smart attributes only**: `data-bind` and `data-if` are the hard wall — everything beyond that goes through the sandbox fragment API
- **Host declares slots, mods fill them**: the contribution surface is one concept — a host declares typed slots (each slot's `accepts` type governs what a valid fill looks like and what the host does with it: mount, call, resolve, or fire), and a mod contributes through a single `fills` object keyed by slot id. Fragments, provider roles, and hook handlers are all just fills of slots of a particular type, not separate top-level surfaces. Legacy `fragments[]` / `contributions` / standalone `hooks` are accepted with deprecation warnings
- **More extensible, not less**: the framework defaults toward openness; a restriction is permitted only when it genuinely buys convenience or security the framework couldn't otherwise provide, and must justify itself plainly. This is why the manifest top level accepts `$schema` overlays, remote schema resolution is allowed-unless-opted-out, and the mod `license` field exists
- **Manifests inherit**: a manifest names base manifests in `extends`, resolved and deep-merged base-then-child before validation. A child can add-new, fill an `abstract` base type, or `refine` a concrete one; any other collision errors so inheritance never silently clobbers. The same resolver runs across all four runtimes and across `validate` / `typegen` / `docgen`
- **Score measures capacity, lint finds problems**: `xript score` rates how much extension surface a host exposes against the ceiling of exposing all of it (capacity, not how much a mod set exercises it); `xript lint` is the actionable findings list behind the number. Analyzers live in `@xriptjs/validate` so hosts can import them
- **JSML is core**: `application/jsml+json` (JsonML array format) is a built-in fragment format — native JSON markup with no escaping, processed by all JS/Node runtimes alongside `text/html`
- **Mods compile to ES modules**: `entry.format: "module"` evaluates a real ES module; top-level named exports auto-register as host-invokable. No external imports, no CommonJS — `require`/`module.exports` fail loudly. TypeScript authoring is first-class via `typegen --ambient`
- **Runtimes stay persistence-agnostic**: record types are described through the `types` surface; the host owns storage. Capability-grant shapes are schemas only — grant policy and prompt UX stay host-side
- **Engine fidelity is documented, not faked**: the debug protocol uses DAP vocabulary across all four runtimes but per-engine limits (rquickjs has no per-line hook, QuickJS-WASM needs the async sandbox, Jint pauses on the engine thread) are surfaced rather than papered over
