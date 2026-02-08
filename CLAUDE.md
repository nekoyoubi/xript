# CLAUDE.md

## What is xript?

xript (eXtensible Runtime Interface Protocol Tooling) is a platform specification for making any application moddable. Users write JavaScript; xript standardizes the bindings, capability model, sandboxing guarantees, documentation, and tooling. See [spec/vision.md](spec/vision.md) for the full vision.

## Repository Structure

This is a monorepo managed via npm workspaces.

```
xript/
├── spec/           # the specification (manifest schema, capability model, etc.)
├── runtimes/       # language-specific runtime implementations
│   └── js/         # reference runtime (planned, QuickJS-based)
├── tools/          # ecosystem tooling (validator, typegen, docgen)
├── docs/           # documentation site (Astro + Starlight), deployed to xript.dev
└── examples/       # example manifests and integrations
```

## Tech Stack

- **Docs site**: Astro with Starlight, deployed to GitHub Pages via GitHub Actions
- **Package management**: npm workspaces
- **Language**: TypeScript throughout
- **Target runtimes**: QuickJS (for sandboxed JS execution), Node.js (for tooling)

## Development Commands

```sh
npm install                            # install all workspace dependencies
npm run docs:dev                       # run the docs site locally on port 4351
npm run docs:build                     # build the docs site for production

# tools (run from repo root after npm install)
npx xript-validate <manifest.json>     # validate a manifest against the spec schema
npx xript-typegen <manifest.json>      # generate TypeScript definitions (stdout)
npx xript-typegen <m.json> -o out.d.ts # generate TypeScript definitions (file)
npx xript-docgen <m.json> -o docs/     # generate markdown documentation
```

## Conventions

- TypeScript for all new code
- Self-documenting code preferred over inline comments (see global rules)
- JSDoc for public API documentation
- Commit messages follow the project's commit style guide (short header < 50 chars, past tense, markdown bullets for details)
- PRs merged with merge commits (not squash) to preserve full history

## Current State

- **Spec v0.1** is complete: manifest schema (JSON Schema draft 2020-12), capability model, binding conventions, and security guarantees are all documented in `spec/`
- **Toolchain** is complete: manifest validator (`@xript/manifest-validator`), type generator (`@xript/typegen`), and doc generator (`@xript/docgen`) are all built and tested in `tools/`
- **Docs site** is live at xript.dev with Starlight, covering the vision and all spec documents
- **Reference runtime** (`runtimes/js/`) is the current focus -- the first implementation of the spec using Node.js `vm` module for sandboxed execution
- Check GitHub issues and milestones for the current roadmap

## Key Design Decisions

- **The manifest is the product**: everything derives from the manifest schema (types, docs, validation, playground)
- **Safety is non-negotiable**: no eval, no sandbox escape, default-deny capabilities
- **JavaScript is the modding language**: not because it's perfect, but because it's known
- **Incremental adoption**: three tiers (expressions only, simple bindings, full scripting)
