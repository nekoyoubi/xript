# Expression Evaluator Example

This example demonstrates **xript's tier 1 adoption**: safe expression evaluation. It takes about five minutes to understand and shows how xript turns any application into a safe expression evaluator.

## What It Does

A host application loads an xript manifest that exposes a handful of math and string functions, then evaluates user expressions in a sandboxed environment. Scripts can use the declared bindings but cannot access the file system, network, or any undeclared APIs.

## Quick Start

From the repository root:

```sh
npm install
npm run build --workspace=runtimes/js

# Run the non-interactive demo
node examples/expression-evaluator/src/demo.js

# Or start the interactive REPL
node examples/expression-evaluator/src/host.js
```

## The Manifest

The manifest (`manifest.json`) declares 11 bindings -- basic math and string operations:

| Binding | Description |
|---------|-------------|
| `abs(x)` | Absolute value |
| `round(x)` | Round to nearest integer |
| `floor(x)` | Round down |
| `ceil(x)` | Round up |
| `min(a, b)` | Smaller of two numbers |
| `max(a, b)` | Larger of two numbers |
| `clamp(value, lo, hi)` | Clamp between bounds |
| `upper(s)` | Uppercase a string |
| `lower(s)` | Lowercase a string |
| `len(s)` | String length |
| `concat(a, b)` | Join two strings |

No capabilities are defined because all bindings are safe read-only operations.

## The Host Application

The host (`src/host.js`) does three things:

1. **Loads the manifest** from `manifest.json`
2. **Provides host implementations** for each declared binding (simple wrappers around `Math.*` and `String.*`)
3. **Creates an xript runtime** and evaluates user input against it

The entire integration is about 30 lines of code.

## What the Sandbox Blocks

The demo (`src/demo.js`) shows that the sandbox correctly blocks undeclared APIs:

```
eval("1 + 1")          => ERROR: eval() is not permitted
process.exit(1)         => ERROR: process is not defined
require("fs")           => ERROR: require is not defined
fetch('https://...')    => ERROR: fetch is not defined
```

Meanwhile, standard JavaScript expressions and the declared bindings work normally:

```
clamp(42, 0, 10)        => 10
upper("hello world")    => "HELLO WORLD"
abs(min(-5, -10))       => 10
2 + 2                   => 4
[1,2,3].map(x => x*2)  => [2, 4, 6]
```

## Key Takeaway

An application integrating xript at tier 1 only needs to:

1. Write a manifest declaring its safe bindings
2. Provide host functions for those bindings
3. Create a runtime and call `execute()`

The sandbox, security guarantees, and capability model come for free.
