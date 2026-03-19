# Xript.Runtime

C# runtime for [xript](https://github.com/nekoyoubi/xript): sandboxed JavaScript execution via Jint, a pure C# JavaScript interpreter. No native dependencies.

[![NuGet](https://img.shields.io/nuget/v/Xript.Runtime)](https://www.nuget.org/packages/Xript.Runtime)

## Install

```sh
dotnet add package Xript.Runtime
```

## Usage

```csharp
using System.Text.Json;
using Xript.Runtime;

var manifest = """
{
    "xript": "0.1",
    "name": "my-app",
    "bindings": {
        "greet": {
            "description": "Returns a greeting.",
            "params": [{ "name": "name", "type": "string" }],
            "returns": "string"
        }
    }
}
""";

var bindings = new HostBindings();
bindings.AddFunction("greet", args =>
{
    var name = args.Length > 0 ? args[0].GetString() : "World";
    return JsonSerializer.SerializeToElement($"Hello, {name}!");
});

using var runtime = XriptRuntime.Create(manifest, new RuntimeOptions
{
    HostBindings = bindings,
    Capabilities = [],
    Console = new ConsoleHandler
    {
        Log = msg => Console.WriteLine(msg),
        Warn = msg => Console.WriteLine($"WARN: {msg}"),
        Error = msg => Console.Error.WriteLine(msg),
    },
});

var result = runtime.Execute("greet(\"World\")");
// result.Value => "Hello, World!"
// result.DurationMs => 0.1 (approx)
```

## What it does

- Runs user-provided JavaScript inside a Jint sandbox (pure C#, no native interop)
- Only functions declared in the manifest are available to scripts; everything else is blocked
- Supports capability-gated bindings, namespace bindings, hooks, and resource limits
- Fragment processing with `data-bind` and `data-if` support
- Mod loading via `LoadMod()` with cross-validation against the host manifest
- No `eval`, no `Function`, no access to the host environment

## API

### `XriptRuntime.Create(manifestJson, options?) -> XriptRuntime`

Creates a sandboxed runtime from a JSON manifest string. Validates the manifest on creation.

### `XriptRuntime.CreateFromFile(path, options?) -> XriptRuntime`

Reads a manifest JSON file from disk and creates a runtime.

### `XriptRuntime.CreateFromValue(doc, options?) -> XriptRuntime`

Creates a runtime from a `JsonDocument`.

### `runtime.Execute(code) -> ExecutionResult`

Executes JavaScript code in the sandbox. Returns `ExecutionResult { Value, DurationMs }`.

### `runtime.FireHook(name, options?) -> JsonElement[]`

Fires a hook by name, calling all registered handlers. Returns an array of handler return values.

### `runtime.LoadMod(modManifestJson, fragmentSources?) -> ModInstance`

Loads a mod manifest, cross-validates it against the host manifest, and returns a `ModInstance` with fragment sources.

### `runtime.Dispose()`

Releases sandbox resources. `XriptRuntime` implements `IDisposable`, so `using` works.

## When to use this vs other runtimes

| | `Xript.Runtime` | `xript-runtime` (Rust) | `@xriptjs/runtime` | `@xriptjs/runtime-node` |
|---|---|---|---|---|
| Language | C# | Rust | JavaScript/TypeScript | JavaScript/TypeScript |
| Runs in browser | No | No | Yes | No |
| Sandbox mechanism | Jint (pure C#) | QuickJS (native) | QuickJS WASM | Node.js `vm` module |
| Best for | .NET apps, Unity, game engines | Rust apps, native tools | Cross-platform, browser, edge | Node.js servers, CLI tools |
| Async bindings | Not yet | Not yet | Via asyncify WASM | Native `async`/`await` |

Use this package when your host application is .NET. Use `xript-runtime` for Rust hosts. Use `@xriptjs/runtime` for JavaScript environments that need universal portability. Use `@xriptjs/runtime-node` for Node.js-only applications.

## Documentation

[xript.dev](https://xript.dev): full docs, getting started guide, and live demos.

## License

MIT
