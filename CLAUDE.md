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
├── tools/          # ecosystem tooling (validator, typegen, docgen, init, sanitize)
├── docs/           # documentation site (Astro + Starlight), deployed to xript.dev
└── examples/       # example manifests and integrations
```

## Tech Stack

- **Docs site**: Astro with Starlight, deployed to GitHub Pages via GitHub Actions (live demos depend on `@xriptjs/runtime` -- CI builds the runtime before docs)
- **Package management**: npm workspaces
- **Language**: TypeScript throughout
- **Runtime sandbox (js)**: QuickJS compiled to WASM via `quickjs-emscripten`, runs in browser, Node, Deno, and more
- **Runtime sandbox (node)**: Node.js `vm` module with `codeGeneration: { strings: false, wasm: false }`
- **Runtime sandbox (rust)**: QuickJS via `rquickjs` (native), for Rust host applications
- **Runtime sandbox (csharp)**: Jint (pure C# JS interpreter), for .NET host applications
- **Test runner**: Node.js built-in test runner (`node --test`), xUnit for C#

## Development Commands

```sh
npm install                            # install all workspace dependencies
npm run docs:dev                       # run the docs site locally on port 4351
npm run docs:build                     # build the docs site for production

# build and test individual packages
npm run build --workspace=runtimes/js              # build the universal runtime
npm test --workspace=runtimes/js                   # run universal runtime tests (69 tests)
npm run build --workspace=runtimes/node            # build the Node.js runtime
npm test --workspace=runtimes/node                 # run Node.js runtime tests (71 tests)
npm run build --workspace=tools/validate            # build the validator
npm test --workspace=tools/validate                 # run validator tests (11 tests)
npm run build --workspace=tools/typegen            # build the type generator
npm test --workspace=tools/typegen                 # run typegen tests (24 tests)
npm run build --workspace=tools/docgen             # build the doc generator
npm test --workspace=tools/docgen                  # run docgen tests (17 tests)
npm run build --workspace=tools/init               # build the init CLI
npm test --workspace=tools/init                    # run init tests (20 tests)
npm run build --workspace=tools/sanitize           # build the HTML sanitizer
npm test --workspace=tools/sanitize                # run sanitizer tests (57 tests)

# build and test the Rust runtime
cd runtimes/rust && cargo build                    # build the Rust runtime
cd runtimes/rust && cargo test                     # run Rust runtime tests (17 tests)

# build and test the C# runtime
dotnet build runtimes/csharp/Xript.Runtime.sln     # build the C# runtime
dotnet test runtimes/csharp/Xript.Runtime.sln      # run C# runtime tests (72 tests)

# tools (run from repo root after npm install)
npx xript-validate <manifest.json>     # validate a manifest against the spec schema
npx xript-typegen <manifest.json>      # generate TypeScript definitions (stdout)
npx xript-typegen <m.json> -o out.d.ts # generate TypeScript definitions (file)
npx xript-docgen <m.json> -o docs/     # generate markdown documentation
npx xript-init                         # scaffold a new xript project (interactive)
npx xript-init --yes                   # scaffold with defaults (no prompts)

# run example demos
node examples/expression-evaluator/src/demo.js  # tier 1 demo
node examples/plugin-system/src/demo.js          # tier 2 demo
node examples/game-mod-system/src/demo.js        # tier 3 demo
```

## Conventions

- TypeScript for all new code
- Self-documenting code preferred over inline comments (see global rules)
- JSDoc for public API documentation
- Commit messages follow the project's commit style guide (short header < 50 chars, past tense, markdown bullets for details)
- PRs merged with merge commits (not squash) to preserve full history

## Changelog

A top-level `CHANGELOG.md` tracks all releases. Follow these rules:

- **When to update**: every PR that ships user-facing changes (features, fixes, breaking changes, new packages). Skip internal refactors, CI tweaks, and doc typo fixes.
- **Format**: version header with a descriptive theme (`## v0.3.0 — Fragment Protocol`), followed by past-tense bullet points. Sub-bullets for implementation detail. Backtick all code references.
- **Voice**: run changelog entries through Elle before committing — this is user-facing copy.
- **Scope**: one top-level changelog for the whole monorepo. Reference specific packages inline with backticked names when a change is package-specific (`@xriptjs/sanitize`, `xript-runtime`, etc.).
- **No dates in headers**: versions are tagged in git; dates go stale in text.
- **Test counts table**: include a before/after test count table at the bottom of each version entry.

## Current State

v0.3 in progress — UI Fragment Protocol and Mod Manifests:

- **Spec v0.3**: manifest schema extended with `slots`, new mod manifest schema (`spec/mod-manifest.schema.json`), fragment protocol specification (`spec/fragments.md`), HTML sanitizer conformance suite (`spec/sanitizer-tests.json`, 42 test cases)
- **HTML Sanitizer**: `@xriptjs/sanitize` in `tools/sanitize/` -- pure string-based HTML sanitizer with no DOM dependency (works in QuickJS WASM), 57 tests
- **Universal Runtime**: `@xriptjs/runtime` in `runtimes/js/` -- QuickJS WASM sandbox with capability enforcement, hook system, `loadMod()`, fragment processing (`data-bind`, `data-if`), sandbox fragment API (command buffer pattern), 95 tests
- **Node.js Runtime**: `@xriptjs/runtime-node` in `runtimes/node/` -- Node.js vm-based sandbox with fragment support (in progress)
- **Rust Runtime**: `xript-runtime` in `runtimes/rust/` -- native QuickJS sandbox via rquickjs with host bindings, capability enforcement, hooks, and resource limits, 17 tests (fragment support pending)
- **C# Runtime**: `Xript.Runtime` in `runtimes/csharp/` -- Jint sandbox with host bindings, capability enforcement, hooks, and resource limits, 72 tests (fragment support pending)
- **Toolchain**: manifest validator (mod manifest support in progress), type generator (slot + fragment API types, 31 tests), doc generator (slot docs + fragment API page, 22 tests), init CLI (mod project scaffolding in progress), sanitizer (57 tests)
- **Examples**: four examples including `ui-dashboard/` demonstrating the full fragment protocol (slots, mod manifests, `data-bind`, `data-if`, sandbox fragment API)
- **Developer Experience**: docs site at xript.dev, getting started guide, runtime API reference, runtime overview comparison, four example walkthroughs, interactive hero playground with live simulations, three interactive live demos (Fragment Builder showcase pending)
- **Publishing**: all npm packages live under `@xriptjs` scope (OIDC trusted publishing, provenance attestations), Rust crate on crates.io, C# package on NuGet

## Key Design Decisions

- **The manifest is the product**: everything derives from the manifest schema (types, docs, validation)
- **Safety is non-negotiable**: no eval, no sandbox escape, default-deny capabilities
- **JavaScript is the modding language**: not because it's perfect, but because it's known
- **Incremental adoption**: three tiers (expressions only, simple bindings, full scripting)
- **Universal portability**: QuickJS WASM sandbox runs anywhere JavaScript runs (browser, Node, Deno, Bun, Cloudflare Workers)
- **Fragments are inert templates**: all dynamic behavior routes through the sandbox (data-bind for values, data-if for visibility, events for interaction, command buffer for mutations)
- **Two smart attributes only**: `data-bind` and `data-if` are the hard wall — everything beyond that goes through the sandbox fragment API
- **Mod manifests ship with fragments**: mods declare themselves and their UI contributions in a single declarative manifest
- **JSML is core**: `application/jsml+json` (JsonML array format) is a built-in fragment format — native JSON markup with no escaping, processed by all JS/Node runtimes alongside `text/html`
