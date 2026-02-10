# CLAUDE.md

## What is xript?

xript (eXtensible Runtime Interface Protocol Tooling) is a platform specification for making any application moddable. Users write JavaScript; xript standardizes the bindings, capability model, sandboxing guarantees, documentation, and tooling. See [spec/vision.md](spec/vision.md) for the full vision.

## Repository Structure

This is a monorepo managed via npm workspaces.

```
xript/
├── spec/           # the specification (manifest schema, capability model, etc.)
├── runtimes/       # language-specific runtime implementations
│   ├── js/         # universal runtime (@xript/runtime, QuickJS WASM sandbox)
│   └── node/       # Node.js-optimized runtime (@xript/runtime-node, vm-based)
├── tools/          # ecosystem tooling (validator, typegen, docgen)
├── docs/           # documentation site (Astro + Starlight), deployed to xript.dev
└── examples/       # example manifests and integrations
```

## Tech Stack

- **Docs site**: Astro with Starlight, deployed to GitHub Pages via GitHub Actions (live demos depend on `@xript/runtime` -- CI builds the runtime before docs)
- **Package management**: npm workspaces
- **Language**: TypeScript throughout
- **Runtime sandbox (js)**: QuickJS compiled to WASM via `quickjs-emscripten` — runs in browser, Node, Deno, and more
- **Runtime sandbox (node)**: Node.js `vm` module with `codeGeneration: { strings: false, wasm: false }`
- **Test runner**: Node.js built-in test runner (`node --test`)

## Development Commands

```sh
npm install                            # install all workspace dependencies
npm run docs:dev                       # run the docs site locally on port 4351
npm run docs:build                     # build the docs site for production

# build and test individual packages
npm run build --workspace=runtimes/js              # build the universal runtime
npm test --workspace=runtimes/js                   # run universal runtime tests (58 tests)
npm run build --workspace=runtimes/node            # build the Node.js runtime
npm test --workspace=runtimes/node                 # run Node.js runtime tests (60 tests)
npm run build --workspace=tools/manifest-validator # build the validator
npm test --workspace=tools/manifest-validator      # run validator tests (11 tests)
npm run build --workspace=tools/typegen            # build the type generator
npm test --workspace=tools/typegen                 # run typegen tests (20 tests)
npm run build --workspace=tools/docgen             # build the doc generator
npm test --workspace=tools/docgen                  # run docgen tests (14 tests)

# tools (run from repo root after npm install)
npx xript-validate <manifest.json>     # validate a manifest against the spec schema
npx xript-typegen <manifest.json>      # generate TypeScript definitions (stdout)
npx xript-typegen <m.json> -o out.d.ts # generate TypeScript definitions (file)
npx xript-docgen <m.json> -o docs/     # generate markdown documentation

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

## Current State

All v0.1 milestones are complete:

- **Spec v0.1**: manifest schema (JSON Schema draft 2020-12), capability model, binding conventions, and security guarantees documented in `spec/`
- **Universal Runtime**: `@xript/runtime` in `runtimes/js/` -- QuickJS WASM sandbox with capability enforcement, 58 tests (36 unit + 22 integration)
- **Node.js Runtime**: `@xript/runtime-node` in `runtimes/node/` -- Node.js vm-based sandbox with `createRuntimeFromFile` and full schema validation, 60 tests
- **Toolchain**: manifest validator, type generator, and doc generator all built and tested in `tools/` (45 tests across 3 packages)
- **Developer Experience**: docs site at xript.dev (19 pages), getting started guide, runtime API reference, three example walkthroughs, three interactive live demos (browser-only QuickJS WASM), CI with smoke tests
- **Hardening**: integration tests, manifest validation in runtime, example smoke tests in CI

Total test count: 163 across 6 packages. All green.

## Key Design Decisions

- **The manifest is the product**: everything derives from the manifest schema (types, docs, validation)
- **Safety is non-negotiable**: no eval, no sandbox escape, default-deny capabilities
- **JavaScript is the modding language**: not because it's perfect, but because it's known
- **Incremental adoption**: three tiers (expressions only, simple bindings, full scripting)
- **Universal portability**: QuickJS WASM sandbox runs anywhere JavaScript runs (browser, Node, Deno, Bun, Cloudflare Workers)
