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

    /// <summary>
    /// Whether budgets run on the real clock, with Jint's timeout interval and a cancellation
    /// timer behind the inline deadline. Off only under <see cref="RuntimeOptions.DeadlineClock"/>,
    /// where the replaced clock alone decides.
    /// </summary>
    private readonly bool _realTimeBudgets;
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
    private readonly Crossing _crossing;
    private readonly JsValue _promiseObserver;
    private readonly SandboxInternals _internals;
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

    private readonly bool _hostEvents;

    /// <summary>
    /// Refuses construction in host events mode unless the manifest declares a top-level
    /// <c>events</c> binding for the runtime to install. A manifest <c>events</c> catalogue is
    /// allowed; it documents the host's events but is wired to no script-visible bus.
    /// </summary>
    private static void CheckHostEvents(Manifest manifest)
    {
        if (manifest.Bindings?.ContainsKey("events") != true)
            throw new HostEventsException(
                "host events mode needs a top-level `events` binding in the manifest to install as the `events` global; " +
                "declare one, or construct the runtime without host events mode to get the built-in bus");
    }

    private void RefuseInHostEvents(string api)
    {
        if (_hostEvents) throw HostEventsException.Refused(api);
    }

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
        if (options.HostEvents)
            CheckHostEvents(manifest);
        _hostEvents = options.HostEvents;
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
        _realTimeBudgets = options.DeadlineClock is null;
        if (options.DeadlineClock is { } clock)
            _deadline.Clock = clock;

        _engine = new Engine(cfg =>
        {
            if (!debugEnabled && _realTimeBudgets)
                cfg.TimeoutInterval(TimeSpan.FromMilliseconds(ceilingMs));

            if (effective.MemoryMb is > 0)
                cfg.LimitMemory(effective.MemoryMb.Value * 1024 * 1024);

            if (effective.MaxStackDepth is > 0)
                cfg.LimitRecursion(effective.MaxStackDepth.Value);

            // Without the probe a runaway recursion, in script or in a native traversal such as a
            // deep `JSON.stringify`, overflows the native stack and ends the host process.
            cfg.Constraints.StackOverflowGuard = true;

            // `String(fn)` is a function's source in every other runtime; Jint answers a
            // `[native code]` placeholder unless the parser keeps the text.
            cfg.RetainFunctionSourceText(true);

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
        _crossing = new Crossing(_engine, _valueFidelity, Retained);
        _promiseObserver = _engine.Evaluate("""
            (function (apply, then) {
                return function (promise, box) {
                    apply(then, promise, [
                        function (value) { box.state = 1; box.value = value; },
                        function (reason) { box.state = 2; box.value = reason; }
                    ]);
                };
            })(Reflect.apply, Promise.prototype.then)
            """);
        RemoveDangerousGlobals();
        _internals = new SandboxInternals(_engine, Caller);
        _internals.InstallErrorClasses();
        RegisterConsole(options.Console);
        RegisterBindings(options.HostBindings, granted, options.Audit);
        var shadowable = ShadowableBindings();
        var hooks = _internals.InstallHooks();
        RegisterHooks(hooks, granted);
        _internals.InstallExports();
        _bus = new EventBus(
            _engine, manifest.Events, granted, Caller, InstallsEventsGlobal(manifest) && !_hostEvents,
            JsonElementToJsValue, JsValueToJsonElement);
        ReportShadowedBindings(shadowable);
        SealGlobals();

        if (debugEnabled)
            DebugSession = new DebugSession(_engine, options.Debug!);
    }

    /// <summary>The runtime's globals besides the bindings, which no mod may replace or delete.</summary>
    private static readonly string[] SealedBuiltins =
        ["hooks", "events", "xript", "console", "BindingError", "CapabilityDeniedError"];

    /// <summary>The sealed globals that are also deep-frozen, so their members stay put too.</summary>
    private static readonly string[] FrozenBuiltins =
        ["hooks", "xript", "console", "BindingError", "CapabilityDeniedError"];

    /// <summary>
    /// Locks every global the runtime installed for scripts as a non-writable, non-configurable
    /// property of <c>globalThis</c>, so one mod can neither replace nor delete what another calls.
    /// </summary>
    private void SealGlobals() =>
        _internals.Seal([.. _manifest.Bindings?.Keys ?? Enumerable.Empty<string>(), .. SealedBuiltins], FrozenBuiltins);

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
            if (owner._realTimeBudgets)
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
            if (jsValue.IsPromise())
            {
                var (state, settled) = Settle(jsValue);
                if (state == PromiseState.Pending)
                    throw new InvalidOperationException(PendingPromise("the script"));
                if (state == PromiseState.Rejected)
                    throw new JavaScriptException(settled);
                jsValue = settled;
            }
            var value = JsValueToJsonElement(jsValue, "execute");
            sw.Stop();
            DebugSession?.NotifyTerminated();
            return new ExecutionResult(value, sw.Elapsed.TotalMilliseconds);
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
                _internals.Harvest(name, value);
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
        var binding = options?.Phase is { } named ? $"hooks.{hookName}.{named}" : $"hooks.{hookName}";

        JsValue dataArg = JsValue.Undefined;
        if (options?.Data is { } data)
            dataArg = JsonElementToJsValue(data, binding);

        return Dispatch(() =>
        {
            if (_internals.FireHandlers(registryKey, dataArg) is not ObjectInstance arrObj)
                return Array.Empty<JsonElement>();
            var length = (int)arrObj.Get("length").AsNumber();
            var results = new JsonElement[length];
            for (var i = 0; i < length; i++)
                results[i] = JsValueToJsonElement(arrObj.Get(i.ToString()), binding);
            return results;
        }, hookDef.Limits?.TimeoutMs);
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
        RefuseInHostEvents("Emit");
        JsonElement[] args = options?.Data is { } data ? [data] : [];
        return Dispatch(() => _bus.Emit(eventId, args));
    }

    internal int CancelOwned(string? owner)
    {
        RefuseInHostEvents("CancelOwned");
        return _bus.CancelOwned(owner);
    }

    internal JsonElement DeclareEvent(JsonElement entry)
    {
        RefuseInHostEvents("DeclareEvent");
        return _bus.Declare(entry);
    }


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
                dataArg = JsonElementToJsValue(JsonSerializer.SerializeToElement(bindings), $"hooks.fragment.{lifecycle}");

            var result = _internals.FireFragmentHandlers(key, dataArg);

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
                    var op = SandboxInternals.Own(opObj, "op").AsString();
                    var selector = SandboxInternals.Own(opObj, "selector").AsString();
                    var value = SandboxInternals.HasOwn(opObj, "value")
                        ? Fragments.PropValue.FromJson(
                            System.Text.Json.Nodes.JsonNode.Parse(
                                JsValueToJsonElement(opObj.Get("value"), $"hooks.fragment.{lifecycle}").GetRawText()))
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
        var value = SandboxInternals.Own(obj, key);
        return value.IsUndefined() || value.IsNull() ? null : value.AsString();
    }

    internal void SetExportOwner(string? owner) =>
        _internals.SetExportOwner(owner ?? string.Empty);

    /// <summary>The one mod whose namespace holds export <paramref name="name"/>, or null for none, several, or the host's.</summary>
    private string? SoleExportOwner(string name)
    {
        try
        {
            if (_internals.OwnersOf(name) is ObjectInstance owners
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

        var ownerValue = owner is null ? JsValue.Undefined : new JsString(owner);

        bool registered;
        try
        {
            registered = _internals.HasExport(name, ownerValue);
        }
        catch
        {
            registered = false;
        }

        if (!registered)
            throw new InvokeException(name, $"export '{name}' not found");

        using var caller = Caller.Enter(owner ?? SoleExportOwner(name));
        JsValue argsValue = ArgumentsToJs(args, name);

        using var budget = BeginCallBudget(timeoutOverrideMs);
        var depth = Caller.Depth;
        try
        {
            var outcome = _internals.InvokeExport(name, argsValue, ownerValue);
            _engine.Advanced.ProcessTasks();
            if (outcome.Get("failed").AsBoolean())
            {
                var errVal = outcome.Get("message");
                throw new InvokeException(name, errVal.IsString() ? errVal.AsString() : errVal.ToString());
            }
            var value = outcome.Get("value");
            if (value.IsPromise())
            {
                var (state, settled) = Settle(value);
                if (state == PromiseState.Pending)
                    throw new InvokeException(name, PendingPromise($"export '{name}'"));
                if (state == PromiseState.Rejected)
                {
                    var (_, message) = CallbackScope.Describe(settled);
                    throw new InvokeException(name, message);
                }
                value = settled;
            }
            return JsValueToJsonElement(value, name);
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
    }

    /// <summary>
    /// Calls a retained callback between script calls, on a fresh execution budget. A budget stop
    /// fails this one call with <c>limit</c> and leaves the runtime usable.
    /// </summary>
    internal JsonElement InvokeRetainedFresh(JsValue function, JsonElement[] args, string binding)
    {
        if (_cancellation.IsCancellationRequested)
            throw new ExecutionCancelledException();

        var jsArgs = args.Select(arg => JsonElementToJsValue(arg, binding)).ToArray();
        using (var budget = BeginCallBudget(null))
        {
            try
            {
                var result = _engine.Invoke(function, JsValue.Undefined, jsArgs);
                if (CallbackScope.IsThenable(result))
                    throw new CallbackException(binding, "promise");
                return JsValueToJsonElement(result, binding);
            }
            catch (JavaScriptException ex)
            {
                var (name, message) = CallbackScope.Describe(ex.Error);
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
    }

    public void Dispose()
    {
        Retained.ReleaseAll();
        _engine.Dispose();
        _constraintLifetime.Dispose();
    }

    private void RemoveDangerousGlobals()
    {
        _engine.Execute("""
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

    /// <summary>
    /// Installs <c>console</c>. Each method formats its arguments with
    /// <see cref="Crossing.ConsoleMessage"/> and hands the text to the host's handler. It never
    /// throws: an argument that cannot be read renders as unreadable, and a handler that throws
    /// is contained. An execution-limit stop while reading still ends the script.
    /// </summary>
    private void RegisterConsole(ConsoleHandler console)
    {
        var target = new JsObject(_engine);
        foreach (var (name, severity) in new[]
        {
            ("trace", LogSeverity.Trace), ("debug", LogSeverity.Debug), ("log", LogSeverity.Info),
            ("info", LogSeverity.Info), ("warn", LogSeverity.Warn), ("error", LogSeverity.Error),
        })
        {
            SandboxInternals.Put(target, name, new Jint.Runtime.Interop.ClrFunction(_engine, name, (_, arguments) =>
            {
                var message = _crossing.ConsoleMessage(arguments);
                try
                {
                    console.Dispatch(severity, message);
                }
                catch (Exception error) when (!CallbackScope.IsBudgetStop(error))
                {
                }
                return JsValue.Undefined;
            }));
        }
        _internals.Freeze(target);
        SandboxInternals.Put(_engine.Global, "console", target);
    }

    private void RegisterBindings(HostBindings hostBindings, HashSet<string> granted, Action<AuditEvent>? audit)
    {
        _internals.InstallProbe(Presence.ProvidedPaths(_manifest.Bindings, hostBindings));
        if (_manifest.Bindings is null) return;

        foreach (var (name, bindingElement) in _manifest.Bindings)
        {
            var node = hostBindings.NodeAt([name]);
            if (Presence.IsOptional(bindingElement) && !Presence.Supplies(bindingElement, node))
                SandboxInternals.Put(_engine.Global, name, JsValue.Undefined);
            else if (Presence.AccessorMode(bindingElement) is not null)
                RegisterAccessor(_engine.Global, name, name, bindingElement, node, granted, audit);
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
        if (TryGetCapability(def, out var capability) && !Capabilities.GrantedSatisfies(granted, capability))
        {
            SandboxInternals.Put(_engine.Global, name, _internals.DeniedFunction(name, capability));
            return;
        }

        var hostFn = hostBindings.GetFunction(name)
            ?? (hostBindings.GetCallerFunction(name) is { } aware ? CallerAware(aware, name) : null);
        if (hostFn is null)
        {
            SandboxInternals.Put(_engine.Global, name, _internals.MissingFunction(name));
            return;
        }

        var declaredCapability = TryGetCapability(def, out var cap) ? cap : null;
        SandboxInternals.Put(_engine.Global, name, BridgedFunction(hostFn, name, declaredCapability, audit, def));
    }

    private static readonly JsonElement JsonNull = JsonDocument.Parse("null").RootElement.Clone();

    /// <summary>
    /// Defines an accessor binding on <paramref name="target"/>. The getter and setter are
    /// the ordinary bridged binding wrappers, so each access is capability-gated, audited,
    /// budgeted, and error-marshalled exactly as a function call.
    /// </summary>
    private void RegisterAccessor(
        ObjectInstance target,
        string key,
        string qualifiedName,
        JsonElement def,
        HostNamespaceMember? hostMember,
        HashSet<string> granted,
        Action<AuditEvent>? audit)
    {
        var accessor = Presence.Supplies(def, hostMember) ? hostMember!.Accessor : null;
        var getter = AccessorHalf(accessor is null ? null : _ => accessor.Get(), qualifiedName, def, granted, audit);

        var setter = JsValue.Undefined;
        if (Presence.AccessorMode(def) == "get-set")
        {
            HostFunction? set = accessor?.Set is { } hostSet
                ? args =>
                {
                    hostSet(args.Length > 0 ? args[0] : JsonNull);
                    return JsonNull;
                }
                : null;
            setter = AccessorHalf(set, qualifiedName, def, granted, audit);
        }

        _internals.DefineAccessor(target, key, getter, setter, qualifiedName);
    }

    private JsValue AccessorHalf(
        HostFunction? hostFn, string qualifiedName, JsonElement def, HashSet<string> granted, Action<AuditEvent>? audit)
    {
        if (TryGetCapability(def, out var capability) && !Capabilities.GrantedSatisfies(granted, capability))
            return _internals.DeniedFunction(qualifiedName, capability);
        if (hostFn is null)
            return _internals.MissingFunction(qualifiedName);
        return BridgedFunction(hostFn, qualifiedName, TryGetCapability(def, out var cap) ? cap : null, audit, def);
    }

    private void RegisterNamespaceBinding(
        string name, JsonElement def, HostBindings hostBindings, HashSet<string> granted, Action<AuditEvent>? audit)
    {
        var root = new JsObject(_engine);
        SandboxInternals.Put(_engine.Global, name, root);

        var hostNs = hostBindings.GetNestedNamespace(name);
        var members = def.GetProperty("members");

        RegisterNamespaceMembers(root, name, members, hostNs, granted, audit);

        _internals.DeepFreeze(root);
    }

    private void RegisterNamespaceMembers(
        ObjectInstance target,
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

            HostNamespaceMember? hostMember = null;
            hostNs?.TryGetValue(memberName, out hostMember);

            if (Presence.IsOptional(memberDef) && !Presence.Supplies(memberDef, hostMember))
            {
                SandboxInternals.Put(target, memberName, JsValue.Undefined);
                continue;
            }

            if (Presence.AccessorMode(memberDef) is not null)
            {
                RegisterAccessor(target, memberName, qualifiedName, memberDef, hostMember, granted, audit);
                continue;
            }

            if (IsNamespace(memberDef))
            {
                var child = new JsObject(_engine);
                SandboxInternals.Put(target, memberName, child);
                var childHostNs = hostMember?.Namespace;
                RegisterNamespaceMembers(
                    child, qualifiedName, memberDef.GetProperty("members"), childHostNs, granted, audit);
                continue;
            }

            if (TryGetCapability(memberDef, out var capability) && !Capabilities.GrantedSatisfies(granted, capability))
            {
                SandboxInternals.Put(target, memberName, _internals.DeniedFunction(qualifiedName, capability));
                continue;
            }

            if (hostMember?.Property is { } prop)
            {
                SandboxInternals.Put(target, memberName, JsonElementToJsValue(prop, qualifiedName));
                continue;
            }

            var hostFn = hostMember?.Function
                ?? (hostMember?.CallerFunction is { } aware ? CallerAware(aware, qualifiedName) : null);
            if (hostFn is null)
            {
                SandboxInternals.Put(target, memberName, _internals.MissingFunction(qualifiedName));
                continue;
            }

            var declaredCapability = TryGetCapability(memberDef, out var cap) ? cap : null;
            SandboxInternals.Put(target, memberName, BridgedFunction(hostFn, qualifiedName, declaredCapability, audit, memberDef));
        }
    }

    /// <summary>
    /// The envelope a bridge hands back to its sandbox side, which turns it into the call's
    /// outcome: a value (0), a host error (1), a <c>BindingError</c> for a value that could not
    /// cross (2), or a script error (a throwing getter's) rethrown as itself (3).
    /// </summary>
    private JsObject Envelope(int kind, JsValue? value = null, string? message = null, string? binding = null)
    {
        var envelope = new JsObject(_engine);
        SandboxInternals.Put(envelope, "kind", kind);
        if (value is not null) SandboxInternals.Put(envelope, "value", value);
        if (message is not null) SandboxInternals.Put(envelope, "message", message);
        if (binding is not null) SandboxInternals.Put(envelope, "binding", binding);
        return envelope;
    }

    private JsObject CrossingFailure(ValueCrossingException failure) =>
        Envelope(2, message: failure.Detail, binding: failure.Binding);

    /// <summary>
    /// A bridged binding: its sandbox side refuses a non-function where the manifest declares a
    /// function parameter, then hands the arguments to the host bridge.
    /// </summary>
    private JsValue BridgedFunction(
        HostFunction hostFn, string binding, string? capability, Action<AuditEvent>? audit, JsonElement def)
    {
        var checks = FunctionParamCheck.For(def).Select(check =>
        {
            var entry = new JsObject(_engine);
            SandboxInternals.Put(entry, "index", check.Index);
            SandboxInternals.Put(entry, "name", check.Name);
            SandboxInternals.Put(entry, "optional", check.Optional);
            return (JsValue)entry;
        }).ToArray();
        var positions = RetainPositions.For(def, _manifest.Types);
        var bridge = JsValue.FromObject(_engine, CreateBridge(hostFn, binding, capability, audit, positions));
        return _internals.Bridge(bridge, new JsArray(_engine, checks), binding);
    }

    private Func<JsValue, JsValue> CreateBridge(
        HostFunction hostFn, string binding, string? capability, Action<AuditEvent>? audit, RetainPositions positions)
    {
        return argsValue =>
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

            using var scope = new CallbackScope(
                _engine, binding, JsonElementToJsValue, JsValueToJsonElement, positions, Retained);
            JsonElement[] args;
            try
            {
                var array = argsValue.AsObject();
                args = new JsonElement[(int)array.Get("length").AsNumber()];
                for (var i = 0; i < args.Length; i++)
                    args[i] = _crossing.ToHost(array.Get(i.ToString()), binding, scope.Add, [i]);
            }
            catch (ValueCrossingException failure)
            {
                return CrossingFailure(failure);
            }
            catch (JavaScriptException thrown)
            {
                return Envelope(3, thrown.Error);
            }

            try
            {
                var result = hostFn(args);
                scope.Settle(null);
                return Envelope(0, JsonElementToJsValue(result, binding));
            }
            catch (Exception ex)
            {
                scope.Settle(ex);
                return ex is ValueCrossingException failure ? CrossingFailure(failure) : Envelope(1, message: ex.Message);
            }
        };
    }

    private static double NowMs() =>
        (DateTime.UtcNow - EpochStart).TotalMilliseconds;

    private void RegisterHooks(ObjectInstance hooks, HashSet<string> granted)
    {
        var effectiveHooks = _manifest.EffectiveHooks();
        if (effectiveHooks.Count == 0) return;

        var phasedNamespaces = new List<JsObject>();

        foreach (var (hookName, hookDef) in effectiveHooks)
        {
            var denied = hookDef.Capability is { } cap && !Capabilities.GrantedSatisfies(granted, cap) ? cap : null;
            if (hookDef.Phases is { Count: > 0 } phases)
            {
                var hookNs = new JsObject(_engine);
                SandboxInternals.Put(hooks, hookName, hookNs);
                phasedNamespaces.Add(hookNs);
                foreach (var phase in phases)
                {
                    SandboxInternals.Put(hookNs, phase, denied is null
                        ? _internals.RegisteringFunction($"{hookName}:{phase}")
                        : _internals.DeniedFunction($"hooks.{hookName}.{phase}", denied));
                }
            }
            else
            {
                SandboxInternals.Put(hooks, hookName, denied is null
                    ? _internals.RegisteringFunction(hookName)
                    : _internals.DeniedFunction($"hooks.{hookName}", denied));
            }
        }

        _internals.Freeze(hooks);
        foreach (var hookNs in phasedNamespaces)
            _internals.Freeze(hookNs);
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

    /// <summary>A script value crossing out to the host; <paramref name="binding"/> names the crossing in a failure.</summary>
    private JsonElement JsValueToJsonElement(JsValue value, string binding)
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
            return JsonDocument.Parse(Crossing.NumberText(num)).RootElement.Clone();
        }

        if (value.IsString() && JsonText.IsWellFormed(value.AsString()))
            return JsonDocument.Parse(JsonSerializer.Serialize(value.AsString())).RootElement.Clone();

        return _crossing.ToHost(value, binding);
    }

    /// <summary>A host value crossing into the sandbox; <paramref name="binding"/> names the crossing in a failure.</summary>
    private JsValue JsonElementToJsValue(JsonElement element, string binding) => _crossing.Decode(element, binding);

    /// <summary>A sandbox array of host values, each crossing in under <paramref name="binding"/>.</summary>
    private JsArray ArgumentsToJs(JsonElement[] args, string binding) =>
        new(_engine, args.Select(arg => _crossing.Decode(arg, binding)).ToArray());

    private enum PromiseState { Pending, Fulfilled, Rejected }

    /// <summary>
    /// How a promise a script returned has settled once the job queue has run. Scripts run
    /// synchronously here, so a promise still pending then can never settle before the host
    /// needs the value.
    /// </summary>
    private (PromiseState State, JsValue Value) Settle(JsValue promise)
    {
        var box = new JsObject(_engine);
        _engine.Call(_promiseObserver, JsValue.Undefined, [promise, box]);
        _engine.Advanced.ProcessTasks();
        var state = box.Get("state");
        return (state.IsNumber() ? (PromiseState)(int)state.AsNumber() : PromiseState.Pending, box.Get("value"));
    }

    private static string PendingPromise(string surface) =>
        $"{surface} returned a promise that is still pending; the C# runtime runs scripts synchronously and cannot await one, so settle it within the call or return a settled value";
}
