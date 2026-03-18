using System.Diagnostics;
using System.Text.Json;
using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime;

namespace Xript.Runtime;

internal sealed class Sandbox : IDisposable
{
    private readonly Engine _engine;
    private readonly Manifest _manifest;

    internal HashSet<string> GrantedCapabilities { get; }

    internal Sandbox(Manifest manifest, RuntimeOptions options)
    {
        _manifest = manifest;
        var granted = new HashSet<string>(options.Capabilities);
        GrantedCapabilities = granted;

        _engine = new Engine(cfg =>
        {
            var limits = manifest.Limits;
            var timeoutMs = limits?.TimeoutMs ?? 5000;
            cfg.TimeoutInterval(TimeSpan.FromMilliseconds(timeoutMs));

            if (limits?.MemoryMb is > 0)
                cfg.LimitMemory(limits.MemoryMb.Value * 1024 * 1024);

            if (limits?.MaxStackDepth is > 0)
                cfg.LimitRecursion(limits.MaxStackDepth.Value);

            cfg.Strict();
        });

        RemoveDangerousGlobals();
        RegisterConsole(options.Console);
        RegisterBindings(options.HostBindings, granted);
        RegisterFragmentHooks();
        RegisterHooks(granted);
    }

    internal ExecutionResult Execute(string code)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var jsValue = _engine.Evaluate(code);
            sw.Stop();
            return new ExecutionResult(JsValueToJsonElement(jsValue), sw.Elapsed.TotalMilliseconds);
        }
        catch (TimeoutException)
        {
            throw new ExecutionLimitException("timeout_ms");
        }
        catch (MemoryLimitExceededException)
        {
            throw new ExecutionLimitException("memory_mb");
        }
        catch (RecursionDepthOverflowException)
        {
            throw new ExecutionLimitException("max_stack_depth");
        }
    }

    internal JsonElement[] FireHook(string hookName, FireHookOptions? options = null)
    {
        var hookDef = _manifest.Hooks?.GetValueOrDefault(hookName);
        if (hookDef is null) return [];

        if (options?.Phase is { } phase && hookDef.Phases?.Contains(phase) != true)
            return [];

        var registryKey = options?.Phase is { } p ? $"{hookName}:{p}" : hookName;

        try
        {
            JsValue dataArg = JsValue.Undefined;
            if (options?.Data is { } data)
                dataArg = JsonElementToJsValue(data);

            var result = _engine.Invoke("__xript_fire_handlers", registryKey, dataArg);

            if (result is not ObjectInstance arrObj)
                return [];

            var lengthVal = arrObj.Get("length");
            var length = (int)lengthVal.AsNumber();

            var results = new JsonElement[length];
            for (var i = 0; i < length; i++)
                results[i] = JsValueToJsonElement(arrObj.Get(i.ToString()));

            return results;
        }
        catch
        {
            return [];
        }
    }

    internal FragmentOp[] FireFragmentHook(
        string fragmentId, string lifecycle, Dictionary<string, object?>? bindings = null)
    {
        try
        {
            var key = $"fragment:{lifecycle}:{fragmentId}";

            JsValue dataArg = JsValue.Undefined;
            if (bindings is not null)
            {
                var json = System.Text.Json.JsonSerializer.Serialize(bindings);
                dataArg = _engine.Evaluate($"JSON.parse({System.Text.Json.JsonSerializer.Serialize(json)})");
            }

            var result = _engine.Invoke("__xript_fire_fragment_handlers", key, dataArg);

            if (result is not ObjectInstance arrObj)
                return [];

            var lengthVal = arrObj.Get("length");
            var length = (int)lengthVal.AsNumber();

            var ops = new List<FragmentOp>();
            for (var i = 0; i < length; i++)
            {
                var item = arrObj.Get(i.ToString());
                if (item is ObjectInstance opObj)
                {
                    var op = opObj.Get("op").AsString();
                    var selector = opObj.Get("selector").AsString();
                    var value = opObj.HasProperty("value") ? (object?)opObj.Get("value").ToString() : null;
                    var attr = opObj.HasProperty("attr") && !opObj.Get("attr").IsUndefined()
                        ? opObj.Get("attr").AsString()
                        : null;
                    ops.Add(new FragmentOp(op, selector, value, attr));
                }
            }

            return [.. ops];
        }
        catch
        {
            return [];
        }
    }

    public void Dispose()
    {
        _engine.Dispose();
    }

    private void RegisterFragmentHooks()
    {
        _engine.Execute("""
            globalThis.__xript_fragment_handlers = {};
            globalThis.__xript_register_fragment_handler = function(key, handler) {
                if (!globalThis.__xript_fragment_handlers[key]) {
                    globalThis.__xript_fragment_handlers[key] = [];
                }
                globalThis.__xript_fragment_handlers[key].push(handler);
            };
            globalThis.__xript_fire_fragment_handlers = function(key, data) {
                var handlers = globalThis.__xript_fragment_handlers[key];
                if (!handlers || handlers.length === 0) return [];
                var allOps = [];
                for (var i = 0; i < handlers.length; i++) {
                    try {
                        var ops = [];
                        var proxy = {
                            toggle: function(selector, condition) { ops.push({ op: "toggle", selector: selector, value: condition }); },
                            addClass: function(selector, className) { ops.push({ op: "addClass", selector: selector, value: className }); },
                            removeClass: function(selector, className) { ops.push({ op: "removeClass", selector: selector, value: className }); },
                            setText: function(selector, text) { ops.push({ op: "setText", selector: selector, value: text }); },
                            setAttr: function(selector, attr, value) { ops.push({ op: "setAttr", selector: selector, attr: attr, value: value }); },
                            replaceChildren: function(selector, html) { ops.push({ op: "replaceChildren", selector: selector, value: html }); }
                        };
                        handlers[i](data, proxy);
                        for (var j = 0; j < ops.length; j++) { allOps.push(ops[j]); }
                    } catch(e) {}
                }
                return allOps;
            };
            globalThis.hooks = {};
            globalThis.hooks.fragment = {
                mount: function(fragmentId, handler) {
                    globalThis.__xript_register_fragment_handler('fragment:mount:' + fragmentId, handler);
                },
                unmount: function(fragmentId, handler) {
                    globalThis.__xript_register_fragment_handler('fragment:unmount:' + fragmentId, handler);
                },
                update: function(fragmentId, handler) {
                    globalThis.__xript_register_fragment_handler('fragment:update:' + fragmentId, handler);
                },
                suspend: function(fragmentId, handler) {
                    globalThis.__xript_register_fragment_handler('fragment:suspend:' + fragmentId, handler);
                },
                resume: function(fragmentId, handler) {
                    globalThis.__xript_register_fragment_handler('fragment:resume:' + fragmentId, handler);
                }
            };
            Object.freeze(globalThis.hooks.fragment);
            """);
    }

    private void RemoveDangerousGlobals()
    {
        _engine.Execute("""
            delete globalThis.eval;
            if (typeof globalThis.Function !== 'undefined') {
                Object.defineProperty(globalThis, 'Function', {
                    get: function() { throw new Error("Function constructor is not permitted. Dynamic code generation is disabled in xript."); },
                    configurable: false
                });
            }
            """);
    }

    private void RegisterConsole(ConsoleHandler console)
    {
        _engine.SetValue("__xript_console_log", new Action<string>(msg => console.Log(msg)));
        _engine.SetValue("__xript_console_warn", new Action<string>(msg => console.Warn(msg)));
        _engine.SetValue("__xript_console_error", new Action<string>(msg => console.Error(msg)));

        _engine.Execute("""
            var console = (function(log, warn, error) {
                return {
                    log: function() { log(Array.prototype.slice.call(arguments).map(String).join(' ')); },
                    warn: function() { warn(Array.prototype.slice.call(arguments).map(String).join(' ')); },
                    error: function() { error(Array.prototype.slice.call(arguments).map(String).join(' ')); }
                };
            })(__xript_console_log, __xript_console_warn, __xript_console_error);
            Object.freeze(console);
            delete globalThis.__xript_console_log;
            delete globalThis.__xript_console_warn;
            delete globalThis.__xript_console_error;
            """);
    }

    private void RegisterBindings(HostBindings hostBindings, HashSet<string> granted)
    {
        if (_manifest.Bindings is null) return;

        foreach (var (name, bindingElement) in _manifest.Bindings)
        {
            if (IsNamespace(bindingElement))
                RegisterNamespaceBinding(name, bindingElement, hostBindings, granted);
            else
                RegisterFunctionBinding(name, bindingElement, hostBindings, granted);
        }
    }

    private static bool IsNamespace(JsonElement element)
    {
        return element.ValueKind == JsonValueKind.Object &&
               element.TryGetProperty("members", out _);
    }

    private void RegisterFunctionBinding(
        string name, JsonElement def, HostBindings hostBindings, HashSet<string> granted)
    {
        if (TryGetCapability(def, out var capability) && !granted.Contains(capability))
        {
            var msg = $"{name}() requires the \"{capability}\" capability, which hasn't been granted to this script";
            RegisterThrowingFunction(name, msg);
            return;
        }

        var hostFn = hostBindings.GetFunction(name);
        if (hostFn is null)
        {
            RegisterThrowingFunction(name, $"host binding '{name}' is not provided");
            return;
        }

        RegisterBridgedFunction(name, name, hostFn);
    }

    private void RegisterNamespaceBinding(
        string name, JsonElement def, HostBindings hostBindings, HashSet<string> granted)
    {
        _engine.Execute($"globalThis['{EscapeJs(name)}'] = {{}};");

        var hostNs = hostBindings.GetNamespace(name);
        var members = def.GetProperty("members");

        foreach (var member in members.EnumerateObject())
        {
            var memberName = member.Name;
            var fullName = $"{name}.{memberName}";
            var memberDef = member.Value;

            if (TryGetCapability(memberDef, out var capability) && !granted.Contains(capability))
            {
                var msg = $"{fullName}() requires the \"{capability}\" capability, which hasn't been granted to this script";
                _engine.Execute(
                    $"globalThis['{EscapeJs(name)}']['{EscapeJs(memberName)}'] = function() {{ throw new Error(\"{EscapeJsDoubleQuote(msg)}\"); }};");
                continue;
            }

            HostFunction? hostFn = null;
            hostNs?.TryGetValue(memberName, out hostFn);

            if (hostFn is null)
            {
                var msg = $"host binding '{fullName}' is not provided";
                _engine.Execute(
                    $"globalThis['{EscapeJs(name)}']['{EscapeJs(memberName)}'] = function() {{ throw new Error(\"{EscapeJsDoubleQuote(msg)}\"); }};");
                continue;
            }

            var bridgeName = $"__xript_bridge_{name}_{memberName}";
            _engine.SetValue(bridgeName, CreateBridge(hostFn));
            _engine.Execute(
                $"globalThis['{EscapeJs(name)}']['{EscapeJs(memberName)}'] = (function(bridge) {{ return function() {{ var args = Array.prototype.slice.call(arguments); var raw = bridge(JSON.stringify(args)); var envelope = JSON.parse(raw); if (envelope.__xript_err !== undefined) throw new Error(envelope.__xript_err); return envelope.__xript_ok; }}; }})({bridgeName}); delete globalThis.{bridgeName};");
        }

        _engine.Execute($"Object.freeze(globalThis['{EscapeJs(name)}']);");
    }

    private void RegisterBridgedFunction(string globalPath, string displayName, HostFunction hostFn)
    {
        var bridgeName = $"__xript_bridge_{displayName.Replace(".", "_")}";
        _engine.SetValue(bridgeName, CreateBridge(hostFn));
        _engine.Execute(
            $"globalThis['{EscapeJs(globalPath)}'] = (function(bridge) {{ return function() {{ var args = Array.prototype.slice.call(arguments); var raw = bridge(JSON.stringify(args)); var envelope = JSON.parse(raw); if (envelope.__xript_err !== undefined) throw new Error(envelope.__xript_err); return envelope.__xript_ok; }}; }})({bridgeName}); delete globalThis.{bridgeName};");
    }

    private static Func<string, string> CreateBridge(HostFunction hostFn)
    {
        return argsJson =>
        {
            JsonElement[] args;
            try
            {
                args = JsonSerializer.Deserialize<JsonElement[]>(argsJson) ?? [];
            }
            catch
            {
                return JsonSerializer.Serialize(new { __xript_err = "invalid arguments" });
            }

            try
            {
                var result = hostFn(args);
                var raw = result.GetRawText();
                return $"{{\"__xript_ok\":{raw}}}";
            }
            catch (Exception ex)
            {
                return JsonSerializer.Serialize(new { __xript_err = ex.Message });
            }
        };
    }

    private void RegisterThrowingFunction(string name, string message)
    {
        _engine.Execute(
            $"globalThis['{EscapeJs(name)}'] = function() {{ throw new Error(\"{EscapeJsDoubleQuote(message)}\"); }};");
    }

    private void RegisterHooks(HashSet<string> granted)
    {
        if (_manifest.Hooks is null || _manifest.Hooks.Count == 0) return;

        _engine.Execute("""
            globalThis.__xript_hook_handlers = {};
            globalThis.__xript_register_handler = function(key, handler) {
                if (!globalThis.__xript_hook_handlers[key]) {
                    globalThis.__xript_hook_handlers[key] = [];
                }
                globalThis.__xript_hook_handlers[key].push(handler);
            };
            globalThis.__xript_fire_handlers = function(key, data) {
                var handlers = globalThis.__xript_hook_handlers[key];
                if (!handlers || handlers.length === 0) return [];
                var args;
                if (data === undefined) {
                    args = [];
                } else if (typeof data === "object" && data !== null && !Array.isArray(data)) {
                    args = Object.values(data);
                } else {
                    args = [data];
                }
                var results = [];
                for (var i = 0; i < handlers.length; i++) {
                    try {
                        results.push(handlers[i].apply(null, args));
                    } catch(e) {
                        results.push(undefined);
                    }
                }
                return results;
            };
            """);

        _engine.Execute("if (typeof globalThis.hooks === 'undefined') { globalThis.hooks = {}; }");

        foreach (var (hookName, hookDef) in _manifest.Hooks)
        {
            if (hookDef.Phases is { Count: > 0 } phases)
            {
                _engine.Execute($"globalThis.hooks['{EscapeJs(hookName)}'] = {{}};");
                foreach (var phase in phases)
                {
                    if (hookDef.Capability is { } cap && !granted.Contains(cap))
                    {
                        _engine.Execute(
                            $"globalThis.hooks['{EscapeJs(hookName)}']['{EscapeJs(phase)}'] = function() {{ throw new Error(\"{EscapeJs(hookName)}.{EscapeJs(phase)}() requires the \\\"{EscapeJs(cap)}\\\" capability\"); }};");
                    }
                    else
                    {
                        _engine.Execute(
                            $"globalThis.hooks['{EscapeJs(hookName)}']['{EscapeJs(phase)}'] = function(handler) {{ globalThis.__xript_register_handler('{EscapeJs(hookName)}:{EscapeJs(phase)}', handler); }};");
                    }
                }
            }
            else
            {
                if (hookDef.Capability is { } cap && !granted.Contains(cap))
                {
                    _engine.Execute(
                        $"globalThis.hooks['{EscapeJs(hookName)}'] = function() {{ throw new Error(\"{EscapeJs(hookName)}() requires the \\\"{EscapeJs(cap)}\\\" capability\"); }};");
                }
                else
                {
                    _engine.Execute(
                        $"globalThis.hooks['{EscapeJs(hookName)}'] = function(handler) {{ globalThis.__xript_register_handler('{EscapeJs(hookName)}', handler); }};");
                }
            }
        }

        _engine.Execute("Object.freeze(globalThis.hooks);");

        var hookNsNames = _manifest.Hooks
            .Where(kv => kv.Value.Phases is { Count: > 0 })
            .Select(kv => kv.Key);
        foreach (var nsName in hookNsNames)
            _engine.Execute($"Object.freeze(globalThis.hooks['{EscapeJs(nsName)}']);");
    }

    private static bool TryGetCapability(JsonElement def, out string capability)
    {
        capability = "";
        if (def.ValueKind == JsonValueKind.Object && def.TryGetProperty("capability", out var cap))
        {
            if (cap.ValueKind == JsonValueKind.String)
            {
                capability = cap.GetString()!;
                return true;
            }
        }
        return false;
    }

    private static string EscapeJs(string s) =>
        s.Replace("\\", "\\\\").Replace("'", "\\'");

    private static string EscapeJsDoubleQuote(string s) =>
        s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private JsonElement JsValueToJsonElement(JsValue value)
    {
        if (value.IsUndefined() || value.IsNull())
            return JsonDocument.Parse("null").RootElement.Clone();

        if (value.IsBoolean())
            return JsonDocument.Parse(value.AsBoolean() ? "true" : "false").RootElement.Clone();

        if (value.IsNumber())
        {
            var num = value.AsNumber();
            if (double.IsNaN(num) || double.IsInfinity(num))
                return JsonDocument.Parse("null").RootElement.Clone();
            if (num == Math.Floor(num) && Math.Abs(num) < long.MaxValue)
                return JsonDocument.Parse(((long)num).ToString()).RootElement.Clone();
            return JsonDocument.Parse(num.ToString("R")).RootElement.Clone();
        }

        if (value.IsString())
        {
            var jsonStr = JsonSerializer.Serialize(value.AsString());
            return JsonDocument.Parse(jsonStr).RootElement.Clone();
        }

        try
        {
            _engine.SetValue("__xript_tmp_val", value);
            var jsonResult = _engine.Evaluate("JSON.stringify(__xript_tmp_val)");
            _engine.Execute("delete globalThis.__xript_tmp_val;");
            if (jsonResult.IsString())
            {
                var json = jsonResult.AsString();
                if (!string.IsNullOrEmpty(json))
                    return JsonDocument.Parse(json).RootElement.Clone();
            }
        }
        catch { }

        return JsonDocument.Parse("null").RootElement.Clone();
    }

    private JsValue JsonElementToJsValue(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Null => JsValue.Null,
            JsonValueKind.Undefined => JsValue.Undefined,
            JsonValueKind.True => JsBoolean.True,
            JsonValueKind.False => JsBoolean.False,
            JsonValueKind.Number when element.TryGetInt64(out var l) => new JsNumber(l),
            JsonValueKind.Number => new JsNumber(element.GetDouble()),
            JsonValueKind.String => new JsString(element.GetString()!),
            JsonValueKind.Object or JsonValueKind.Array => ParseComplexJson(element),
            _ => JsValue.Undefined,
        };
    }

    private JsValue ParseComplexJson(JsonElement element)
    {
        var json = element.GetRawText();
        var escaped = json.Replace("\\", "\\\\").Replace("`", "\\`").Replace("$", "\\$");
        try
        {
            return _engine.Evaluate($"JSON.parse(`{escaped}`)");
        }
        catch
        {
            return JsValue.Null;
        }
    }
}
