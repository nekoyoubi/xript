# xript

**eXtensible Runtime Interface Protocol Tooling**

*mod the it*

[![CI](https://github.com/nekoyoubi/xript/actions/workflows/ci.yml/badge.svg)](https://github.com/nekoyoubi/xript/actions/workflows/ci.yml)

---

xript is a platform specification for making any application moddable. Users write JavaScript. xript standardizes the bindings, the capability model, the sandboxing guarantees, the documentation, and the tooling.

One JSON manifest. Everything else is derived.

## Quick Start

```sh
npm install @xript/runtime-js
```

```javascript
import { createRuntime } from "@xript/runtime-js";

const runtime = createRuntime(
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
```

## Documentation

**[xript.dev](https://xript.dev)** -- the full documentation site.

- [Vision](https://xript.dev/vision) -- the guiding principles
- [Getting Started](https://xript.dev/getting-started) -- five-minute integration guide
- [Manifest Spec](https://xript.dev/spec/manifest) -- the manifest format
- [Security Guarantees](https://xript.dev/spec/security) -- what the sandbox promises

## Repository Structure

```
xript/
├── spec/           # the specification (manifest schema, capabilities, bindings, security)
├── runtimes/
│   └── js/         # reference runtime (@xript/runtime-js)
├── tools/
│   ├── manifest-validator/  # @xript/manifest-validator
│   ├── typegen/             # @xript/typegen
│   └── docgen/              # @xript/docgen
├── docs/           # documentation site (Astro + Starlight) → xript.dev
└── examples/
    ├── expression-evaluator/  # tier 1 "safe eval replacement" demo
    └── game-mod-system.json   # tier 3 full manifest example
```

## Tools

| Tool | Package | What it does |
|------|---------|-------------|
| Manifest Validator | `@xript/manifest-validator` | Validates manifests against the spec schema |
| Type Generator | `@xript/typegen` | Generates TypeScript `.d.ts` from manifests |
| Doc Generator | `@xript/docgen` | Generates markdown API docs from manifests |

```sh
npx xript-validate manifest.json      # validate
npx xript-typegen manifest.json       # generate TypeScript types
npx xript-docgen manifest.json -o docs/  # generate documentation
```

## Project Status

| Milestone | Status |
|-----------|--------|
| Spec v0.1 | Complete -- manifest schema, capabilities, bindings, security |
| Reference Runtime | Complete -- Node.js vm-based sandbox with full spec compliance |
| Toolchain | Complete -- validator, typegen, docgen |
| Developer Experience | In progress -- docs, examples, guides |

## License

MIT
