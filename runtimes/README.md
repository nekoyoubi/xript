# xript Runtimes

Language-specific implementations of the xript runtime.

## Available Runtimes

- **js/** (`@xript/runtime-js`) — universal JavaScript runtime using QuickJS compiled to WASM for sandboxed execution (works in browser, Node, Deno, and more)
- **node/** (`@xript/runtime-node`) — Node.js-optimized runtime using the `vm` module for sandboxed execution (includes `createRuntimeFromFile` and full JSON Schema validation)

## Planned Runtimes

- **rust/** — Rust
- **go/** — Go
- **csharp/** — C# / .NET

Each runtime implements the xript specification, providing sandboxed script execution with capability-based security.
