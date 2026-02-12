# xript

**eXtensible Runtime Interface Protocol Tooling**

*mod the it*

[![CI](https://github.com/nekoyoubi/xript/actions/workflows/ci.yml/badge.svg)](https://github.com/nekoyoubi/xript/actions/workflows/ci.yml)

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
    xript: "0.1",
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

## Documentation

**[xript.dev](https://xript.dev)**: the full documentation site.

- [Vision](https://xript.dev/vision): the guiding principles
- [Adoption Tiers](https://xript.dev/adoption-tiers): the three-tier incremental adoption model
- [Getting Started](https://xript.dev/getting-started): five-minute integration guide
- [JS/WASM Runtime](https://xript.dev/runtimes/js-wasm): the universal runtime (QuickJS WASM)
- [Node.js Runtime](https://xript.dev/runtimes/node): the Node.js-optimized runtime
- [Rust Runtime](https://xript.dev/runtimes/rust): the native Rust runtime (QuickJS via rquickjs)
- [Manifest Spec](https://xript.dev/spec/manifest): the manifest format
- [Security Guarantees](https://xript.dev/spec/security): what the sandbox promises
- [Expression Evaluator](https://xript.dev/examples/expression-evaluator): tier 1 walkthrough
- [Plugin System](https://xript.dev/examples/plugin-system): tier 2 walkthrough
- [Game Mod System](https://xript.dev/examples/game-mod-system): tier 3 walkthrough

## Repository Structure

```
xript/
├── spec/           # the specification (manifest schema, capabilities, bindings, security)
├── runtimes/
│   ├── js/         # universal runtime (@xriptjs/runtime, QuickJS WASM sandbox)
│   ├── node/       # Node.js-optimized runtime (@xriptjs/runtime-node, vm-based)
│   └── rust/       # native Rust runtime (xript-runtime, QuickJS via rquickjs)
├── tools/
│   ├── validate/            # @xriptjs/validate
│   ├── typegen/             # @xriptjs/typegen
│   ├── docgen/              # @xriptjs/docgen
│   └── init/                # @xriptjs/init
├── docs/           # documentation site (Astro + Starlight) → xript.dev
└── examples/
    ├── expression-evaluator/  # tier 1 "safe eval replacement" demo
    ├── plugin-system/         # tier 2 namespace + capability demo
    └── game-mod-system/         # tier 3 dungeon crawler modding demo
```

## Tools

| Tool | Package | What it does |
|------|---------|-------------|
| Validator | `@xriptjs/validate` | Validates manifests against the spec schema |
| Type Generator | `@xriptjs/typegen` | Generates TypeScript `.d.ts` from manifests |
| Doc Generator | `@xriptjs/docgen` | Generates markdown API docs from manifests |
| Init CLI | `@xriptjs/init` | Scaffolds new xript projects |

```sh
npx xript-validate manifest.json         # validate
npx xript-typegen manifest.json          # generate TypeScript types
npx xript-docgen manifest.json -o docs/  # generate documentation
npx @xriptjs/init my-project            # scaffold a new project
```

## Project Status

| Milestone | Status |
|-----------|--------|
| Spec v0.2 | Complete: manifest schema, capabilities, bindings, hook lifecycle, security |
| Universal Runtime | Complete: QuickJS WASM sandbox, runs in browser/Node/Deno/Bun |
| Node.js Runtime | Complete: Node.js vm-based sandbox with `createRuntimeFromFile`, hooks, improved errors |
| Rust Runtime | Complete: native QuickJS sandbox via rquickjs, host bindings, capability enforcement |
| Toolchain | Complete: validator, typegen, docgen, init CLI |
| Developer Experience | Complete: 20-page docs site, getting started guide, runtime API reference, example walkthroughs, live demos |
| Hardening | Complete: 229 tests across 8 packages, manifest validation, CI smoke tests |
| Publishing | Live: all 6 npm packages under `@xriptjs` (OIDC trusted publishing), Rust crate on crates.io |

## License

MIT
