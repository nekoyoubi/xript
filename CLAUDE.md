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
npm run docs:dev                       # run the docs site locally on port 4351
npm run docs:build                     # build the docs site for production

# build and test individual packages (build sanitize first — runtimes depend on it)
npm run build --workspace=tools/sanitize           # build the HTML sanitizer
npm test --workspace=tools/sanitize                # run sanitizer tests (93 tests)
npm run build --workspace=runtimes/js              # build the universal runtime
npm test --workspace=runtimes/js                   # run universal runtime tests (166 tests)
npm run build --workspace=runtimes/node            # build the Node.js runtime
npm test --workspace=runtimes/node                 # run Node.js runtime tests (165 tests)
npm run build --workspace=tools/validate            # build the validator
npm test --workspace=tools/validate                 # run validator tests (68 tests)
npm run build --workspace=tools/typegen            # build the type generator
npm test --workspace=tools/typegen                 # run typegen tests (52 tests)
npm run build --workspace=tools/docgen             # build the doc generator
npm test --workspace=tools/docgen                  # run docgen tests (35 tests)
npm run build --workspace=tools/init               # build the init CLI
npm test --workspace=tools/init                    # run init tests (41 tests)
npm run build --workspace=tools/cli                # build the unified CLI
npm test --workspace=tools/cli                     # run CLI tests (38 tests)

# build and test Rust packages
cd runtimes/rust && cargo build                    # build the Rust runtime
cd runtimes/rust && cargo test                     # run Rust runtime tests (125 tests)
cd renderers/ratatui && cargo build                # build the Ratatui fragment renderer
cd renderers/ratatui && cargo test                 # run Ratatui renderer tests (58 tests)
cd tools/wiz && cargo build                        # build the TUI wizard
cd tools/wiz && cargo test                         # run TUI wizard tests (35 tests)

# build and test the C# runtime
dotnet build runtimes/csharp/Xript.Runtime.sln     # build the C# runtime
dotnet test runtimes/csharp/Xript.Runtime.sln      # run C# runtime tests (201 tests)

# unified CLI (run from repo root after npm install)
npx xript validate <manifest.json>     # validate a manifest against the spec schema
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

v0.5.0 shipped — Hardening, Roles & a Debugger (1077 tests across 12 packages). All four runtimes are kept at parity against a shared contract.

- **Spec**: manifest schema (`spec/manifest.schema.json`, `spec/manifest.md`) with `slots`, `extends` deep-merge, and record `fieldDefinition` (`default` + inline `enum`); mod manifest (`spec/mod-manifest.schema.json`, `spec/manifest.md`) with `contributions.provides` provider roles, host-invoke exports, and a top-level `family` field; fragment protocol (`spec/fragments.md`) and fragment format catalog (`spec/fragment-formats.md`); ES module authoring (`spec/modules.md`); DAP-shaped debug protocol (`spec/debug-protocol.md`, `spec/debug-messages.schema.json`); capability-grant data shapes (`spec/capability-prompt.schema.json`, `spec/install-descriptor.schema.json`, `spec/discovery-result.schema.json`); HTML sanitizer conformance suite (`spec/sanitizer-tests.json`, 56 cases); annotation tags (`spec/annotations.md`)
- **HTML Sanitizer**: `@xriptjs/sanitize` in `tools/sanitize/` -- pure string-based HTML+JSML sanitizer with no DOM dependency (works in QuickJS WASM), SVG support, `data:` scheme subtype-gated to `image/{png,jpeg,gif,svg+xml}`, 93 tests
- **Universal Runtime**: `@xriptjs/runtime` in `runtimes/js/` -- QuickJS WASM sandbox with capability enforcement (+ audit channel), hooks, `loadMod()`, real ES module evaluation with auto-registered exports, host-invoke export seam, slot resolver, provider-role resolution, debug protocol, hard caps + cooperative cancellation, fragment processing, 166 tests
- **Node.js Runtime**: `@xriptjs/runtime-node` in `runtimes/node/` -- Node.js vm-based sandbox at full parity (`SourceTextModule` for ES modules, AST-instrumented debugging, token checked at execute/invoke entry), 165 tests
- **Rust Runtime**: `xript-runtime` in `runtimes/rust/` -- native QuickJS sandbox via rquickjs with host bindings (sync and async), capability enforcement + audit, hooks, hard caps + cooperative cancellation, ES module evaluation, host-invoke exports, provider roles, debug protocol, `namespace_builder`/`add_mixed_namespace`, `load_mod()`, fragment processing, `XriptHandle` Send+Sync wrapper, 125 tests
- **C# Runtime**: `Xript.Runtime` in `runtimes/csharp/` -- Jint sandbox at full parity (ES modules, synchronous-thread debugging, cancellation, provider roles, host-invoke exports), 201 tests
- **Ratatui Renderer**: `xript-ratatui` in `renderers/ratatui/` -- fragment renderer for Ratatui terminal apps, parses `application/x-ratatui+json` into native widgets, 58 tests
- **TUI Wizard**: `xript-wiz` in `tools/wiz/` -- interactive TUI wizard that dogfoods the xript ecosystem (fragments rendered by `xript-ratatui`), audit and diff screens for manifest analysis, 35 tests
- **Unified CLI**: `@xriptjs/cli` in `tools/cli/` -- single `xript` command with subcommands for validate, typegen, docgen, init, sanitize, and scan, 38 tests
- **Toolchain**: manifest validator (app + mod, auto-detection, cross-validation, `extends` resolution + cycle detection, 68 tests), type generator (slot + fragment API types, `--ambient` mod-authoring declarations, provider roles, record accessors, 52 tests), doc generator (slot docs + fragment API page + role/record surfaces + `--link-format` + `--frontmatter`, 35 tests), init CLI (app + mod scaffolding + tier 4 + `--mod --typescript` ESM scaffold, 41 tests), sanitizer (93 tests)
- **Examples**: `expression-evaluator/`, `plugin-system/`, `game-mod-system/`, `ui-dashboard/` (full fragment protocol), and `svelte-fragment-renderer/` (reference host glue rendering inert fragment output as Svelte; not a published package)
- **Developer Experience**: docs site at xript.dev, getting started guide, runtime API reference, runtime overview comparison, "Authoring Mods in TypeScript" guide, example walkthroughs, interactive hero playground, interactive live demos including Fragment Builder and Fragment Workbench
- **Publishing**: all npm packages live under `@xriptjs` scope (OIDC trusted publishing, provenance attestations), Rust crates on crates.io, C# package on NuGet; all publish workflows (`publish.yml`, `publish-nuget.yml`, `publish-crates.yml`) trigger on GitHub Release creation with `workflow_dispatch` as manual fallback

## Key Design Decisions

- **The manifest is the product**: everything derives from the manifest schema (types, docs, validation)
- **Safety is non-negotiable**: no eval, no sandbox escape, default-deny capabilities
- **JavaScript is the modding language**: not because it's perfect, but because it's known
- **Incremental adoption**: four tiers (expressions only, simple bindings, advanced scripting, full feature)
- **Universal portability**: QuickJS WASM sandbox runs anywhere JavaScript runs (browser, Node, Deno, Bun, Cloudflare Workers)
- **Fragments are inert templates**: all dynamic behavior routes through the sandbox (data-bind for values, data-if for visibility, events for interaction, command buffer for mutations)
- **Two smart attributes only**: `data-bind` and `data-if` are the hard wall — everything beyond that goes through the sandbox fragment API
- **Mod manifests ship with fragments**: mods declare themselves and their UI contributions in a single declarative manifest
- **JSML is core**: `application/jsml+json` (JsonML array format) is a built-in fragment format — native JSON markup with no escaping, processed by all JS/Node runtimes alongside `text/html`
- **Mods compile to ES modules**: `entry.format: "module"` evaluates a real ES module; top-level named exports auto-register as host-invokable. No external imports, no CommonJS — `require`/`module.exports` fail loudly. TypeScript authoring is first-class via `typegen --ambient`
- **Roles, not hardcoded globals**: cross-addon collaboration goes through `contributions.provides` + host `resolve_role`; declaring a role grants nothing, the named fns stay gated by their own capabilities
- **Runtimes stay persistence-agnostic**: record types are described through the `types` surface; the host owns storage. Capability-grant shapes are schemas only — grant policy and prompt UX stay host-side
- **Engine fidelity is documented, not faked**: the debug protocol uses DAP vocabulary across all four runtimes but per-engine limits (rquickjs has no per-line hook, QuickJS-WASM needs the async sandbox, Jint pauses on the engine thread) are surfaced rather than papered over
