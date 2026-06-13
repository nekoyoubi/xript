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
    "xript": "0.7",
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

`RuntimeOptions` carries the host's configuration:

| Property | Type | Description |
|----------|------|-------------|
| `HostBindings` | `HostBindings` | Map of binding names to host functions |
| `Capabilities` | `List<string>` | List of capabilities granted to this script |
| `Console` | `ConsoleHandler` | Console output routing (`Log`, `Warn`, `Error`, plus optional `Info`/`Debug`/`Trace` and a unified `OnLog`) |
| `Cancellation` | `CancellationToken` | Cooperatively interrupts in-flight execution; surfaces an `ExecutionCancelledException` distinct from a timeout |
| `Audit` | `Action<AuditEvent>?` | Fire-and-forget hook invoked on every allowed binding call (`{ Binding, Capability, AtMs }`) |
| `HardLimits` | `ExecutionLimits?` | Host-enforced ceiling on `timeout_ms`, `memory_mb`, and `max_stack_depth` (the manifest's `limits` cannot exceed it) |
| `RolePreferences` | `IReadOnlyDictionary<string, string>` | Per-role addon preference used by `ResolveRole` (overrides first-installed-wins) |
| `Debug` | `DebugOptions?` | Enables the DAP-shaped debug session (breakpoints, stepping, scope inspection) |

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

`ConsoleHandler` also exposes optional `Info`, `Debug`, and `Trace` callbacks for finer-grained severities, and an `OnLog` callback of type `Action<LogSeverity, string>` that, when set, receives every message tagged with its `LogSeverity` (`Trace`, `Debug`, `Info`, `Warn`, `Error`). When `OnLog` is set it takes precedence over the per-severity callbacks.

The default `ConsoleHandler` silently discards all output.

### Cancellation

Pass a `CancellationToken` on `RuntimeOptions.Cancellation` to interrupt a running script cooperatively. QuickJS, rquickjs, and Jint interrupt mid-run; once the token is cancelled, the next `Execute`/`InvokeExport` (and any in-flight execution at its next check point) throws `ExecutionCancelledException`. That's a distinct exception from `ExecutionLimitException`, so a host can tell a deliberate cancel apart from a timeout. Cancellation is sticky: once the token trips, every subsequent call throws.

```csharp
using var cts = new CancellationTokenSource();
using var runtime = XriptRuntime.Create(manifestJson, new RuntimeOptions
{
    Cancellation = cts.Token
});

cts.Cancel();
// runtime.Execute("1 + 1") now throws ExecutionCancelledException
```

### Audit Channel

Set `RuntimeOptions.Audit` to observe every allowed binding invocation. The callback fires fire-and-forget with an `AuditEvent` carrying the `Binding` name, the `Capability` that gated it (`null` for ungated bindings), and `AtMs`, the elapsed wall-clock time of the call:

```csharp
var log = new List<AuditEvent>();
using var runtime = XriptRuntime.Create(manifestJson, new RuntimeOptions
{
    HostBindings = bindings,
    Audit = log.Add
});

runtime.Execute("add(2, 3)");
// log[0] == new AuditEvent("add", null, ...)
```

### Hard Limits

`RuntimeOptions.HardLimits` is a host-imposed ceiling on the manifest's `limits` section. The effective `timeout_ms`, `memory_mb`, and `max_stack_depth` are the tighter of the manifest's request and the host's `HardLimits`, so a mod author can ask for less but never more than the host allows:

```csharp
using var runtime = XriptRuntime.Create(manifestJson, new RuntimeOptions
{
    HardLimits = new ExecutionLimits { TimeoutMs = 1000, MemoryMb = 32, MaxStackDepth = 200 }
});
```

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

An overload, `Execute(string code, string source)`, tags the script with a source name so debugger breakpoints and stack frames can refer to it.

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

`LoadMod` validates a mod manifest against the app manifest (checking that referenced slots exist, formats are accepted, and required capabilities are granted), sanitizes any fragment HTML, runs the mod's entry script (registering its host-invokable exports), and returns a `ModInstance`.

:::note
As of v0.6 the canonical mod contribution surface is a single `fills` object keyed by host slot id. A fragment, a provider role, and a lifecycle-hook handler are all *fills* of a typed host slot, not separate top-level surfaces. The legacy top-level `fragments[]` array and the `contributions` object shown below still validate and load (with a deprecation warning at validation time), so existing mods keep working. See the [manifest spec](/spec/manifest) for the `fills` model.
:::

```csharp
var modManifestJson = """
{
    "xript": "0.7",
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

To resolve `extends` (inheritance) before loading, see [Manifest Inheritance](#manifest-inheritance) below. Only `CreateFromFile` resolves `extends` automatically, since the base manifests are referenced by relative file path.

## Host-Invoke Exports

A mod can declare named exports the host calls and whose return value it honors. A classic-script entry registers them with `xript.exports.register(name, fn)`; a module entry exports them as top-level named functions (see [Module-Format Mods](#module-format-mods)). The host calls `InvokeExport` with a `JsonElement[]` of arguments and gets back a `JsonElement`:

```csharp
runtime.LoadMod("""
{
    "xript": "0.7",
    "name": "transcriber",
    "version": "1.0.0",
    "entry": {
        "script": "main.js",
        "exports": { "shout": { "description": "uppercases input" } }
    }
}
""", new Dictionary<string, string>
{
    ["main.js"] = "xript.exports.register('shout', function(s) { return s.toUpperCase(); });"
});

var result = runtime.InvokeExport("shout", [
    JsonDocument.Parse("\"hello\"").RootElement.Clone()
]);
// result.GetString() == "HELLO"
```

An export entry may declare a `capability`; calling it without that capability granted throws `CapabilityDeniedException`. Invoking an unknown export, or one whose handler throws, surfaces as `InvokeException` (with the offending export name on its `Export` property).

## Provider Roles

Mods advertise logical capabilities through `contributions.provides`, mapping a role name to concrete exports. The host resolves a role to a single provider with `ResolveRole` (first-installed-wins, overridable by `RuntimeOptions.RolePreferences`) or enumerates every provider with `ResolveRoleAll` to build its own picker:

```csharp
var modJson = """
{
    "xript": "0.7",
    "name": "deepl-translator",
    "version": "1.0.0",
    "entry": {
        "script": "main.js",
        "exports": { "translate": { "description": "translates text" } }
    },
    "contributions": {
        "provides": [{ "role": "translator", "fns": { "translate": "translate" } }]
    }
}
""";
runtime.LoadMod(modJson, new Dictionary<string, string>
{
    ["main.js"] = "xript.exports.register('translate', function(text) { return text; });"
});

var provider = runtime.ResolveRole("translator");
// provider.Addon == "deepl-translator"
// provider.Fns["translate"] == "translate" (the export name to InvokeExport)
```

Declaring a role grants nothing on its own; the named exports stay gated by their own capabilities. `ResolveRole` returns `RoleResolution?` (`null` when no provider exists); `ResolveRoleAll` returns `IReadOnlyList<RoleResolution>`.

## Slot Resolution

`ResolveSlot` returns the fragment contributions for a host slot, ordered by descending `priority` (ties broken by fragment id). When the slot's manifest declaration is not `multiple`, only the top contribution is returned. `ResolveSlotSingle` returns just the winner (or `null`):

```csharp
foreach (var c in runtime.ResolveSlot("hud"))
    Console.WriteLine($"{c.ModName}: {c.FragmentId} (priority {c.Priority})");
```

Each `SlotContribution` exposes `ModName`, `FragmentId`, `Slot`, `Format`, and `Priority`.

## Module-Format Mods

Setting `entry.format` to `"module"` evaluates the mod entry as a real ES module. Top-level named function exports become host-invokable exports automatically; no `xript.exports.register` call needed:

```csharp
runtime.LoadMod("""
{
    "xript": "0.7",
    "name": "transcriber",
    "version": "1.0.0",
    "entry": { "script": "main.js", "format": "module" }
}
""", new Dictionary<string, string>
{
    ["main.js"] = "export function shout(s) { return s.toUpperCase(); }"
});

var result = runtime.InvokeExport("shout", [
    JsonDocument.Parse("\"hi\"").RootElement.Clone()
]);
```

External imports stay denied; `import x from "fs"` fails at load. CommonJS artifacts (`require(`, `module.exports`, top-level `exports.`) fail loudly with `CommonJsDetectedException` (carrying the offending `Artifact`) instead of producing an unrunnable mod, so a mis-set `tsconfig` is caught at load. The authoring canon lives in [Module-Format Mods](/spec/modules).

## Debugging

When `RuntimeOptions.Debug` is set, the runtime exposes a DAP-shaped `DebugSession` (via the `DebugSession` property) the host can drive: set and clear breakpoints by source position, pause/resume, step in/over/out, and inspect stack frames, scopes, and variables. Jint pauses synchronously on the engine thread, so a host typically drives the session from the `DebugOptions` event callbacks (`OnStopped`, `OnContinued`, `OnTerminated`, `OnBreakpointChanged`).

```csharp
using var runtime = XriptRuntime.Create(manifestJson, new RuntimeOptions
{
    Debug = new DebugOptions
    {
        StopOnEntry = true,
        OnStopped = stopped => Console.WriteLine($"stopped: {stopped.Reason}")
    }
});

var session = runtime.DebugSession!;
session.SetBreakpoints("main.js", [new SourceBreakpoint(Line: 3)]);
runtime.Execute("/* user script */", "main.js");
```

`DebugSession` exposes `SetBreakpoints`, `ClearBreakpoints`, `Pause`, `Continue`/`Resume`, `StepIn`, `StepOver`, `StepOut`, `StackTrace`, `Scopes`, `Variables`, and `Evaluate`. Its `Fidelity` is `DebugFidelity.Native`; Jint pauses on its own engine thread rather than requiring source instrumentation. See the [Debugging spec](/spec/debugging) for the cross-runtime vocabulary and per-engine fidelity notes.

## Manifest Inheritance

A manifest can `extends` one or more base manifests, resolved and deep-merged base-then-child before validation, transitively, with cycle detection. On a name that collides with the base, three moves are legal:

- **add-new** — a name the base does not declare; additive, no marker
- **fill** — redeclare an `abstract: true` base type with concrete fields or values; abstractness is the opt-in, so no marker is needed
- **refine** — redeclare a concrete base type or slot with `refines: true` to deep-merge (child wins per key, nested objects recurse, arrays and scalars replace wholesale)

Any other collision (concrete-on-concrete without `refines`, or a duplicate binding, capability, or hook) is a resolution error, so inheritance never silently clobbers. The same resolution runs at parity across all four runtimes.

In C#, `CreateFromFile` resolves `extends` automatically (base manifests are referenced by relative file path against the manifest's directory):

```csharp
using var runtime = XriptRuntime.CreateFromFile("manifest.json", new RuntimeOptions
{
    HostBindings = new HostBindings()
});
```

`ManifestResolver.Resolve(manifestJson, baseDir)` exposes the resolver directly if a host needs the merged JSON before constructing a runtime. See the [manifest spec](/spec/manifest) for the full inheritance model, including open enums and a slot's full-JSON-Schema `payload`.

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

:::note
A fragment fill's DOM event-handler array is `handlers` (entries are `{ selector, on, handler }`). The old key `events` is accepted as a deprecated alias; `handlers` wins if both are present. On a `FragmentInstance`, read them with `GetHandlers()`; `GetEvents()` is a deprecated alias. Do not confuse this fill-level array with the manifest's separate top-level `events` catalog, which declares what the host *broadcasts*. One line: bindings are what you call, slots and handlers are what handles, `events` is what the host emits.
:::

## Error Types

| Exception | When |
|-----------|------|
| `ManifestValidationException` | Manifest fails structural validation (`Issues` property) |
| `BindingException` | Host function throws or is missing (`Binding` property) |
| `CapabilityDeniedException` | Calling a gated binding (or export) without the required capability |
| `ExecutionLimitException` | Script exceeds timeout, memory, or recursion limits (`Limit` property) |
| `ExecutionCancelledException` | Execution interrupted via the `Cancellation` token |
| `InvokeException` | An export is unknown or its handler throws (`Export` property) |
| `CommonJsDetectedException` | A mod entry contains CommonJS artifacts (`Artifact` property) |
| `ImportDeniedException` | A mod entry tries to import an external module |
| `ModManifestValidationException` | A mod manifest is invalid or fails cross-validation (`Issues` property) |

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
    public DebugSession? DebugSession { get; }
    public ExecutionResult Execute(string code);
    public ExecutionResult Execute(string code, string source);
    public JsonElement[] FireHook(string hookName, FireHookOptions? options = null);
    public FragmentOp[] FireFragmentHook(string fragmentId, string lifecycle, Dictionary<string, object?>? bindings = null);
    public JsonElement InvokeExport(string name, JsonElement[] args);
    public ModInstance LoadMod(string modManifestJson, Dictionary<string, string>? fragmentSources = null);
    public RoleResolution? ResolveRole(string role);
    public IReadOnlyList<RoleResolution> ResolveRoleAll(string role);
    public SlotContribution[] ResolveSlot(string slotId);
    public SlotContribution? ResolveSlotSingle(string slotId);
}

public delegate JsonElement HostFunction(JsonElement[] args);
public class HostBindings { /* AddFunction, AddNamespace */ }
public class ConsoleHandler { /* Log, Warn, Error, Info?, Debug?, Trace?, OnLog? */ }
public class RuntimeOptions { /* HostBindings, Capabilities, Console, Cancellation, Audit, HardLimits, RolePreferences, Debug */ }
public record ExecutionResult(JsonElement Value, double DurationMs);
public record FireHookOptions { /* Phase?, Data? */ }
public record AuditEvent(string Binding, string? Capability, double AtMs);
public record ExecutionLimits { /* TimeoutMs?, MemoryMb?, MaxStackDepth? */ }
public record Manifest { /* Xript, Name, Version, Bindings, Hooks, Slots, ... */ }
public record FragmentOp(string Op, string Selector, object? Value = null, string? Attr = null);
public sealed record RoleResolution(string Addon, string Role, IReadOnlyDictionary<string, string> Fns);
public sealed record SlotContribution(string ModName, string FragmentId, string Slot, string Format, int Priority);
public sealed class ModInstance { /* Id, Name, Version, Fragments, UpdateBindings() */ }
public sealed class FragmentInstance { /* Id, Slot, Format, Priority, GetContent(), GetHandlers() */ }
public record FragmentResult(string FragmentId, string Html, Dictionary<string, bool> Visibility);
public sealed class DebugSession { /* SetBreakpoints, ClearBreakpoints, Pause, Continue, StepIn/Over/Out, StackTrace, Scopes, Variables, Evaluate */ }
public class DebugOptions { /* OnStopped?, OnContinued?, OnTerminated?, OnBreakpointChanged?, StopOnEntry */ }
public static class ManifestResolver { /* Resolve(string manifestJson, string baseDir) */ }
public class ModManifestValidationException : Exception { /* Issues */ }
```
