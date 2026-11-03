using System.Diagnostics;
using System.Text.Json;
using Jint;
using Jint.Native;
using Jint.Native.Function;
using Jint.Native.Object;
using Jint.Runtime;
using Jint.Runtime.Modules;
using Xript.Runtime.Fragments;

namespace Xript.Runtime;

internal sealed class Sandbox : IDisposable
{
    private readonly Engine _engine;
    private readonly Manifest _manifest;
    private readonly CancellationToken _cancellation;

    /// <summary>The deadline token in force right now; a new call budget links to it.</summary>
    private CancellationToken _budgetToken;

    private readonly CallDeadlineConstraint _deadline = new();
    private readonly long _defaultTimeoutMs;
    private readonly long? _hardTimeoutMs;
    /// <summary>
    /// A runtime-owned token linked to the host's. Jint installs its cancellation constraint
    /// only for a token that can actually be cancelled, so passing the host's
    /// <c>CancellationToken.None</c> straight through left no constraint to swap and no
    /// per-call deadline. This one is always cancellable, so the lever always exists.
    /// </summary>
    private readonly CancellationTokenSource _constraintLifetime;
    private readonly DenyExternalModuleLoader _moduleLoader = new();
    private readonly IReadOnlyDictionary<string, string> _libraries;
    private readonly HashSet<string> _registeredLibraryModules = [];
    private int _moduleCounter;
    private readonly bool _valueFidelity;
    private static readonly DateTime EpochStart =
        new(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    internal HashSet<string> GrantedCapabilities { get; }

    private readonly EventBus _bus;

    /// <summary>
    /// Whether the bus defines the <c>events</c> global. A manifest that declares no events and
    /// a top-level binding named <c>events</c> keeps that binding, as it always has.
    /// </summary>
    private static bool InstallsEventsGlobal(Manifest manifest) =>
        manifest.Events is { Count: > 0 } || manifest.Bindings?.ContainsKey("events") != true;

    internal DebugSession? DebugSession { get; }

    /// <summary>Which mod is running right now.</summary>
    internal CallerContext Caller { get; } = new();

    /// <summary>Where this runtime raises its deprecation notices, each code once.</summary>
    internal DeprecationChannel Deprecations { get; }

    /// <summary>The callbacks this runtime holds past their binding calls.</summary>
    internal RetainedRegistry Retained { get; }

    internal Engine Engine => _engine;

    /// <summary>The schema default for <c>limits.max_retained_callbacks</c>.</summary>
    internal const int DefaultMaxRetainedCallbacks = 10000;

    /// <summary>
    /// Bindings the manifest declares that the host did not supply, fully qualified and sorted.
    /// </summary>
    internal IReadOnlyList<string> MissingBindings { get; }

    internal Sandbox(Manifest manifest, RuntimeOptions options)
    {
        _manifest = manifest;
        _cancellation = options.Cancellation;
        Deprecations = new DeprecationChannel(options.OnDeprecation);
        var granted = new HashSet<string>(options.Capabilities);
        GrantedCapabilities = granted;

        MissingBindings = MissingBindingNames(manifest, options.HostBindings);
        if (options.StrictBindings && MissingBindings.Count > 0)
            throw new MissingBindingsException(MissingBindings);

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
        Retained = new RetainedRegistry(this, manifest.Limits?.MaxRetainedCallbacks ?? DefaultMaxRetainedCallbacks);

        var debugEnabled = options.Debug is not null;

        _defaultTimeoutMs = effective.TimeoutMs ?? 5000;
        _hardTimeoutMs = options.HardLimits?.TimeoutMs;
        // Jint fixes `TimeoutInterval` when the engine is built, so a slot that widens past
        // the manifest budget would still be cut off by it. The interval is therefore set to
        // the widest budget any slot could ask for and serves as a backstop; the real
        // per-call deadline is the cancellation constraint, swapped per call below.
        var ceilingMs = WidestBudgetMs(manifest, _defaultTimeoutMs, _hardTimeoutMs);
        _constraintLifetime = CancellationTokenSource.CreateLinkedTokenSource(options.Cancellation);
        _budgetToken = _constraintLifetime.Token;

        _engine = new Engine(cfg =>
        {
            if (!debugEnabled)
                cfg.TimeoutInterval(TimeSpan.FromMilliseconds(ceilingMs));

            if (effective.MemoryMb is > 0)
                cfg.LimitMemory(effective.MemoryMb.Value * 1024 * 1024);

            if (effective.MaxStackDepth is > 0)
                cfg.LimitRecursion(effective.MaxStackDepth.Value);

            // Installed unconditionally via the runtime-owned linked token: the constraint is
            // the only per-call deadline lever Jint exposes, and Jint declines to install one
            // for a token that cannot be cancelled.
            cfg.CancellationToken(_constraintLifetime.Token);
            cfg.Constraint(_deadline);

            if (debugEnabled)
            {
                cfg.DebugMode(true);
                cfg.Debugger.InitialStepMode =
                    options.Debug!.StopOnEntry ? Jint.Runtime.Debugger.StepMode.Into : Jint.Runtime.Debugger.StepMode.None;
            }

            cfg.Modules.ModuleLoader = _moduleLoader;

            cfg.Strict();
        });

        _valueFidelity = options.ValueFidelity;
        RegisterMarshal();
        RemoveDangerousGlobals();
        RegisterConsole(options.Console);
        RegisterBindings(options.HostBindings, granted, options.Audit);
        var shadowable = ShadowableBindings();
        RegisterFragmentHooks();
        RegisterHooks(granted);
        RegisterExportRegistry();
        _bus = new EventBus(
            _engine, manifest.Events, granted, Caller, InstallsEventsGlobal(manifest),
            JsonElementToJsValue, JsValueToJsonElement);
        ReportShadowedBindings(shadowable);

        if (debugEnabled)
            DebugSession = new DebugSession(_engine, options.Debug!);
    }

    /// <summary>The built-in globals a top-level binding can be replaced by, in the order a notice names them.</summary>
    private static readonly string[] ShadowingBuiltins = ["events", "hooks", "xript"];

    /// <summary>
    /// What each top-level binding named like a built-in installed as, taken right after the
    /// bindings install so <see cref="ReportShadowedBindings"/> can tell whether a built-in
    /// replaced it.
    /// </summary>
    private List<(string Name, JsValue Installed)> ShadowableBindings()
    {
        var installed = new List<(string, JsValue)>();
        foreach (var name in ShadowingBuiltins)
        {
            if (_manifest.Bindings?.ContainsKey(name) == true)
                installed.Add((name, _engine.GetValue(name)));
        }
        return installed;
    }

    /// <summary>
    /// Raises <c>binding-shadows-builtin</c> once, naming every binding a built-in replaced.
    /// The binding still loses exactly as it always has; this only says so.
    /// </summary>
    private void ReportShadowedBindings(List<(string Name, JsValue Installed)> shadowable)
    {
        var replaced = shadowable
            .Where(binding => !ReferenceEquals(binding.Installed, _engine.GetValue(binding.Name)))
            .Select(binding => binding.Name)
            .ToList();
        if (replaced.Count == 0) return;
        Deprecations.Raise(
            "binding-shadows-builtin",
            $"host bindings replaced by a built-in global of the same name, which mods see instead: {string.Join(", ", replaced)}",
            "Rename the binding or move it under a namespace.");
    }

    /// <summary>
    /// What the host receives for a script <c>undefined</c> on this runtime: the marker when
    /// <see cref="RuntimeOptions.ValueFidelity"/> is on, otherwise <c>null</c>.
    /// </summary>
    internal JsonElement UndefinedElement() =>
        _valueFidelity ? XriptValue.Undefined : JsonDocument.Parse("null").RootElement.Clone();

    /// <summary>
    /// Installs <c>__xript_marshal</c>, the sandbox half of special-value markers: a
    /// <c>JSON.stringify</c> replacer that encodes them and a decoder that turns markers back
    /// into values in place. With markers off both are pass-throughs. Captures the JSON and
    /// Object built-ins before any mod code runs and is not writable afterwards.
    /// </summary>
    private void RegisterMarshal()
    {
        _engine.Execute($$"""
            Object.defineProperty(globalThis, '__xript_marshal', { value: (function (on, key) {
                var stringify = JSON.stringify;
                var keys = Object.keys;
                var define = Object.defineProperty;
                function tag(v) {
                    if (!on) return null;
                    if (v === undefined) return 'undefined';
                    if (typeof v === 'number') {
                        if (v !== v) return 'NaN';
                        if (v === Infinity) return 'Infinity';
                        if (v === -Infinity) return '-Infinity';
                        if (v === 0 && 1 / v < 0) return '-0';
                    }
                    return null;
                }
                function replacer(k, v) {
                    var t = tag(v);
                    if (t === null) return v;
                    var m = {};
                    m[key] = t;
                    return m;
                }
                function special(v) {
                    if (Array.isArray(v)) return null;
                    var ks = keys(v);
                    if (ks.length !== 1 || ks[0] !== key) return null;
                    switch (v[key]) {
                        case 'undefined': return { v: undefined };
                        case 'NaN': return { v: NaN };
                        case 'Infinity': return { v: Infinity };
                        case '-Infinity': return { v: -Infinity };
                        case '-0': return { v: -0 };
                        default: return null;
                    }
                }
                function decode(v) {
                    if (!on || v === null || typeof v !== 'object') return v;
                    var s = special(v);
                    if (s !== null) return s.v;
                    var ks = keys(v);
                    for (var i = 0; i < ks.length; i++) {
                        var child = v[ks[i]];
                        if (child === null || typeof child !== 'object') continue;
                        var decoded = decode(child);
                        if (decoded !== child) define(v, ks[i], { value: decoded, writable: true, enumerable: true, configurable: true });
                    }
                    return v;
                }
                return Object.freeze({
                    replacer: replacer,
                    decode: decode,
                    stringify: function (v) { return stringify(v, replacer); }
                });
            })({{(_valueFidelity ? "true" : "false")}}, {{JsonSerializer.Serialize(XriptValue.Marker)}}) });
            """);
    }

    /// <summary>
    /// The widest deadline any call on this runtime could legitimately ask for: the manifest
    /// budget, raised by the most generous slot or hook that declares its own, clamped by the
    /// embedder's ceiling. Used only to size Jint's fixed timeout interval so it never fires
    /// ahead of a per-call deadline.
    /// </summary>
    private static long WidestBudgetMs(Manifest manifest, long defaultMs, long? hardMs)
    {
        var widest = defaultMs;
        foreach (var slot in manifest.Slots ?? [])
        {
            if (slot.Limits?.TimeoutMs is { } declared && declared > widest)
                widest = declared;
        }
        foreach (var hook in manifest.EffectiveHooks().Values)
        {
            if (hook.Limits?.TimeoutMs is { } declared && declared > widest)
                widest = declared;
        }
        return hardMs is { } hard && widest > hard ? hard : widest;
    }

    /// <summary>
    /// The deadline governing one call. An override (a slot's <c>limits.timeout_ms</c>)
    /// replaces the manifest budget and is clamped to the embedder's ceiling rather than
    /// trusted, so a slot may widen only as far as the host allowed.
    /// </summary>
    private long CallTimeoutMs(long? overrideMs)
    {
        if (overrideMs is not { } requested)
            return _defaultTimeoutMs;
        return _hardTimeoutMs is { } hard && requested > hard ? hard : requested;
    }

    /// <summary>
    /// Arms the engine's cancellation constraint with this call's deadline and restores the
    /// previous token on dispose. The deadline is linked to the one already in force, so a call
    /// nested inside another (a host binding firing a hook mid-script) can only narrow the outer
    /// call's budget, and the outer deadline is back in force once the inner call returns.
    /// <see cref="DeadlineExpired"/> tells a deadline apart from a host cancellation, which
    /// otherwise surface as the same Jint exception.
    /// </summary>
    private sealed class CallBudget : IDisposable
    {
        private readonly Sandbox _owner;
        private readonly Jint.Constraints.CancellationConstraint? _constraint;
        private readonly CancellationToken _previous;
        private readonly CancellationTokenSource? _source;

        private readonly CancellationToken _hostToken;
        private readonly (long Deadline, CancellationTokenSource? Source) _previousDeadline;

        internal CallBudget(Sandbox owner, long timeoutMs)
        {
            _owner = owner;
            _constraint = owner._engine.Constraints.Find<Jint.Constraints.CancellationConstraint>();
            if (_constraint is null)
                return;

            _hostToken = owner._cancellation;
            _previous = owner._budgetToken;
            _source = CancellationTokenSource.CreateLinkedTokenSource(_previous);
            _source.CancelAfter(TimeSpan.FromMilliseconds(timeoutMs));
            _previousDeadline = owner._deadline.Enter(timeoutMs, _source);
            owner._budgetToken = _source.Token;
            // `Reset` is the public swap; the constraint's `Token` property is not settable
            // from outside Jint, whatever the shipped XML documentation suggests.
            _constraint.Reset(_source.Token);
        }

        /// <summary>The call ran out of budget, as opposed to the host cancelling it.</summary>
        internal bool DeadlineExpired =>
            _source is not null && _source.IsCancellationRequested && !_hostToken.IsCancellationRequested;

        public void Dispose()
        {
            if (_source is null) return;
            _owner._deadline.Restore(_previousDeadline);
            _owner._budgetToken = _previous;
            _constraint?.Reset(_previous);
            _source.Dispose();
        }
    }

    private CallBudget BeginCallBudget(long? overrideMs) => new(this, CallTimeoutMs(overrideMs));

    /// <summary>
    /// Every binding the manifest declares that the host did not supply, fully qualified and
    /// sorted. A declared-but-unsupplied binding installs as a stub that throws only when a mod
    /// calls it, so without this the manifest and the host's wiring could disagree indefinitely.
    /// </summary>
    internal static List<string> MissingBindingNames(Manifest manifest, HostBindings hostBindings)
    {
        var missing = new List<string>();
        if (manifest.Bindings is not null)
            CollectMissing(manifest.Bindings, hostBindings, new List<string>(), missing);
        missing.Sort(StringComparer.Ordinal);
        return missing;
    }

    private static void CollectMissing(
        Dictionary<string, JsonElement> bindings,
        HostBindings host,
        List<string> path,
        List<string> missing)
    {
        foreach (var (name, def) in bindings)
        {
            path.Add(name);
            if (!Presence.Omits(def, host, path))
                CollectMissingAt(def, host, path, missing);
            path.RemoveAt(path.Count - 1);
        }
    }

    private static void CollectMissingAt(JsonElement def, HostBindings host, List<string> path, List<string> missing)
    {
        if (def.ValueKind == JsonValueKind.Object && def.TryGetProperty("members", out var members))
        {
            var nested = new Dictionary<string, JsonElement>();
            foreach (var member in members.EnumerateObject()) nested[member.Name] = member.Value;
            CollectMissing(nested, host, path, missing);
            return;
        }

        var supplied = Presence.AccessorMode(def) is not null
            ? Presence.Supplies(def, host.NodeAt(path))
            : host.Supplies(path);
        if (!supplied)
            missing.Add(string.Join(".", path));
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
        using var budget = BeginCallBudget(null);
        var depth = Caller.Depth;
        try
        {
            var jsValue = source is null ? _engine.Evaluate(code) : _engine.Evaluate(code, source);
            sw.Stop();
            DebugSession?.NotifyTerminated();
            return new ExecutionResult(JsValueToJsonElement(jsValue), sw.Elapsed.TotalMilliseconds);
        }
        catch (ExecutionCanceledException)
        {
            if (budget.DeadlineExpired)
                throw new ExecutionLimitException("timeout_ms");
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
        finally
        {
            Caller.UnwindTo(depth);
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
                $"(function() {{ var bucket = globalThis.__xript_exports[globalThis.__xript_export_owner]; if (!Object.prototype.hasOwnProperty.call(bucket, {escaped})) {{ bucket[{escaped}] = __xript_harvest_tmp; }} }})();");
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

        JsValue dataArg = JsValue.Undefined;
        if (options?.Data is { } data)
            dataArg = JsonElementToJsValue(data);

        var result = Dispatch(() => _engine.Invoke("__xript_fire_handlers", registryKey, dataArg), hookDef.Limits?.TimeoutMs);

        if (result is not ObjectInstance arrObj)
            return [];

        var lengthVal = arrObj.Get("length");
        var length = (int)lengthVal.AsNumber();

        var results = new JsonElement[length];
        for (var i = 0; i < length; i++)
            results[i] = JsValueToJsonElement(arrObj.Get(i.ToString()));

        return results;
    }

    /// <summary>
    /// Runs one hook or event dispatch under a fresh budget for the whole fire: the hook's own
    /// <c>limits.timeout_ms</c> when <paramref name="budgetMs"/> carries one, the manifest's
    /// otherwise. A handler that throws is swallowed inside the dispatch itself; what reaches
    /// here is the dispatch failing as a whole, an execution limit or a host cancellation, which
    /// surfaces as it does from <see cref="Execute"/>. The caller stack is restored either way,
    /// since a stopped handler never pops its own frame.
    /// </summary>
    private T Dispatch<T>(Func<T> dispatch, long? budgetMs = null)
    {
        if (_cancellation.IsCancellationRequested)
            throw new ExecutionCancelledException();

        var depth = Caller.Depth;
        using var budget = BeginCallBudget(budgetMs);
        try
        {
            return dispatch();
        }
        catch (ExecutionCanceledException)
        {
            if (_cancellation.IsCancellationRequested && !budget.DeadlineExpired)
                throw new ExecutionCancelledException();
            throw new ExecutionLimitException("timeout_ms");
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
        finally
        {
            Caller.UnwindTo(depth);
        }
    }

    internal JsonElement[] Emit(string eventId, FireHookOptions? options = null) =>
        [.. EmitTagged(eventId, options).Select(result => result.Value)];

    /// <summary>
    /// <see cref="Emit"/> with each result tagged by the mod that subscribed the handler.
    /// A single object payload spreads its values to the handler's parameters.
    /// </summary>
    internal IReadOnlyList<(string? Owner, JsonElement Value)> EmitTagged(string eventId, FireHookOptions? options = null)
    {
        JsonElement[] args = options?.Data is { } data ? [data] : [];
        return Dispatch(() => _bus.Emit(eventId, args));
    }

    internal int CancelOwned(string? owner) => _bus.CancelOwned(owner);

    internal JsonElement DeclareEvent(JsonElement entry) => _bus.Declare(entry);


    private HostFunction CallerAware(CallerHostFunction function, string binding) =>
        args => function(new HostCallInfo(Caller.Current, binding), args);

    internal RawFragmentOp[] FireFragmentHook(
        string fragmentId, string lifecycle, Dictionary<string, object?>? bindings = null)
    {
        try
        {
            var key = $"fragment:{lifecycle}:{fragmentId}";

            JsValue dataArg = JsValue.Undefined;
            if (bindings is not null)
            {
                var json = System.Text.Json.JsonSerializer.Serialize(bindings);
                dataArg = _engine.Evaluate($"__xript_marshal.decode(JSON.parse({System.Text.Json.JsonSerializer.Serialize(json)}))");
            }

            var result = _engine.Invoke("__xript_fire_fragment_handlers", key, dataArg);

            if (result is not ObjectInstance arrObj)
                return [];

            var lengthVal = arrObj.Get("length");
            var length = (int)lengthVal.AsNumber();

            var ops = new List<RawFragmentOp>();
            for (var i = 0; i < length; i++)
            {
                var item = arrObj.Get(i.ToString());
                if (item is ObjectInstance opObj)
                {
                    var op = opObj.Get("op").AsString();
                    var selector = opObj.Get("selector").AsString();
                    var value = opObj.HasProperty("value")
                        ? Fragments.PropValue.FromJson(
                            System.Text.Json.Nodes.JsonNode.Parse(
                                JsValueToJsonElement(opObj.Get("value")).GetRawText()))
                        : null;
                    ops.Add(new RawFragmentOp(
                        op,
                        selector,
                        OptionalString(opObj, "prop"),
                        OptionalString(opObj, "attr"),
                        value));
                }
            }

            return [.. ops];
        }
        catch
        {
            return [];
        }
    }

    private static string? OptionalString(ObjectInstance obj, string key)
    {
        if (!obj.HasProperty(key)) return null;
        var value = obj.Get(key);
        return value.IsUndefined() || value.IsNull() ? null : value.AsString();
    }

    internal void SetExportOwner(string? owner)
    {
        _engine.Execute($"__xript_set_export_owner({JsonSerializer.Serialize(owner ?? string.Empty)});");
    }

    /// <summary>The one mod whose namespace holds export <paramref name="name"/>, or null for none, several, or the host's.</summary>
    private string? SoleExportOwner(string name)
    {
        try
        {
            if (_engine.Invoke("__xript_export_owners_of", name) is ObjectInstance owners
                && owners.Get("length").AsNumber() == 1
                && owners.Get("0") is { } only && only.IsString() && only.AsString().Length > 0)
                return only.AsString();
        }
        catch
        {
        }
        return null;
    }

    internal JsonElement InvokeExport(
        string name,
        JsonElement[] args,
        string? owner = null,
        long? timeoutOverrideMs = null)
    {
        if (_cancellation.IsCancellationRequested)
            throw new ExecutionCancelledException();

        var ownerExpr = owner is null ? "undefined" : JsonSerializer.Serialize(owner);

        bool registered;
        try
        {
            registered = _engine.Evaluate(
                $"typeof __xript_lookup_export({JsonSerializer.Serialize(name)}, {ownerExpr}) === 'function'")
                .AsBoolean();
        }
        catch
        {
            registered = false;
        }

        if (!registered)
            throw new InvokeException(name, $"export '{name}' not found");

        using var caller = Caller.Enter(owner ?? SoleExportOwner(name));
        var argsElement = JsonSerializer.SerializeToElement(args);
        JsValue argsValue = ContainsMarker(argsElement)
            ? JsonElementToJsValue(argsElement)
            : new JsString(argsElement.GetRawText());
        var ownerValue = owner is null ? JsValue.Undefined : new JsString(owner);

        JsValue result;
        using var budget = BeginCallBudget(timeoutOverrideMs);
        var depth = Caller.Depth;
        try
        {
            result = _engine.Invoke("__xript_invoke_export", name, argsValue, ownerValue);
        }
        catch (ExecutionCanceledException)
        {
            if (budget.DeadlineExpired)
                throw new ExecutionLimitException("timeout_ms");
            throw new ExecutionCancelledException();
        }
        catch (TimeoutException)
        {
            throw new ExecutionLimitException("timeout_ms");
        }
        finally
        {
            Caller.UnwindTo(depth);
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

    /// <summary>
    /// Calls a retained callback between script calls, on a fresh execution budget. A budget stop
    /// fails this one call with <c>limit</c> and leaves the runtime usable.
    /// </summary>
    internal JsonElement InvokeRetainedFresh(JsValue function, JsonElement[] args, string binding)
    {
        if (_cancellation.IsCancellationRequested)
            throw new ExecutionCancelledException();

        var jsArgs = args.Select(JsonElementToJsValue).ToArray();
        JsValue result;
        using (var budget = BeginCallBudget(null))
        {
            try
            {
                result = _engine.Invoke(function, JsValue.Undefined, jsArgs);
            }
            catch (JavaScriptException ex)
            {
                var (name, message) = CallbackScope.Describe(ex.Error, ex.Message);
                throw new CallbackException(binding, "threw", name, message);
            }
            catch (ExecutionCanceledException)
            {
                if (budget.DeadlineExpired)
                    throw new CallbackException(binding, "limit");
                throw new ExecutionCancelledException();
            }
            catch (Exception ex) when (CallbackScope.IsBudgetStop(ex))
            {
                throw new CallbackException(binding, "limit");
            }
        }

        if (CallbackScope.IsThenable(result))
            throw new CallbackException(binding, "promise");
        return JsValueToJsonElement(result);
    }

    public void Dispose()
    {
        Retained.ReleaseAll();
        _engine.Dispose();
        _constraintLifetime.Dispose();
    }

    private void RegisterExportRegistry()
    {
        _engine.Execute("""
            globalThis.__xript_exports = { "": {} };
            globalThis.__xript_export_owner = "";
            globalThis.__xript_set_export_owner = function(owner) {
                var key = typeof owner === 'string' ? owner : "";
                globalThis.__xript_export_owner = key;
                if (!globalThis.__xript_exports[key]) globalThis.__xript_exports[key] = {};
                return key;
            };
            globalThis.__xript_export_owners_of = function(name) {
                var owners = [];
                var keys = Object.keys(globalThis.__xript_exports);
                for (var i = 0; i < keys.length; i++) {
                    if (typeof globalThis.__xript_exports[keys[i]][name] === 'function') owners.push(keys[i]);
                }
                return owners;
            };
            globalThis.__xript_lookup_export = function(name, owner) {
                if (typeof owner === 'string') {
                    var bucket = globalThis.__xript_exports[owner];
                    return bucket ? bucket[name] : undefined;
                }
                var owners = globalThis.__xript_export_owners_of(name);
                return owners.length === 1 ? globalThis.__xript_exports[owners[0]][name] : undefined;
            };
            globalThis.xript = globalThis.xript || {};
            globalThis.xript.exports = {
                register: function(name, fn) {
                    if (typeof name !== 'string' || name.length === 0) {
                        throw new Error('xript.exports.register requires a non-empty string name');
                    }
                    if (typeof fn !== 'function') {
                        throw new Error('xript.exports.register requires a function');
                    }
                    globalThis.__xript_exports[globalThis.__xript_export_owner][name] = fn;
                }
            };
            Object.freeze(globalThis.xript.exports);
            globalThis.__xript_invoke_export = function(name, argsJson, owner) {
                var fn = globalThis.__xript_lookup_export(name, owner);
                if (typeof fn !== 'function') {
                    return { __xript_err: "export '" + name + "' not found" };
                }
                try {
                    var args = globalThis.__xript_marshal.decode(typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson);
                    return { __xript_ok: fn.apply(null, args) };
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
                            toggle: function(selector, condition) { ops.push({ op: "toggle", selector: selector, value: !!condition }); },
                            addClass: function(selector, className) { ops.push({ op: "addClass", selector: selector, value: className }); },
                            removeClass: function(selector, className) { ops.push({ op: "removeClass", selector: selector, value: className }); },
                            setText: function(selector, text) { ops.push({ op: "setText", selector: selector, value: text }); },
                            setAttr: function(selector, attr, value) { ops.push({ op: "setAttr", selector: selector, attr: attr, value: value }); },
                            removeAttr: function(selector, attr) { ops.push({ op: "removeAttr", selector: selector, attr: attr }); },
                            setProp: function(selector, prop, value) { ops.push({ op: "setProp", selector: selector, prop: prop, value: value }); },
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
                    var descriptor = Object.getOwnPropertyDescriptor(obj, key);
                    var val = descriptor && descriptor.value;
                    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
                        globalThis.__xript_deep_freeze(val);
                    }
                });
                return Object.freeze(obj);
            };
            delete globalThis.eval;
            (function () {
                var refuse = function () {
                    throw new TypeError("Function constructor is not permitted. Dynamic code generation is disabled in xript.");
                };
                var prototypes = [
                    Object.getPrototypeOf(function () {}),
                    Object.getPrototypeOf(async function () {}),
                    Object.getPrototypeOf(function* () {}),
                    Object.getPrototypeOf(async function* () {}),
                ];
                for (var i = 0; i < prototypes.length; i++) {
                    Object.defineProperty(prototypes[i], 'constructor', { value: refuse, writable: true, configurable: true });
                }
            })();
            if (typeof globalThis.Function !== 'undefined') {
                Object.defineProperty(globalThis, 'Function', {
                    get: function() { throw new TypeError("Function constructor is not permitted. Dynamic code generation is disabled in xript."); },
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
        _engine.Execute(Presence.ProbeSource(Presence.ProvidedPaths(_manifest.Bindings, hostBindings)));
        if (_manifest.Bindings is null) return;

        foreach (var (name, bindingElement) in _manifest.Bindings)
        {
            var node = hostBindings.NodeAt([name]);
            if (Presence.IsOptional(bindingElement) && !Presence.Supplies(bindingElement, node))
                _engine.Execute($"globalThis['{EscapeJs(name)}'] = undefined;");
            else if (Presence.AccessorMode(bindingElement) is not null)
                RegisterAccessor("globalThis", name, name, bindingElement, node, granted, audit);
            else if (IsNamespace(bindingElement))
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

        var hostFn = hostBindings.GetFunction(name)
            ?? (hostBindings.GetCallerFunction(name) is { } aware ? CallerAware(aware, name) : null);
        if (hostFn is null)
        {
            AssignThrowingFunction(target, $"host binding '{name}' is not provided");
            return;
        }

        var declaredCapability = TryGetCapability(def, out var cap) ? cap : null;
        AssignBridgedFunction(target, hostFn, name, declaredCapability, audit, def);
    }

    private static readonly JsonElement JsonNull = JsonDocument.Parse("null").RootElement.Clone();

    /// <summary>
    /// Defines an accessor binding on <paramref name="targetExpr"/>. The getter and setter are
    /// the ordinary bridged binding wrappers, so each access is capability-gated, audited,
    /// budgeted, and error-marshalled exactly as a function call.
    /// </summary>
    private void RegisterAccessor(
        string targetExpr,
        string key,
        string qualifiedName,
        JsonElement def,
        HostNamespaceMember? hostMember,
        HashSet<string> granted,
        Action<AuditEvent>? audit)
    {
        var accessor = Presence.Supplies(def, hostMember) ? hostMember!.Accessor : null;
        var getName = $"__xript_accessor_get_{_bridgeCounter++}";
        AssignAccessorHalf($"globalThis.{getName}", accessor is null ? null : _ => accessor.Get(), qualifiedName, def, granted, audit);

        var setExpr = "undefined";
        string? setName = null;
        if (Presence.AccessorMode(def) == "get-set")
        {
            setName = $"__xript_accessor_set_{_bridgeCounter++}";
            setExpr = $"globalThis.{setName}";
            HostFunction? setter = accessor?.Set is { } set
                ? args =>
                {
                    set(args.Length > 0 ? args[0] : JsonNull);
                    return JsonNull;
                }
                : null;
            AssignAccessorHalf(setExpr, setter, qualifiedName, def, granted, audit);
        }

        var cleanup = setName is null ? $"delete globalThis.{getName};" : $"delete globalThis.{getName}; delete globalThis.{setName};";
        _engine.Execute(
            $"{Presence.DefineAccessorSource}({targetExpr}, '{EscapeJs(key)}', globalThis.{getName}, {setExpr}, {JsonSerializer.Serialize(qualifiedName)}); {cleanup}");
    }

    private void AssignAccessorHalf(
        string targetExpr, HostFunction? hostFn, string qualifiedName, JsonElement def, HashSet<string> granted, Action<AuditEvent>? audit)
    {
        if (TryGetCapability(def, out var capability) && !Capabilities.GrantedSatisfies(granted, capability))
        {
            AssignThrowingFunction(targetExpr, $"{qualifiedName}() requires the \"{capability}\" capability, which hasn't been granted to this script");
            return;
        }
        if (hostFn is null)
        {
            AssignThrowingFunction(targetExpr, $"host binding '{qualifiedName}' is not provided");
            return;
        }
        AssignBridgedFunction(targetExpr, hostFn, qualifiedName, TryGetCapability(def, out var cap) ? cap : null, audit, def);
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

            if (Presence.IsOptional(memberDef) && !Presence.Supplies(memberDef, hostMember))
            {
                _engine.Execute($"{memberTarget} = undefined;");
                continue;
            }

            if (Presence.AccessorMode(memberDef) is not null)
            {
                RegisterAccessor(target, memberName, qualifiedName, memberDef, hostMember, granted, audit);
                continue;
            }

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
                var literal = System.Text.Json.JsonSerializer.Serialize(prop.GetRawText());
                _engine.Execute($"{memberTarget} = __xript_marshal.decode(JSON.parse({literal}));");
                continue;
            }

            var hostFn = hostMember?.Function
                ?? (hostMember?.CallerFunction is { } aware ? CallerAware(aware, qualifiedName) : null);
            if (hostFn is null)
            {
                AssignThrowingFunction(memberTarget, $"host binding '{qualifiedName}' is not provided");
                continue;
            }

            var declaredCapability = TryGetCapability(memberDef, out var cap) ? cap : null;
            AssignBridgedFunction(memberTarget, hostFn, qualifiedName, declaredCapability, audit, memberDef);
        }
    }

    /// <summary>
    /// The sandbox side of a bridged binding: refuses a non-function where the manifest declares
    /// a function parameter, then serializes the arguments with every script function swapped
    /// for a numeric callback marker and hands the functions to the bridge alongside the JSON.
    /// </summary>
    private const string BridgeWrapper = """
        (function (bridge, marker, checks, name) {
            var stringify = JSON.stringify;
            var parse = JSON.parse;
            var slice = Array.prototype.slice;
            var marshal = globalThis.__xript_marshal;
            return function () {
                var args = slice.call(arguments);
                for (var i = 0; i < checks.length; i++) {
                    var check = checks[i];
                    var value = args[check.index];
                    if (typeof value === 'function') continue;
                    if (check.optional && (value === undefined || value === null)) continue;
                    throw new TypeError(name + '(): parameter "' + check.name + '" expects a function, got ' + (value === null ? 'null' : typeof value));
                }
                var fns = [];
                var json = stringify(args, function (key, v) {
                    if (typeof v === 'function') {
                        var m = {};
                        m[marker] = fns.length;
                        fns[fns.length] = v;
                        return m;
                    }
                    return marshal.replacer(key, v);
                });
                var raw = bridge(json, fns);
                var envelope = typeof raw === 'string' ? parse(raw) : raw;
                if (envelope.__xript_err !== undefined) throw new Error(envelope.__xript_err);
                return marshal.decode(envelope.__xript_ok);
            };
        })
        """;

    private void AssignBridgedFunction(
        string targetExpr, HostFunction hostFn, string binding, string? capability, Action<AuditEvent>? audit, JsonElement def)
    {
        var bridgeName = $"__xript_bridge_{_bridgeCounter++}";
        var checks = FunctionParamCheck.ToJson(FunctionParamCheck.For(def));
        var positions = RetainPositions.For(def, _manifest.Types);
        _engine.SetValue(bridgeName, CreateBridge(hostFn, binding, capability, audit, positions));
        _engine.Execute(
            $"{targetExpr} = {BridgeWrapper}({bridgeName}, {JsonSerializer.Serialize(XriptCallback.Marker)}, {checks}, {JsonSerializer.Serialize(binding)}); delete globalThis.{bridgeName};");
    }

    private Func<string, JsValue, JsValue> CreateBridge(
        HostFunction hostFn, string binding, string? capability, Action<AuditEvent>? audit, RetainPositions positions)
    {
        return (argsJson, functions) =>
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

            using var scope = new CallbackScope(
                _engine, binding, functions, JsonElementToJsValue, JsValueToJsonElement, positions, Retained);
            args = scope.ResolveMarkers(args);
            try
            {
                var result = hostFn(args);
                scope.Settle(null);
                if (ContainsMarker(result))
                {
                    var envelope = new JsObject(_engine);
                    envelope.Set("__xript_ok", JsonElementToJsValue(result));
                    return envelope;
                }
                var raw = result.GetRawText();
                return $"{{\"__xript_ok\":{raw}}}";
            }
            catch (Exception ex)
            {
                scope.Settle(ex);
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

        InstallCallerHooks();
        _engine.Execute("""
            (function (current, enter, exit) {
            globalThis.__xript_hook_handlers = {};
            globalThis.__xript_register_handler = function(key, handler) {
                if (!globalThis.__xript_hook_handlers[key]) {
                    globalThis.__xript_hook_handlers[key] = [];
                }
                globalThis.__xript_hook_handlers[key].push({ handler: handler, owner: current() });
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
                    enter(handlers[i].owner);
                    try {
                        results.push(handlers[i].handler.apply(null, args));
                    } catch(e) {
                        results.push(undefined);
                    } finally {
                        exit();
                    }
                }
                return results;
            };
            })(__xript_caller_current, __xript_caller_enter, __xript_caller_exit);
            """);
        RemoveCallerHooks();

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

    /// <summary>
    /// Exposes the caller context to the sandbox-side handler registries for one install: the
    /// registries capture these in a closure and <see cref="RemoveCallerHooks"/> deletes the
    /// globals, so no script can reach them.
    /// </summary>
    private void InstallCallerHooks()
    {
        _engine.SetValue("__xript_caller_current", new Func<JsValue>(() =>
            Caller.Current is { } owner ? new JsString(owner) : JsValue.Null));
        _engine.SetValue("__xript_caller_enter", new Action<JsValue>(owner =>
            Caller.Push(owner.IsString() ? owner.AsString() : null)));
        _engine.SetValue("__xript_caller_exit", new Action(Caller.Pop));
    }

    private void RemoveCallerHooks() =>
        _engine.Execute(
            "delete globalThis.__xript_caller_current; delete globalThis.__xript_caller_enter; delete globalThis.__xript_caller_exit;");

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
        if (value.IsUndefined())
            return UndefinedElement();

        if (value.IsNull())
            return JsonDocument.Parse("null").RootElement.Clone();

        if (value.IsBoolean())
            return JsonDocument.Parse(value.AsBoolean() ? "true" : "false").RootElement.Clone();

        if (value.IsNumber())
        {
            var num = value.AsNumber();
            if (double.IsNaN(num) || double.IsInfinity(num))
                return _valueFidelity ? XriptValue.Number(num) : JsonDocument.Parse("null").RootElement.Clone();
            if (_valueFidelity && num == 0 && double.IsNegative(num))
                return XriptValue.NegativeZero;
            if (num == Math.Floor(num) && Math.Abs(num) < long.MaxValue)
                return JsonDocument.Parse(((long)num).ToString()).RootElement.Clone();
            return JsonDocument.Parse(
                num.ToString("R", System.Globalization.CultureInfo.InvariantCulture)).RootElement.Clone();
        }

        if (value.IsString())
        {
            var jsonStr = JsonSerializer.Serialize(value.AsString());
            return JsonDocument.Parse(jsonStr).RootElement.Clone();
        }

        try
        {
            _engine.SetValue("__xript_tmp_val", value);
            var jsonResult = _engine.Evaluate(
                _valueFidelity ? "__xript_marshal.stringify(__xript_tmp_val)" : "JSON.stringify(__xript_tmp_val)");
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
            JsonValueKind.Object when _valueFidelity && XriptValue.TryGetSpecial(element, out var special) => special switch
            {
                XriptSpecial.NaN => new JsNumber(double.NaN),
                XriptSpecial.Infinity => new JsNumber(double.PositiveInfinity),
                XriptSpecial.NegativeInfinity => new JsNumber(double.NegativeInfinity),
                XriptSpecial.NegativeZero => new JsNumber(-0.0),
                _ => JsValue.Undefined,
            },
            JsonValueKind.Object or JsonValueKind.Array when ContainsMarker(element) => Revive(ParseComplexJson(element)),
            JsonValueKind.Object or JsonValueKind.Array => ParseComplexJson(element),
            _ => JsValue.Undefined,
        };
    }

    private static bool IsMarker(JsonElement element) =>
        element.ValueKind == JsonValueKind.Object
        && element.EnumerateObject().Count() == 1
        && element.TryGetProperty(XriptCallback.Marker, out var token)
        && token.ValueKind == JsonValueKind.String
        && token.GetString()!.StartsWith(RetainedRegistry.TokenPrefix, StringComparison.Ordinal);

    /// <summary>Whether a host value carries a retained-callback marker anywhere inside it.</summary>
    private static bool ContainsMarker(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => IsMarker(element) || element.EnumerateObject().Any(p => ContainsMarker(p.Value)),
        JsonValueKind.Array => element.EnumerateArray().Any(ContainsMarker),
        _ => false,
    };

    /// <summary>
    /// Replaces every marker in a value crossing into the sandbox that names a retained callback
    /// this runtime issued with the script function it names, refusing one that is released or
    /// that the running mod may not receive. Any other marker stays plain data.
    /// </summary>
    private JsValue Revive(JsValue value)
    {
        if (value is not ObjectInstance obj)
            return value;
        var keys = obj.GetOwnPropertyKeys().Where(k => !k.IsSymbol()).ToList();
        if (!obj.IsArray() && keys.Count == 1 && keys[0].ToString() == XriptCallback.Marker
            && obj.Get(keys[0]) is { } token && token.IsString())
            return Retained.Resolve(token.AsString()) ?? obj;
        foreach (var key in keys)
        {
            if (obj.IsArray() && key.ToString() == "length") continue;
            var child = obj.Get(key);
            var revived = Revive(child);
            if (!ReferenceEquals(revived, child))
                obj.Set(key, revived);
        }
        return obj;
    }

    /// <summary>
    /// Builds a host object or array as a sandbox value with Jint's own JSON parser, so host
    /// data is never evaluated as script text and a real failure surfaces instead of becoming
    /// <c>null</c>.
    /// </summary>
    private JsValue ParseComplexJson(JsonElement element)
    {
        var parsed = new Jint.Native.Json.JsonParser(_engine).Parse(element.GetRawText());
        if (!_valueFidelity) return parsed;
        var decode = _engine.Evaluate("__xript_marshal.decode");
        return _engine.Invoke(decode, parsed);
    }
}
