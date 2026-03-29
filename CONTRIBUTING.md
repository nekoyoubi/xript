# Contributing to xript

xript is open to contributions. Here is what you need to know to get started.

## Development Setup

```sh
git clone https://github.com/nekoyoubi/xript.git
cd xript
npm install
```

This installs dependencies for all workspace packages. The repo is a monorepo managed via npm workspaces.

## Repository Structure

```
xript/
├── spec/           # the specification (manifest schema, capability model, etc.)
├── runtimes/
│   ├── js/         # universal runtime (@xriptjs/runtime, QuickJS WASM sandbox)
│   ├── node/       # Node.js-optimized runtime (@xriptjs/runtime-node, vm-based)
│   └── rust/       # native Rust runtime (xript-runtime, QuickJS via rquickjs)
├── tools/          # ecosystem tooling (validator, typegen, docgen, init)
├── docs/           # documentation site (Astro + Starlight), deployed to xript.dev
└── examples/       # example manifests and integrations
```

## Building and Testing

Each package builds and tests independently:

```sh
npm run build --workspace=runtimes/js
npm test --workspace=runtimes/js

npm run build --workspace=runtimes/node
npm test --workspace=runtimes/node

npm run build --workspace=tools/validate
npm test --workspace=tools/validate

npm run build --workspace=tools/typegen
npm test --workspace=tools/typegen

npm run build --workspace=tools/docgen
npm test --workspace=tools/docgen

npm run build --workspace=tools/init
npm test --workspace=tools/init

# Rust runtime (requires Rust toolchain)
cd runtimes/rust && cargo build
cd runtimes/rust && cargo test
```

The docs site runs locally with:

```sh
npm run docs:dev    # dev server on port 4351
npm run docs:build  # production build
```

## Conventions

- **TypeScript** for all new code
- **Self-documenting code** preferred over inline comments
- **JSDoc** for public API documentation
- **Node.js built-in test runner** (`node --test`) for all packages
- **Commit messages** follow the project style: short header < 50 chars, past tense, markdown bullets for details

## Branch Strategy

`main` is protected. All work happens on feature branches:

- `feature/` for new functionality
- `fix/` for bug fixes
- `clean/` for refactoring, cleanup, and docs

PRs are merged with merge commits (not squash) to preserve full commit history.

## Pull Requests

- Keep PRs focused: one theme per PR
- Include tests for new functionality
- Run the relevant package's test suite before opening the PR
- PR descriptions should include a summary and test plan

## Key Design Decisions

These principles guide all contributions:

- **The manifest is the product.** Everything derives from the manifest schema.
- **Safety is non-negotiable.** No eval, no sandbox escape, default-deny capabilities.
- **JavaScript is the modding language.** Not because it is perfect, but because it is known.
- **Incremental adoption.** Four tiers: expressions only, simple bindings, advanced scripting, full feature.
- **Universal portability.** The universal runtime runs anywhere JavaScript runs.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
