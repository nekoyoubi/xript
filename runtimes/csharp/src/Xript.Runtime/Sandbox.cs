using System.Diagnostics;
using System.Text.Json;
using Jint;
using Jint.Native;
using Jint.Native.Function;
using Jint.Native.Object;
using Jint.Runtime;
using Jint.Runtime.Modules;

namespace Xript.Runtime;

internal sealed class Sandbox : IDisposable
{
    private readonly Engine _engine;
    private readonly Manifest _manifest;
    private readonly CancellationToken _cancellation;
    private readonly DenyExternalModuleLoader _moduleLoader = new();
    private readonly IReadOnlyDictionary<string, string> _libraries;
    private readonly HashSet<string> _registeredLibraryModules = [];
    private int _moduleCounter;
    private static readonly DateTime EpochStart =
        new(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    internal HashSet<string> GrantedCapabilities { get; }

    internal DebugSession? DebugSession { get; }

    internal Sandbox(Manifest manifest, RuntimeOptions options)
    {
        _manifest = manifest;
        _cancellation = options.Cancellation;
        var granted = new HashSet<string>(options.Capabilities);
        GrantedCapabilities = granted;

        foreach (var (specifier, source) in options.Libraries)
        {
            if (manifest.Libraries?.ContainsKey(specifier) != true)
                throw new LibraryRegistrationException(specifier, "not declared in the host manifest's libraries map");
            if (CommonJsDetector.Detect(source) is { } artifact)
                throw new LibraryRegistrationException(specifier, $"CommonJS artifacts detected (found: {artifact}); libraries must be pre-bundled ES modules");
            if (ImportScanner.FirstSpecifier(source) is { } nested)
                throw new LibraryRegistrationException(specifier, $"not import-clean: contains an import of \"{nested}\"; libraries must be self-contained pre-bundled ES modules with no imports of their own");
        }
        _libraries = options.Libraries;

        var effective = ResolveEffectiveLimits(manifest.Limits, options.HardLimits);

        var debugEnabled = options.Debug is not null;

        _engine = new Engine(cfg =>
        {
            if (!debugEnabled)
            {
                var timeoutMs = effective.TimeoutMs ?? 5000;
                cfg.TimeoutInterval(TimeSpan.FromMilliseconds(timeoutMs));
            }

            if (effective.MemoryMb is > 0)
                cfg.LimitMemory(effective.MemoryMb.Value * 1024 * 1024);

            if (effective.MaxStackDepth is > 0)
                cfg.LimitRecursion(effective.MaxStackDepth.Value);

            if (options.Cancellation.CanBeCanceled)
                cfg.CancellationToken(options.Cancellation);

            if (debugEnabled)
            {
                cfg.DebugMode(true);
                cfg.Debugger.InitialStepMode =
                    options.Debug!.StopOnEntry ? Jint.Runtime.Debugger.StepMode.Into : Jint.Runtime.Debugger.StepMode.None;
            }

            cfg.Modules.ModuleLoader = _moduleLoader;

            cfg.Strict();
        });

        RemoveDangerousGlobals();
        RegisterConsole(options.Console);
        RegisterBindings(options.HostBindings, granted, options.Audit);
        RegisterFragmentHooks();
        RegisterHooks(granted);
        RegisterEvents(granted);
        RegisterExportRegistry();

        if (debugEnabled)
            DebugSession = new DebugSession(_engine, options.Debug!);
    }

    private static ExecutionLimits ResolveEffectiveLimits(ExecutionLimits? manifest, ExecutionLimits? hard)
    {
        if (hard is null)
            return manifest ?? new ExecutionLimits();

        return new ExecutionLimits
        {
            TimeoutMs = ClampOpt(manifest?.TimeoutMs, hard.TimeoutMs),
            MemoryMb = ClampOpt(manifest?.MemoryMb, hard.MemoryMb),
            MaxStackDepth = ClampOptInt(manifest?.MaxStackDepth, hard.MaxStackDepth),
        };
    }

    private static long? ClampOpt(long? requested, long? cap)
    {
        if (cap is null) return requested;
        if (requested is null) return cap;
        return Math.Min(requested.Value, cap.Value);
    }

    private static int? ClampOptInt(int? requested, int? cap)
    {
        if (cap is null) return requested;
        if (requested is null) return cap;
        return Math.Min(requested.Value, cap.Value);
    }

    internal ExecutionResult Execute(string code, string? source = null)
    {
        if (_cancellation.IsCancellationRequested)
            throw new ExecutionCancelledException();

        var sw = Stopwatch.StartNew();
        try
        {
            var jsValue = source is null ? _engine.Evaluate(code) : _engine.Evaluate(code, source);
            sw.Stop();
            DebugSession?.NotifyTerminated();
            return new ExecutionResult(JsValueToJsonElement(jsValue), sw.Elapsed.TotalMilliseconds);
        }
        catch (ExecutionCanceledException)
        {
            throw new ExecutionCancelledException();
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

    private void ApproveLibraryImport(string specifier)
    {
        if (_manifest.Libraries?.TryGetValue(specifier, out var declaration) != true || declaration is null)
            throw new ImportDeniedException(specifier);
        if (declaration.Capability is { } cap && !Capabilities.GrantedSatisfies(GrantedCapabilities, cap))
            throw new CapabilityDeniedException(specifier, cap);
        if (!_libraries.ContainsKey(specifier))
            throw new LibraryUnavailableException(specifier);
    }

    internal void EvaluateModule(string source, string modName)
    {
        if (_cancellation.IsCancellationRequested)
            throw new ExecutionCancelledException();

        var allowedLibraries = new List<string>();
        foreach (var import in ImportScanner.FindAll(source))
        {
            if (import.Dynamic)
                throw new ImportDeniedException(import.Specifier);
            ApproveLibraryImport(import.Specifier);
            if (_registeredLibraryModules.Add(import.Specifier))
                _engine.Modules.Add(import.Specifier, _libraries[import.Specifier]);
            allowedLibraries.Add(import.Specifier);
            _moduleLoader.Allow(import.Specifier);
        }

        var specifier = $"__xript_mod_{_moduleCounter++}";
        _moduleLoader.Allow(specifier);

        try
        {
            _engine.Modules.Add(specifier, source);

            ObjectInstance ns;
            try
            {
                ns = _engine.Modules.Import(specifier);
            }
            catch (ImportDeniedException)
            {
                throw;
            }
            catch (JavaScriptException ex)
            {
                if (FindImportDenied(ex) is { } denied)
                    throw denied;
                throw new ModEntryException(modName, ex.Message);
            }
            catch (ExecutionCanceledException)
            {
                throw new ExecutionCancelledException();
            }
            catch (TimeoutException)
            {
                throw new ExecutionLimitException("timeout_ms");
            }
            catch (Exception ex)
            {
                if (FindImportDenied(ex) is { } denied)
                    throw denied;
                throw new ModEntryException(modName, ex.Message);
            }

            HarvestModuleExports(ns);
        }
        finally
        {
            _moduleLoader.Disallow(specifier);
            foreach (var library in allowedLibraries)
                _moduleLoader.Disallow(library);
        }
    }

    private void HarvestModuleExports(ObjectInstance ns)
    {
        foreach (var key in ns.GetOwnPropertyKeys())
        {
            if (key.IsSymbol())
                continue;

            var name = key.ToString();
            if (name == "default")
                continue;

            var value = ns.Get(key);
            if (value is Function)
                _engine.SetValue("__xript_harvest_tmp", value);
            else
                continue;

            var escaped = JsonSerializer.Serialize(name);
            _engine.Execute(
                $"if (!Object.prototype.hasOwnProperty.call(globalThis.__xript_exports, {escaped})) {{ globalThis.__xript_exports[{escaped}] = __xript_harvest_tmp; }}");
            _engine.Execute("delete globalThis.__xript_harvest_tmp;");
        }
    }

    private static ImportDeniedException? FindImportDenied(Exception ex)
    {
        var current = ex;
        while (current is not null)
        {
            if (current is ImportDeniedException denied)
                return denied;
            current = current.InnerException;
        }
        return null;
    }

    internal JsonElement[] FireHook(string hookName, FireHookOptions? options = null)
    {
        var hookDef = _manifest.EffectiveHooks().GetValueOrDefault(hookName);
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

    internal JsonElement[] Emit(string eventId, FireHookOptions? options = null)
    {
        var eventDef = _manifest.Events?.FirstOrDefault(e => e.Id == eventId);
        if (eventDef is null) return [];

        try
        {
            JsValue dataArg = JsValue.Undefined;
            if (options?.Data is { } data)
                dataArg = JsonElementToJsValue(data);

            var result = _engine.Invoke("__xript_fire_events", eventId, dataArg);

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

    internal JsonElement InvokeExport(string name, JsonElement[] args)
    {
        if (_cancellation.IsCancellationRequested)
            throw new ExecutionCancelledException();

        bool registered;
        try
        {
            registered = _engine.Evaluate(
                $"Object.prototype.hasOwnProperty.call(globalThis.__xript_exports, {JsonSerializer.Serialize(name)})")
                .AsBoolean();
        }
        catch
        {
            registered = false;
        }

        if (!registered)
            throw new InvokeException(name, $"export '{name}' not found");

        var argsJson = JsonSerializer.Serialize(args.Select(a => (object)a).ToArray());
        var escaped = argsJson.Replace("\\", "\\\\").Replace("`", "\\`").Replace("$", "\\$");

        JsValue result;
        try
        {
            result = _engine.Evaluate($"__xript_invoke_export({JsonSerializer.Serialize(name)}, `{escaped}`)");
        }
        catch (ExecutionCanceledException)
        {
            throw new ExecutionCancelledException();
        }
        catch (TimeoutException)
        {
            throw new ExecutionLimitException("timeout_ms");
        }

        if (result is ObjectInstance envelope && envelope.HasProperty("__xript_err"))
        {
            var errVal = envelope.Get("__xript_err");
            var message = errVal.IsString() ? errVal.AsString() : errVal.ToString();
            throw new InvokeException(name, message);
        }

        if (result is ObjectInstance okEnvelope && okEnvelope.HasProperty("__xript_ok"))
            return JsValueToJsonElement(okEnvelope.Get("__xript_ok"));

        return JsValueToJsonElement(result);
    }

    public void Dispose()
    {
        _engine.Dispose();
    }

    private void RegisterExportRegistry()
    {
        _engine.Execute("""
            globalThis.__xript_exports = {};
            globalThis.xript = globalThis.xript || {};
            globalThis.xript.exports = {
                register: function(name, fn) {
                    if (typeof name !== 'string' || name.length === 0) {
                        throw new Error('xript.exports.register requires a non-empty string name');
                    }
                    if (typeof fn !== 'function') {
                        throw new Error('xript.exports.register requires a function');
                    }
                    globalThis.__xript_exports[name] = fn;
                }
            };
            Object.freeze(globalThis.xript.exports);
            globalThis.__xript_invoke_export = function(name, argsJson) {
                var fn = globalThis.__xript_exports[name];
                if (typeof fn !== 'function') {
                    return { __xript_err: "export '" + name + "' not found" };
                }
                try {
                    var args = JSON.parse(argsJson);
                    var result = fn.apply(null, args);
                    return { __xript_ok: result === undefined ? null : result };
                } catch (e) {
                    return { __xript_err: (e && e.message) ? e.message : String(e) };
                }
            };
            """);
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
            globalThis.__xript_deep_freeze = function(obj) {
                if (obj === null || typeof obj !== 'object') return obj;
                Object.getOwnPropertyNames(obj).forEach(function(key) {
                    var val = obj[key];
                    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
                        globalThis.__xript_deep_freeze(val);
                    }
                });
                return Object.freeze(obj);
            };
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
        _engine.SetValue("__xript_console_trace", new Action<string>(msg => console.Dispatch(LogSeverity.Trace, msg)));
        _engine.SetValue("__xript_console_debug", new Action<string>(msg => console.Dispatch(LogSeverity.Debug, msg)));
        _engine.SetValue("__xript_console_info", new Action<string>(msg => console.Dispatch(LogSeverity.Info, msg)));
        _engine.SetValue("__xript_console_warn", new Action<string>(msg => console.Dispatch(LogSeverity.Warn, msg)));
        _engine.SetValue("__xript_console_error", new Action<string>(msg => console.Dispatch(LogSeverity.Error, msg)));

        _engine.Execute("""
            var console = (function(trace, debug, info, warn, error) {
                var fmt = function(args) { return Array.prototype.slice.call(args).map(String).join(' '); };
                return {
                    trace: function() { trace(fmt(arguments)); },
                    debug: function() { debug(fmt(arguments)); },
                    log: function() { info(fmt(arguments)); },
                    info: function() { info(fmt(arguments)); },
                    warn: function() { warn(fmt(arguments)); },
                    error: function() { error(fmt(arguments)); }
                };
            })(__xript_console_trace, __xript_console_debug, __xript_console_info, __xript_console_warn, __xript_console_error);
            Object.freeze(console);
            delete globalThis.__xript_console_trace;
            delete globalThis.__xript_console_debug;
            delete globalThis.__xript_console_info;
            delete globalThis.__xript_console_warn;
            delete globalThis.__xript_console_error;
            """);
    }

    private int _bridgeCounter;

    private void RegisterBindings(HostBindings hostBindings, HashSet<string> granted, Action<AuditEvent>? audit)
    {
        if (_manifest.Bindings is null) return;

        foreach (var (name, bindingElement) in _manifest.Bindings)
        {
            if (IsNamespace(bindingElement))
                RegisterNamespaceBinding(name, bindingElement, hostBindings, granted, audit);
            else
                RegisterFunctionBinding(name, bindingElement, hostBindings, granted, audit);
        }
    }

    private static bool IsNamespace(JsonElement element)
    {
        return element.ValueKind == JsonValueKind.Object &&
               element.TryGetProperty("members", out _);
    }

    private void RegisterFunctionBinding(
        string name, JsonElement def, HostBindings hostBindings, HashSet<string> granted, Action<AuditEvent>? audit)
    {
        var target = $"globalThis['{EscapeJs(name)}']";

        if (TryGetCapability(def, out var capability) && !Capabilities.GrantedSatisfies(granted, capability))
        {
            var msg = $"{name}() requires the \"{capability}\" capability, which hasn't been granted to this script";
            AssignThrowingFunction(target, msg);
            return;
        }

        var hostFn = hostBindings.GetFunction(name);
        if (hostFn is null)
        {
            AssignThrowingFunction(target, $"host binding '{name}' is not provided");
            return;
        }

        var declaredCapability = TryGetCapability(def, out var cap) ? cap : null;
        AssignBridgedFunction(target, hostFn, name, declaredCapability, audit);
    }

    private void RegisterNamespaceBinding(
        string name, JsonElement def, HostBindings hostBindings, HashSet<string> granted, Action<AuditEvent>? audit)
    {
        var rootTarget = $"globalThis['{EscapeJs(name)}']";
        _engine.Execute($"{rootTarget} = {{}};");

        var hostNs = hostBindings.GetNestedNamespace(name);
        var members = def.GetProperty("members");

        RegisterNamespaceMembers(rootTarget, name, members, hostNs, granted, audit);

        _engine.Execute($"__xript_deep_freeze({rootTarget});");
    }

    private void RegisterNamespaceMembers(
        string target,
        string qualifiedPrefix,
        JsonElement members,
        Dictionary<string, HostNamespaceMember>? hostNs,
        HashSet<string> granted,
        Action<AuditEvent>? audit)
    {
        foreach (var member in members.EnumerateObject())
        {
            var memberName = member.Name;
            var qualifiedName = $"{qualifiedPrefix}.{memberName}";
            var memberDef = member.Value;
            var memberTarget = $"{target}['{EscapeJs(memberName)}']";

            HostNamespaceMember? hostMember = null;
            hostNs?.TryGetValue(memberName, out hostMember);

            if (IsNamespace(memberDef))
            {
                _engine.Execute($"{memberTarget} = {{}};");
                var childHostNs = hostMember?.Namespace;
                RegisterNamespaceMembers(
                    memberTarget, qualifiedName, memberDef.GetProperty("members"), childHostNs, granted, audit);
                continue;
            }

            if (TryGetCapability(memberDef, out var capability) && !Capabilities.GrantedSatisfies(granted, capability))
            {
                var msg = $"{qualifiedName}() requires the \"{capability}\" capability, which hasn't been granted to this script";
                AssignThrowingFunction(memberTarget, msg);
                continue;
            }

            if (hostMember?.Property is { } prop)
            {
                var raw = prop.GetRawText();
                var escaped = raw.Replace("\\", "\\\\").Replace("`", "\\`").Replace("$", "\\$");
                _engine.Execute($"{memberTarget} = JSON.parse(`{escaped}`);");
                continue;
            }

            var hostFn = hostMember?.Function;
            if (hostFn is null)
            {
                AssignThrowingFunction(memberTarget, $"host binding '{qualifiedName}' is not provided");
                continue;
            }

            var declaredCapability = TryGetCapability(memberDef, out var cap) ? cap : null;
            AssignBridgedFunction(memberTarget, hostFn, qualifiedName, declaredCapability, audit);
        }
    }

    private void AssignBridgedFunction(
        string targetExpr, HostFunction hostFn, string binding, string? capability, Action<AuditEvent>? audit)
    {
        var bridgeName = $"__xript_bridge_{_bridgeCounter++}";
        _engine.SetValue(bridgeName, CreateBridge(hostFn, binding, capability, audit));
        _engine.Execute(
            $"{targetExpr} = (function(bridge) {{ return function() {{ var args = Array.prototype.slice.call(arguments); var raw = bridge(JSON.stringify(args)); var envelope = JSON.parse(raw); if (envelope.__xript_err !== undefined) throw new Error(envelope.__xript_err); return envelope.__xript_ok; }}; }})({bridgeName}); delete globalThis.{bridgeName};");
    }

    private Func<string, string> CreateBridge(
        HostFunction hostFn, string binding, string? capability, Action<AuditEvent>? audit)
    {
        return argsJson =>
        {
            if (audit is not null)
            {
                try
                {
                    audit(new AuditEvent(binding, capability, NowMs()));
                }
                catch
                {
                }
            }

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

    private static double NowMs() =>
        (DateTime.UtcNow - EpochStart).TotalMilliseconds;

    private void AssignThrowingFunction(string targetExpr, string message)
    {
        _engine.Execute(
            $"{targetExpr} = function() {{ throw new Error(\"{EscapeJsDoubleQuote(message)}\"); }};");
    }

    private void RegisterHooks(HashSet<string> granted)
    {
        var effectiveHooks = _manifest.EffectiveHooks();
        if (effectiveHooks.Count == 0) return;

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

        foreach (var (hookName, hookDef) in effectiveHooks)
        {
            if (hookDef.Phases is { Count: > 0 } phases)
            {
                _engine.Execute($"globalThis.hooks['{EscapeJs(hookName)}'] = {{}};");
                foreach (var phase in phases)
                {
                    if (hookDef.Capability is { } cap && !Capabilities.GrantedSatisfies(granted, cap))
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
                if (hookDef.Capability is { } cap && !Capabilities.GrantedSatisfies(granted, cap))
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

        var hookNsNames = effectiveHooks
            .Where(kv => kv.Value.Phases is { Count: > 0 })
            .Select(kv => kv.Key);
        foreach (var nsName in hookNsNames)
            _engine.Execute($"Object.freeze(globalThis.hooks['{EscapeJs(nsName)}']);");
    }

    private void RegisterEvents(HashSet<string> granted)
    {
        if (_manifest.Events is null || _manifest.Events.Count == 0) return;

        _engine.Execute("""
            globalThis.__xript_event_handlers = {};
            globalThis.__xript_register_event = function(id, handler) {
                if (!globalThis.__xript_event_handlers[id]) {
                    globalThis.__xript_event_handlers[id] = [];
                }
                globalThis.__xript_event_handlers[id].push(handler);
            };
            globalThis.__xript_fire_events = function(id, data) {
                var handlers = globalThis.__xript_event_handlers[id];
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
            globalThis.__xript_event_subscribers = {};
            globalThis.events = {
                on: function(id, handler) {
                    var register = globalThis.__xript_event_subscribers[id];
                    if (typeof register !== 'function') {
                        throw new Error("event '" + id + "' is not declared by the host");
                    }
                    return register(handler);
                }
            };
            globalThis.events.subscribe = globalThis.events.on;
            """);

        foreach (var ev in _manifest.Events)
        {
            if (ev.Capability is { } cap && !Capabilities.GrantedSatisfies(granted, cap))
            {
                _engine.Execute(
                    $"globalThis.__xript_event_subscribers['{EscapeJs(ev.Id)}'] = function() {{ throw new Error(\"subscribing to event \\\"{EscapeJs(ev.Id)}\\\" requires the \\\"{EscapeJs(cap)}\\\" capability\"); }};");
            }
            else
            {
                _engine.Execute(
                    $"globalThis.__xript_event_subscribers['{EscapeJs(ev.Id)}'] = function(handler) {{ globalThis.__xript_register_event('{EscapeJs(ev.Id)}', handler); }};");
            }
        }

        _engine.Execute("Object.freeze(globalThis.events);");
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
