# xript

*mod the it*

[![CI](https://github.com/nekoyoubi/xript/actions/workflows/ci.yml/badge.svg)](https://github.com/nekoyoubi/xript/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xriptjs/runtime?label=npm)](https://www.npmjs.com/package/@xriptjs/runtime)
[![crates.io](https://img.shields.io/crates/v/xript-runtime?label=crates.io)](https://crates.io/crates/xript-runtime)
[![NuGet](https://img.shields.io/nuget/v/Xript.Runtime?label=nuget)](https://www.nuget.org/packages/Xript.Runtime)
[![docs](https://img.shields.io/badge/docs-xript.dev-blue)](https://xript.dev)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

xript is a platform specification for making any application moddable. Users write JavaScript. xript standardizes the bindings, the capability model, the sandboxing guarantees, the documentation, and the tooling.

One JSON manifest. Everything else is derived.

## Quick Start

```sh
npm install @xriptjs/runtime
```

```javascript
import { initXript } from "@xriptjs/runtime";

const xript = await initXript();
const runtime = xript.createRuntime(
  {
    xript: "0.7",
    name: "my-app",
    bindings: {
      greet: {
        description: "Returns a greeting.",
        params: [{ name: "name", type: "string" }],
        returns: "string",
      },
    },
  },
  {
    hostBindings: { greet: (name) => `Hello, ${name}!` },
    console: { log: console.log, warn: console.warn, error: console.error },
  },
);

runtime.execute('greet("World")'); // => { value: "Hello, World!", duration_ms: ... }

// The sandbox blocks anything not in the manifest
runtime.execute("process.exit(1)"); // Error: process is not defined
runtime.execute('eval("1")');       // Error: eval() is not permitted

runtime.dispose();
```

## Runtimes

Four runtimes, same manifest, same security model.

| Runtime | Package | Sandbox | Where it runs |
|---------|---------|---------|---------------|
| JS/WASM | `@xriptjs/runtime` | QuickJS compiled to WASM | browser, Node, Deno, Bun, Cloudflare Workers |
| Node.js | `@xriptjs/runtime-node` | Node.js `vm` module | Node.js |
| Rust | `xript-runtime` | QuickJS via rquickjs (native) | any Rust host (Tauri, CLI, servers) |
| C# | `Xript.Runtime` | Jint (pure C# JS interpreter) | any .NET host (Unity, WPF, Blazor) |

All four support host bindings, capability enforcement, live events, hooks, resource limits, `loadMod()` with native `fills` resolution, approved-library imports, and fragment processing. Parity is pinned by shared conformance corpora the four runtimes all assert: capability subsumption (33 cases), manifest inheritance, and the HTML sanitizer suite.

v0.7.0's pillars run through every runtime. Hierarchical capabilities give you prefix subsumption plus a read/write mode lattice. Deliverable events mean `events.on` in the sandbox and `emit` from the host. The `libraries` allow-list imports whole pre-bundled ES modules in-sandbox, at the mod's own privilege. Hook fills are export-backed. ES module mods, provider roles, cooperative cancellation, hard caps, the audit channel, and the DAP-shaped debug protocol all carry forward from earlier releases. The Rust runtime adds async host bindings (`Promise`/`await`) and `XriptHandle` for `Send + Sync` thread-safe ownership.

## Fragments

v0.3 introduced the fragment protocol: host apps declare UI _slots_, mods contribute HTML (or JSML, or Ratatui JSON) fragments into those slots. Two smart attributes handle dynamic behavior:

- `data-bind` for value binding (O(1) updates at game-loop speed)
- `data-if` for conditional visibility

Everything beyond that routes through the sandbox fragment API (command buffer pattern). The protocol is rendering-agnostic; the same mod manifest can target a browser, a terminal, or a native desktop app.

`@xriptjs/sanitize` ships a pure string-based HTML sanitizer with no DOM dependency. It works inside QuickJS WASM, which means sanitization runs in the sandbox itself.

## Toolchain

One CLI. Every workflow.

```sh
npx xript validate manifest.json           # validate app or mod manifests (resolves extends)
npx xript typegen manifest.json --ambient  # TypeScript definitions; ambient mode for mod authoring
npx xript docgen manifest.json -o docs/    # generate markdown API docs
npx xript init --mod --typescript          # scaffold an app or mod project
npx xript sanitize fragment.html           # sanitize an HTML fragment
npx xript scan src/ --manifest m.json      # scan @xript JSDoc tags into a manifest
npx xript describe manifest.json           # summarize a host's surface
npx xript score manifest.json --min 80     # rate moddability capacity, with a CI gate
npx xript lint manifest.json --strict      # actionable findings behind the score
npx xript run mod.json mod.js --export go  # run a mod in the real sandbox
npx xript run --app h.json --steps s.json  # run a harnessed scenario, no app required
npx xript mcp                              # the whole CLI as an MCP server for agents
```

`xript scan` reads `@xript` and `@xript-cap` JSDoc annotations from TypeScript source and generates manifest bindings and capabilities. Point it at your codebase, get a manifest back.

The TUI wizard (`xript-wiz`) provides an interactive terminal interface for the same workflows, plus manifest audit and diff screens. It dogfoods the xript ecosystem: the wizard's own UI is rendered through `xript-ratatui` fragments.

## Adoption Tiers

Incremental by design. Start wherever makes sense; move up when you need to.

| Tier | What it gives you | Example |
|------|-------------------|---------|
| 1. Expressions | safe eval replacement for user-authored formulas | [Expression Evaluator](https://xript.dev/examples/expression-evaluator) |
| 2. Bindings | namespaced host functions with capability gating | [Plugin System](https://xript.dev/examples/plugin-system) |
| 3. Scripting | hooks, lifecycle events, multi-mod loading | [Game Mod System](https://xript.dev/examples/game-mod-system) |
| 4. Full Feature | slots, mod manifests, fragments, sandbox fragment API | [UI Dashboard](https://xript.dev/examples/ui-dashboard) |

## Repository Structure

```
xript/
├── spec/             # the specification (manifest schema, mod manifests, fragments, security)
├── runtimes/
│   ├── js/           # universal runtime (@xriptjs/runtime, QuickJS WASM)
│   ├── node/         # Node.js runtime (@xriptjs/runtime-node, vm-based)
│   ├── rust/         # Rust runtime (xript-runtime, rquickjs)
│   └── csharp/       # C# runtime (Xript.Runtime, Jint)
├── renderers/
│   └── ratatui/      # terminal fragment renderer (xript-ratatui)
├── tools/
│   ├── cli/          # unified CLI (@xriptjs/cli)
│   ├── validate/     # manifest validator (@xriptjs/validate)
│   ├── typegen/      # type generator (@xriptjs/typegen)
│   ├── docgen/       # doc generator (@xriptjs/docgen)
│   ├── init/         # project scaffolder (@xriptjs/init)
│   ├── sanitize/     # HTML sanitizer (@xriptjs/sanitize)
│   └── wiz/          # TUI wizard (xript-wiz)
├── docs/             # documentation site (Astro + Starlight) -> xript.dev
└── examples/
    ├── expression-evaluator/  # tier 1 demo
    ├── plugin-system/         # tier 2 demo
    ├── game-mod-system/       # tier 3 demo
    └── ui-dashboard/          # tier 4 demo
```

## Documentation

**[xript.dev](https://xript.dev)**: 50+ pages, interactive demos, live playground.

- [Vision](https://xript.dev/vision): the seven guiding principles
- [Adoption Tiers](https://xript.dev/adoption-tiers): the four-tier incremental adoption model
- [Getting Started](https://xript.dev/getting-started): five-minute integration guide
- [JS/WASM Runtime](https://xript.dev/runtimes/js-wasm): QuickJS WASM sandbox
- [Node.js Runtime](https://xript.dev/runtimes/node): Node.js vm-based sandbox
- [Rust Runtime](https://xript.dev/runtimes/rust): native QuickJS via rquickjs
- [C# Runtime](https://xript.dev/runtimes/csharp): Jint sandbox for .NET
- [Manifest Spec](https://xript.dev/spec/manifest): the app manifest format
- [Mod Manifest Spec](https://xript.dev/spec/mod-manifest): mod declaration format
- [Fragment Protocol](https://xript.dev/spec/fragments): slots, fragments, data binding, sandbox API
- [Fragment Formats](https://xript.dev/spec/fragment-formats): HTML, JSML, Ratatui JSON, WinForms JSON
- [Capability Model](https://xript.dev/spec/capabilities): default-deny, prefix subsumption, the mode lattice
- [Module-Format Mods](https://xript.dev/spec/modules): ES module entries and approved libraries
- [Manifest Inheritance](https://xript.dev/spec/extends): extends, fill, refine
- [Host Harness](https://xript.dev/spec/harness): synthetic hosts and replayable scenarios
- [Annotations](https://xript.dev/spec/annotations): `@xript` JSDoc tag convention
- [Changelog](https://xript.dev/changelog): what changed, release by release
- [Security Guarantees](https://xript.dev/spec/security): what the sandbox promises
- [CLI Reference](https://xript.dev/tools/cli): unified CLI with all subcommands
- [TUI Wizard](https://xript.dev/tools/wiz): interactive terminal wizard
- [Fragment Workbench](https://xript.dev/tools/fragment-workbench): build and test fragments interactively
- [Expression Evaluator](https://xript.dev/examples/expression-evaluator): tier 1 walkthrough
- [Plugin System](https://xript.dev/examples/plugin-system): tier 2 walkthrough
- [Game Mod System](https://xript.dev/examples/game-mod-system): tier 3 walkthrough
- [UI Dashboard](https://xript.dev/examples/ui-dashboard): tier 4 walkthrough

## Project Status

v0.7.0: 1612 tests across 12 packages.

| Area | Status |
|------|--------|
| Spec | app + mod manifests, `fills`, slots, fragment protocol, hierarchical capabilities (subsumption + mode lattice, shared conformance corpus), live events, approved libraries, the host harness, manifest `extends`, security, annotations |
| Runtimes | 4 at parity: JS/WASM, Node.js, Rust (async bindings, `XriptHandle`), C# — all consuming `fills`, libraries, and events natively |
| Renderers | `xript-ratatui`: terminal fragment renderer for Ratatui apps |
| Toolchain | unified `xript` CLI: validate, typegen (`--ambient`), docgen, init, sanitize, scan, describe, score / score-diff / lint, run (with harnessed scenarios), guide, mcp; TUI wizard with audit and diff |
| Publishing | 12 packages live: 8 npm (`@xriptjs/*`), 3 Rust crates (`crates.io`), 1 NuGet; OIDC trusted publishing with provenance |
| Docs | 50+ page site at xript.dev; spec pages, guidance, and the changelog generated from repo sources; every schema served at its `$id` URL |

## License

MIT
