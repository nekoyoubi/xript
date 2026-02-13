---
title: Choosing a Runtime
description: Compare all four xript runtime implementations to find the right fit for your platform.
---

xript provides four runtime implementations that all conform to the same specification. A script written for one runtime works identically on the others — the manifest schema, capability model, and security guarantees are shared across all of them.

## Runtime Comparison

| | Universal | Node.js | Rust | C# |
|---|---|---|---|---|
| **Package** | `@xriptjs/runtime` | `@xriptjs/runtime-node` | `xript-runtime` | `Xript.Runtime` |
| **Sandbox** | QuickJS WASM | Node.js `vm` | QuickJS (native) | Jint (pure C#) |
| **Environments** | Browser, Node, Deno, Bun, Workers | Node.js only | Any Rust app | Any .NET app |
| **Manifest loading** | Pass object directly | `createRuntimeFromFile` | `create_runtime` (JSON) | `XriptRuntime.Create` (JSON) |
| **Async bindings** | Via `initXriptAsync()` | Native `async`/`await` | Not yet (sync only) | Not yet (sync only) |
| **Memory isolation** | Separate WASM heap | Shared Node.js process | Separate QuickJS heap | Jint engine per runtime |
| **Best for** | Cross-platform, browser | Node.js servers, CLI | Rust apps, game engines | Unity, Godot (.NET), enterprise |

## Shared Security Guarantees

Every runtime enforces the same security model regardless of the host language or sandbox technology:

- **No sandbox escape.** Scripts cannot access the host filesystem, network, or process. Only bindings declared in the manifest are reachable.
- **No denial of service.** Execution limits (`timeout_ms`, `memory_mb`, `max_stack_depth`) prevent runaway scripts from consuming unbounded resources.
- **No implicit trust.** Capabilities are opt-in and default to empty. A script cannot call a capability-gated binding unless the host explicitly grants that capability.
- **No eval.** `eval()`, `new Function()`, and dynamic code generation are blocked at the engine level across all four runtimes.

For the full security specification, see [Security](/spec/security).

## Manifest Compatibility

All four runtimes consume the same `xript.manifest.json` schema. A manifest written for one runtime requires zero changes to work on another — the bindings, capabilities, hooks, types, and limits are all portable.

For the manifest specification, see [Manifest](/spec/manifest).

## Quick Links

- [JS/WASM Runtime](/runtimes/js-wasm) — universal sandbox, runs anywhere JavaScript runs
- [Node.js Runtime](/runtimes/node) — optimized for Node.js with file-based manifest loading
- [Rust Runtime](/runtimes/rust) — native QuickJS sandbox for Rust host applications
- [C# Runtime](/runtimes/csharp) — Jint sandbox for .NET, Unity, and Godot applications
