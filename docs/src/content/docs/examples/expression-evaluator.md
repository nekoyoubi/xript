---
title: "Example: Expression Evaluator"
description: "A tier 1 integration walkthrough: safe expression evaluation with flat bindings."
---

The simplest way to use xript: expose a set of flat functions to user scripts with no capabilities, no namespaces, and no custom types. This is **tier 1** adoption.

The full source is in [`examples/expression-evaluator/`](https://github.com/nekoyoubi/xript/tree/main/examples/expression-evaluator).

## The Manifest

The manifest declares 11 bindings across two categories: math operations and string operations.

```json
{
  "$schema": "https://xript.dev/schema/manifest/v0.7.json",
  "xript": "0.7",
  "name": "expression-evaluator",
  "version": "1.0.0",
  "title": "Expression Evaluator",
  "bindings": {
    "abs":   { "description": "Returns the absolute value.", "params": [{ "name": "x", "type": "number" }], "returns": "number" },
    "round": { "description": "Rounds to the nearest integer.", "params": [{ "name": "x", "type": "number" }], "returns": "number" },
    "clamp": { "description": "Clamps a value between lo and hi.", "params": [{ "name": "value", "type": "number" }, { "name": "lo", "type": "number" }, { "name": "hi", "type": "number" }], "returns": "number" },
    "upper": { "description": "Converts to uppercase.", "params": [{ "name": "s", "type": "string" }], "returns": "string" },
    "concat": { "description": "Concatenates two strings.", "params": [{ "name": "a", "type": "string" }, { "name": "b", "type": "string" }], "returns": "string" }
  }
}
```

*(Truncated for readability. The full manifest includes `floor`, `ceil`, `min`, `max`, `lower`, and `len`.)*

No `capabilities`, no `types`, no `limits`. About as minimal as a manifest gets while still being useful.

Even a manifest this small works with the unified CLI: `xript validate manifest.json` checks it against the spec schema, and `xript describe manifest.json` summarizes the bindings, slots, and capabilities it exposes.

## The Host

The host provides one JavaScript function for each binding:

```javascript
import { initXript } from "@xriptjs/runtime";

const hostBindings = {
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  clamp: (value, lo, hi) => Math.min(Math.max(value, lo), hi),
  upper: (s) => String(s).toUpperCase(),
  lower: (s) => String(s).toLowerCase(),
  len: (s) => String(s).length,
  concat: (a, b) => String(a) + String(b),
};

const xript = await initXript();
const runtime = xript.createRuntime(manifest, { hostBindings });
```

Each binding is a pure function with no side effects; the safest kind of integration there is. Users compose expressions but cannot touch application state.

## What Users Can Do

Users write expressions that combine your bindings with standard JavaScript. `execute()` returns an `ExecutionResult` (`{ value, duration_ms }`), so the result is read off `.value`:

```javascript
runtime.execute("abs(-42)").value;                    // 42
runtime.execute("clamp(round(3.7), 0, 3)").value;     // 3
runtime.execute('upper(concat("hello", " xript"))').value; // "HELLO XRIPT"
runtime.execute("[1, 2, 3].map(x => abs(x - 5))").value;  // [4, 3, 2]
```

Standard JavaScript features like array methods, template literals, and arrow functions all work inside the sandbox.

## What Users Cannot Do

The sandbox blocks everything not declared in the manifest:

```javascript
runtime.execute('eval("1 + 1")');       // TypeError: eval() is not permitted
runtime.execute("process.exit(1)");      // ReferenceError: process is not defined
runtime.execute('require("fs")');        // ReferenceError: require is not defined
runtime.execute("fetch('https://...')"); // ReferenceError: fetch is not defined
```

## Running the Demo

```sh
cd examples/expression-evaluator
node src/demo.js
```

The demo runs all the expressions above and prints their results, including the sandbox enforcement tests.

## When to Use This Pattern

Tier 1 is the right choice when:

- You want users to write **formulas or expressions**, not full scripts
- All operations are **read-only** with no side effects
- You do not need to gate any functionality behind permissions
- You want the **smallest possible manifest** and integration surface

To move beyond tier 1, add [namespaces](/spec/manifest#namespace-bindings), [capabilities](/spec/capabilities), and [custom types](/spec/manifest#types). See the [Plugin System](/examples/plugin-system) example for a tier 2 walkthrough.
