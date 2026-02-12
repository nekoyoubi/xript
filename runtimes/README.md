# xript Runtimes

Language-specific implementations of the xript runtime.

## Available Runtimes

- **js/** (`@xriptjs/runtime`): universal JavaScript runtime using QuickJS compiled to WASM for sandboxed execution (works in browser, Node, Deno, and more)
- **node/** (`@xriptjs/runtime-node`): Node.js-optimized runtime using the `vm` module for sandboxed execution (includes `createRuntimeFromFile`, hooks, and improved error messages)
- **rust/** (`xript-runtime`): native Rust runtime using QuickJS via rquickjs for sandboxed execution in Rust applications
- **csharp/** (`Xript.Runtime`): C# runtime using Jint (pure C# JS interpreter) for sandboxed execution in .NET applications (Unity, Godot, enterprise)

## Planned Runtimes

- **go/**: Go

Each runtime implements the xript specification, providing sandboxed script execution with capability-based security.
