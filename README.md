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
    xript: "0.3",
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

All four support host bindings, capability enforcement, hooks, resource limits, `loadMod()`, and fragment processing. The Rust runtime adds async host bindings (`Promise`/`await`) and `XriptHandle` for `Send + Sync` thread-safe ownership.

## Fragments

v0.3 introduced the fragment protocol: host apps declare UI _slots_, mods contribute HTML (or JSML, or Ratatui JSON) fragments into those slots. Two smart attributes handle dynamic behavior:

- `data-bind` for value binding (O(1) updates at game-loop speed)
- `data-if` for conditional visibility

Everything beyond that routes through the sandbox fragment API (command buffer pattern). The protocol is rendering-agnostic; the same mod manifest can target a browser, a terminal, or a native desktop app.

`@xriptjs/sanitize` ships a pure string-based HTML sanitizer with no DOM dependency. It works inside QuickJS WASM, which means sanitization runs in the sandbox itself.

## Toolchain

One CLI. Six subcommands.

```sh
npx xript validate manifest.json           # validate app or mod manifests
npx xript typegen manifest.json            # generate TypeScript .d.ts from a manifest
npx xript docgen manifest.json -o docs/    # generate markdown API docs
npx xript init                             # scaffold a new xript project (interactive)
npx xript init --mod                       # scaffold a mod project
npx xript sanitize fragment.html           # sanitize an HTML fragment
npx xript scan src/ --manifest m.json      # scan @xript JSDoc tags into a manifest
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

**[xript.dev](https://xript.dev)** -- 29 pages, interactive demos, live playground.

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
- [Annotations](https://xript.dev/spec/annotations): `@xript` JSDoc tag convention
- [Security Guarantees](https://xript.dev/spec/security): what the sandbox promises
- [CLI Reference](https://xript.dev/tools/cli): unified CLI with all subcommands
- [TUI Wizard](https://xript.dev/tools/wiz): interactive terminal wizard
- [Fragment Workbench](https://xript.dev/tools/fragment-workbench): build and test fragments interactively
- [Expression Evaluator](https://xript.dev/examples/expression-evaluator): tier 1 walkthrough
- [Plugin System](https://xript.dev/examples/plugin-system): tier 2 walkthrough
- [Game Mod System](https://xript.dev/examples/game-mod-system): tier 3 walkthrough
- [UI Dashboard](https://xript.dev/examples/ui-dashboard): tier 4 walkthrough

## Project Status

v0.4.1 -- 666 tests across 12 packages.

| Area | Status |
|------|--------|
| Spec | v0.3: app manifests, mod manifests, slots, fragment protocol, capability model, security, annotations |
| Runtimes | 4 complete: JS/WASM, Node.js, Rust (async bindings, `XriptHandle`), C# |
| Renderers | `xript-ratatui`: terminal fragment renderer for Ratatui apps |
| Toolchain | unified `xript` CLI with validate, typegen, docgen, init, sanitize, scan; TUI wizard with audit and diff |
| Publishing | 12 packages live: 8 npm (`@xriptjs/*`), 3 Rust crates (`crates.io`), 1 NuGet; OIDC trusted publishing with provenance |
| Docs | 29-page site at xript.dev; interactive hero playground, Fragment Builder, Fragment Workbench |

## License

MIT
