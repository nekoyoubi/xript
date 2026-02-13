---
title: "C# Runtime"
description: C# runtime for sandboxed xript script execution via Jint.
---

The C# runtime (`Xript.Runtime`) executes user scripts inside a Jint-powered JavaScript sandbox. It provides the same manifest-driven binding model and capability enforcement as the JS/WASM, Node.js, and Rust runtimes, but as a NuGet package for .NET applications.

For applications that need to run in browsers or other JavaScript environments, use the [JS/WASM Runtime](/runtimes/js-wasm). For Node.js-only applications, see the [Node.js Runtime](/runtimes/node). For native Rust applications, see the [Rust Runtime](/runtimes/rust). For a comparison of all runtimes, see [Choosing a Runtime](/runtimes/overview).

## Installation

```bash
dotnet add package Xript.Runtime
```

## Creating a Runtime

### From a JSON String

```csharp
using Xript.Runtime;

var manifestJson = """
{
    "xript": "0.1",
    "name": "my-app",
    "bindings": {
        "greet": {
            "description": "Returns a greeting.",
            "params": [{ "name": "name", "type": "string" }]
        }
    }
}
""";

var bindings = new HostBindings();
bindings.AddFunction("greet", args =>
{
    var name = args.Length > 0 ? args[0].GetString() ?? "World" : "World";
    return JsonDocument.Parse($"\"Hello, {name}!\"").RootElement.Clone();
});

using var runtime = XriptRuntime.Create(manifestJson, new RuntimeOptions
{
    HostBindings = bindings
});
```

### From a File

```csharp
using var runtime = XriptRuntime.CreateFromFile("manifest.json", new RuntimeOptions
{
    HostBindings = new HostBindings()
});
```

### From a JsonDocument

```csharp
using var doc = JsonDocument.Parse(manifestJson);
using var runtime = XriptRuntime.CreateFromValue(doc, new RuntimeOptions
{
    HostBindings = new HostBindings()
});
```

## Options

`RuntimeOptions` has three properties:

| Property | Type | Description |
|----------|------|-------------|
| `HostBindings` | `HostBindings` | Map of binding names to host functions |
| `Capabilities` | `List<string>` | List of capabilities granted to this script |
| `Console` | `ConsoleHandler` | Console output routing (`Log`, `Warn`, `Error` callbacks) |

### Host Bindings

Host bindings map binding names to C# delegates. Each delegate receives a `JsonElement[]` of arguments and returns a `JsonElement`:

```csharp
var bindings = new HostBindings();

bindings.AddFunction("add", args =>
{
    var a = args[0].GetDouble();
    var b = args[1].GetDouble();
    return JsonDocument.Parse((a + b).ToString()).RootElement.Clone();
});
```

For namespace bindings, use `AddNamespace` with a `Dictionary<string, HostFunction>`:

```csharp
bindings.AddNamespace("player", new Dictionary<string, HostFunction>
{
    ["getName"] = _ => JsonDocument.Parse("\"Hero\"").RootElement.Clone(),
    ["getHealth"] = _ => JsonDocument.Parse("100").RootElement.Clone()
});
```

### Console Handler

Route `console.log`, `console.warn`, and `console.error` from scripts to C# callbacks:

```csharp
var console = new ConsoleHandler
{
    Log = msg => Console.WriteLine($"[LOG] {msg}"),
    Warn = msg => Console.Error.WriteLine($"[WARN] {msg}"),
    Error = msg => Console.Error.WriteLine($"[ERROR] {msg}")
};
```

The default `ConsoleHandler` silently discards all output.

## Executing Scripts

```csharp
var result = runtime.Execute("2 + 2");
// result.Value is a JsonElement with value 4
// result.DurationMs is the wall-clock execution time
```

`Execute` runs the code synchronously and returns an `ExecutionResult`:

| Property | Type | Description |
|----------|------|-------------|
| `Value` | `JsonElement` | The result of the last expression |
| `DurationMs` | `double` | Wall-clock execution time in milliseconds |

## Hooks

Register handlers in script code, then fire them from the host:

```csharp
runtime.Execute("hooks.onInit(function() { return 42; })");

var results = runtime.FireHook("onInit");
// results[0] is a JsonElement with value 42
```

For phased hooks, specify the phase:

```csharp
var results = runtime.FireHook("onTurn", new FireHookOptions { Phase = "before" });
```

Pass data to hook handlers:

```csharp
var data = JsonDocument.Parse("""{"x": 10}""").RootElement;
var results = runtime.FireHook("onInit", new FireHookOptions { Data = data });
```

## Error Types

| Exception | When |
|-----------|------|
| `ManifestValidationException` | Manifest fails structural validation (`Issues` property) |
| `BindingException` | Host function throws or is missing (`Binding` property) |
| `CapabilityDeniedException` | Calling a gated binding without the required capability |
| `ExecutionLimitException` | Script exceeds timeout, memory, or recursion limits (`Limit` property) |

## Sandbox Details

The sandbox provides a restricted JavaScript environment powered by Jint (pure C# JS interpreter):

**Available:** `Math`, `JSON`, `Date`, `Number`, `String`, `Boolean`, `Array`, `Object`, `Map`, `Set`, `RegExp`, `Symbol`, `Proxy`, `Reflect`, typed arrays, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, and standard error constructors.

**Blocked:** `eval`, `new Function`, `process`, `require`, `import`, `fetch`, `setTimeout`, `setInterval`, and all Node.js/browser-specific globals.

**Frozen namespaces:** Namespace objects are frozen with `Object.freeze`. Scripts cannot add, remove, or reassign namespace members.

**Execution limits:** The `timeout_ms` field in the manifest's `limits` section controls how long a script can run (default 5000ms). The `memory_mb` field controls maximum heap size (best-effort). The `max_stack_depth` field controls the maximum recursion depth.

## Public Types

```csharp
public sealed class XriptRuntime : IDisposable
{
    public static XriptRuntime Create(string manifestJson, RuntimeOptions? options = null);
    public static XriptRuntime CreateFromFile(string path, RuntimeOptions? options = null);
    public static XriptRuntime CreateFromValue(JsonDocument doc, RuntimeOptions? options = null);
    public Manifest Manifest { get; }
    public ExecutionResult Execute(string code);
    public JsonElement[] FireHook(string hookName, FireHookOptions? options = null);
}

public delegate JsonElement HostFunction(JsonElement[] args);
public class HostBindings { /* AddFunction, AddNamespace */ }
public class ConsoleHandler { /* Log, Warn, Error */ }
public class RuntimeOptions { /* HostBindings, Capabilities, Console */ }
public record ExecutionResult(JsonElement Value, double DurationMs);
public record FireHookOptions { /* Phase?, Data? */ }
public record Manifest { /* Xript, Name, Version, Bindings, Hooks, ... */ }
```
