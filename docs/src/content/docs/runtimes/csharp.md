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

## Loading Mods

`LoadMod` validates a mod manifest against the app manifest (checking that referenced slots exist, formats are accepted, and required capabilities are granted), sanitizes any fragment HTML, and returns a `ModInstance`.

```csharp
var modManifestJson = """
{
    "xript": "0.1",
    "name": "health-ui-mod",
    "version": "1.0.0",
    "fragments": [
        {
            "id": "health-bar",
            "slot": "hud",
            "format": "text/html",
            "inline": true,
            "source": "<div data-bind=\"health\"></div>"
        }
    ]
}
""";

var modInstance = runtime.LoadMod(modManifestJson);
Console.WriteLine($"Loaded: {modInstance.Name} v{modInstance.Version}");
foreach (var fragment in modInstance.Fragments)
    Console.WriteLine($"  [{fragment.Slot}] {fragment.Id}");
```

For fragments whose source lives in external files, pass a `Dictionary<string, string>` mapping source paths to their content:

```csharp
var sources = new Dictionary<string, string>
{
    ["hud/health-bar.html"] = "<div data-bind=\"health\"></div>"
};
var modInstance = runtime.LoadMod(modManifestJson, sources);
```

`ModInstance` exposes:

| Member | Type | Description |
|--------|------|-------------|
| `Id` | `string` | Auto-generated unique instance ID |
| `Name` | `string` | Mod name from the manifest |
| `Version` | `string` | Mod version from the manifest |
| `Fragments` | `List<FragmentInstance>` | Sanitized, ready-to-render fragments |

`FragmentInstance` exposes `Id`, `Slot`, `Format`, and `Priority`. Call `UpdateBindings(data)` on the `ModInstance` to apply live data against all fragment templates at once:

```csharp
var results = modInstance.UpdateBindings(new Dictionary<string, object?>
{
    ["health"] = 75
});
foreach (var result in results)
    Console.WriteLine($"{result.FragmentId}: {result.Html}");
```

`UpdateBindings` returns a `List<FragmentResult>`, each with `FragmentId`, `Html` (after `data-bind` substitution), and `Visibility` (a `Dictionary<string, bool>` keyed on `data-if` expressions).

`LoadMod` throws `ModManifestValidationException` if the mod manifest is invalid or fails cross-validation against the app manifest. `ModManifestValidationException` has an `Issues` property of type `IReadOnlyList<ValidationIssue>`.

## Fragment Hook Firing

Scripts register fragment lifecycle handlers using the `hooks.fragment` API; the host fires them with `FireFragmentHook`. The method returns an array of `FragmentOp` command buffer operations that describe mutations to apply to the rendered fragment.

```csharp
runtime.Execute("""
    hooks.fragment.update("health-bar", function(data, fragment) {
        fragment.setText(".value", data.health + "%");
        fragment.toggle(".critical", data.health < 20);
    });
""");

var ops = runtime.FireFragmentHook("health-bar", "update",
    new Dictionary<string, object?> { ["health"] = 75 });

foreach (var op in ops)
    Console.WriteLine($"{op.Op} {op.Selector} = {op.Value}");
```

Supported lifecycles: `mount`, `unmount`, `update`, `suspend`, `resume`.

The `bindings` parameter is optional. When provided, it is serialized and passed as the first argument to each registered handler.

`FragmentOp` has four properties:

| Property | Type | Description |
|----------|------|-------------|
| `Op` | `string` | Operation name: `toggle`, `addClass`, `removeClass`, `setText`, `setAttr`, `replaceChildren` |
| `Selector` | `string` | CSS-style target selector within the fragment |
| `Value` | `object?` | Value for the operation (text content, class name, boolean for toggle, etc.) |
| `Attr` | `string?` | Attribute name, only present for `setAttr` operations |

`FireFragmentHook` returns an empty array if no handlers are registered for the given fragment/lifecycle pair or if the sandbox call fails.

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
    public FragmentOp[] FireFragmentHook(string fragmentId, string lifecycle, Dictionary<string, object?>? bindings = null);
    public ModInstance LoadMod(string modManifestJson, Dictionary<string, string>? fragmentSources = null);
}

public delegate JsonElement HostFunction(JsonElement[] args);
public class HostBindings { /* AddFunction, AddNamespace */ }
public class ConsoleHandler { /* Log, Warn, Error */ }
public class RuntimeOptions { /* HostBindings, Capabilities, Console */ }
public record ExecutionResult(JsonElement Value, double DurationMs);
public record FireHookOptions { /* Phase?, Data? */ }
public record Manifest { /* Xript, Name, Version, Bindings, Hooks, Slots, ... */ }
public record FragmentOp(string Op, string Selector, object? Value = null, string? Attr = null);
public sealed class ModInstance { /* Id, Name, Version, Fragments, UpdateBindings() */ }
public sealed class FragmentInstance { /* Id, Slot, Format, Priority, GetContent(), GetEvents() */ }
public record FragmentResult(string FragmentId, string Html, Dictionary<string, bool> Visibility);
public class ModManifestValidationException : Exception { /* Issues */ }
```
