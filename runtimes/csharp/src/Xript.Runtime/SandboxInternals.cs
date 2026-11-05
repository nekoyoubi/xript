using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime.Descriptors;
using Jint.Runtime.Interop;

namespace Xript.Runtime;

/// <summary>
/// The runtime's sandbox-side machinery: the hook, fragment and export registries, the export
/// owner, and the helpers that install bindings and seal the globals. It lives in closures on one
/// prototype-free object only the host holds, so no script can read, replace, or empty any of it.
/// Every built-in it calls is captured when it installs, before any script runs, so a script that
/// later replaces one changes nothing the runtime does. Names always reach it as arguments, never
/// spliced into source.
/// </summary>
internal sealed class SandboxInternals
{
    private const string Source = """
        (function (callerCurrent, callerEnter, callerExit) {
            "use strict";
            var reflectApply = Reflect.apply;
            var defineProperty = Object.defineProperty;
            var getOwnPropertyNames = Object.getOwnPropertyNames;
            var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
            var objectKeys = Object.keys;
            var objectCreate = Object.create;
            var objectFreeze = Object.freeze;
            var isFrozen = Object.isFrozen;
            var isArray = Array.isArray;
            var hasOwnProperty = Object.prototype.hasOwnProperty;
            var ErrorCtor = Error;
            var TypeErrorCtor = TypeError;
            var globalObject = globalThis;

            function owns(target, key) {
                return reflectApply(hasOwnProperty, target, [key]);
            }
            function define(target, key, value, writable, configurable) {
                var descriptor = objectCreate(null);
                descriptor.value = value;
                descriptor.writable = writable;
                descriptor.enumerable = true;
                descriptor.configurable = configurable;
                defineProperty(target, key, descriptor);
            }
            function put(target, key, value) {
                define(target, key, value, true, true);
            }
            function append(list, value) {
                put(list, list.length, value);
            }
            function deepFreeze(obj) {
                if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return obj;
                var keys = getOwnPropertyNames(obj);
                for (var i = 0; i < keys.length; i++) {
                    var descriptor = getOwnPropertyDescriptor(obj, keys[i]);
                    var value = descriptor && owns(descriptor, "value") ? descriptor.value : undefined;
                    if (value !== null && typeof value === "object" && !isFrozen(value)) deepFreeze(value);
                }
                return objectFreeze(obj);
            }

            var handlersByKey = objectCreate(null);
            function registerHandler(key, handler) {
                var list = handlersByKey[key];
                if (list === undefined) {
                    list = [];
                    put(handlersByKey, key, list);
                }
                var entry = objectCreate(null);
                entry.handler = handler;
                entry.owner = callerCurrent();
                append(list, entry);
            }
            function fireHandlers(key, data) {
                var results = [];
                var handlers = handlersByKey[key];
                if (handlers === undefined) return results;
                var args = [];
                if (typeof data === "object" && data !== null && !isArray(data)) {
                    var keys = objectKeys(data);
                    for (var k = 0; k < keys.length; k++) append(args, data[keys[k]]);
                } else if (data !== undefined) {
                    append(args, data);
                }
                for (var i = 0; i < handlers.length; i++) {
                    var entry = handlers[i];
                    callerEnter(entry.owner);
                    try {
                        append(results, reflectApply(entry.handler, null, args));
                    } catch (e) {
                        append(results, undefined);
                    } finally {
                        callerExit();
                    }
                }
                return results;
            }
            function registeringFunction(key) {
                return function (handler) { registerHandler(key, handler); };
            }
            class BindingError extends ErrorCtor {
                constructor(binding, message) {
                    super(binding + "(): " + message);
                    put(this, "name", "BindingError");
                    put(this, "binding", binding);
                }
            }
            class CapabilityDeniedError extends ErrorCtor {
                constructor(binding, capability) {
                    super(binding + "() requires the \"" + capability + "\" capability, which hasn't been granted to this script. Ask the app developer to enable it.");
                    put(this, "name", "CapabilityDeniedError");
                    put(this, "capability", capability);
                    put(this, "binding", binding);
                }
            }
            var stringIndexOf = String.prototype.indexOf;
            var stringSlice = String.prototype.slice;
            function bindingError(binding, message) {
                var text = typeof message === "string" ? message : "";
                var prefix = binding + "(): ";
                if (reflectApply(stringIndexOf, text, [prefix]) === 0) text = reflectApply(stringSlice, text, [prefix.length]);
                return new BindingError(binding, text);
            }
            function deniedFunction(binding, capability) {
                return function () { throw new CapabilityDeniedError(binding, capability); };
            }
            function missingFunction(binding) {
                return function () { throw new BindingError(binding, "not implemented by the app"); };
            }
            function installErrorClasses() {
                put(globalObject, "BindingError", BindingError);
                put(globalObject, "CapabilityDeniedError", CapabilityDeniedError);
            }

            var fragmentHandlers = objectCreate(null);
            function registerFragmentHandler(key, handler) {
                var list = fragmentHandlers[key];
                if (list === undefined) {
                    list = [];
                    put(fragmentHandlers, key, list);
                }
                append(list, handler);
            }
            function fireFragmentHandlers(key, data) {
                var allOps = [];
                var handlers = fragmentHandlers[key];
                if (handlers === undefined) return allOps;
                for (var i = 0; i < handlers.length; i++) {
                    var ops = [];
                    var proxy = {
                        toggle: function (selector, condition) { append(ops, { op: "toggle", selector: selector, value: !!condition }); },
                        addClass: function (selector, className) { append(ops, { op: "addClass", selector: selector, value: className }); },
                        removeClass: function (selector, className) { append(ops, { op: "removeClass", selector: selector, value: className }); },
                        setText: function (selector, text) { append(ops, { op: "setText", selector: selector, value: text }); },
                        setAttr: function (selector, attr, value) { append(ops, { op: "setAttr", selector: selector, attr: attr, value: value }); },
                        removeAttr: function (selector, attr) { append(ops, { op: "removeAttr", selector: selector, attr: attr }); },
                        setProp: function (selector, prop, value) { append(ops, { op: "setProp", selector: selector, prop: prop, value: value }); },
                        replaceChildren: function (selector, html) { append(ops, { op: "replaceChildren", selector: selector, value: html }); }
                    };
                    try {
                        reflectApply(handlers[i], undefined, [data, proxy]);
                        for (var j = 0; j < ops.length; j++) append(allOps, ops[j]);
                    } catch (e) {}
                }
                return allOps;
            }
            function fragmentRegistrar(lifecycle) {
                return function (fragmentId, handler) {
                    registerFragmentHandler("fragment:" + lifecycle + ":" + fragmentId, handler);
                };
            }
            function installHooks() {
                var fragment = {};
                put(fragment, "mount", fragmentRegistrar("mount"));
                put(fragment, "unmount", fragmentRegistrar("unmount"));
                put(fragment, "update", fragmentRegistrar("update"));
                put(fragment, "suspend", fragmentRegistrar("suspend"));
                put(fragment, "resume", fragmentRegistrar("resume"));
                objectFreeze(fragment);
                var hooks = {};
                put(hooks, "fragment", fragment);
                put(globalObject, "hooks", hooks);
                return hooks;
            }

            var exportsByOwner = objectCreate(null);
            put(exportsByOwner, "", objectCreate(null));
            var exportOwner = "";
            function setExportOwner(owner) {
                var key = typeof owner === "string" ? owner : "";
                exportOwner = key;
                if (!owns(exportsByOwner, key)) put(exportsByOwner, key, objectCreate(null));
                return key;
            }
            function exportIn(bucket, name) {
                return bucket !== undefined && owns(bucket, name) ? bucket[name] : undefined;
            }
            function ownersOf(name) {
                var owners = [];
                var keys = objectKeys(exportsByOwner);
                for (var i = 0; i < keys.length; i++) {
                    if (typeof exportIn(exportsByOwner[keys[i]], name) === "function") append(owners, keys[i]);
                }
                return owners;
            }
            function lookupExport(name, owner) {
                if (typeof owner === "string") return exportIn(exportsByOwner[owner], name);
                var owners = ownersOf(name);
                return owners.length === 1 ? exportIn(exportsByOwner[owners[0]], name) : undefined;
            }
            function hasExport(name, owner) {
                return typeof lookupExport(name, owner) === "function";
            }
            function invokeExport(name, args, owner) {
                var outcome = objectCreate(null);
                var fn = lookupExport(name, owner);
                if (typeof fn !== "function") {
                    outcome.failed = true;
                    outcome.message = "export '" + name + "' not found";
                    return outcome;
                }
                try {
                    outcome.value = reflectApply(fn, null, args);
                    outcome.failed = false;
                } catch (e) {
                    outcome.failed = true;
                    outcome.message = (e && e.message) ? e.message : String(e);
                }
                return outcome;
            }
            function harvest(name, value) {
                var bucket = exportsByOwner[exportOwner];
                if (!owns(bucket, name)) put(bucket, name, value);
            }
            var exportsApi = {};
            put(exportsApi, "register", function register(name, fn) {
                if (typeof name !== "string" || name.length === 0) {
                    throw new ErrorCtor("xript.exports.register requires a non-empty string name");
                }
                if (typeof fn !== "function") {
                    throw new ErrorCtor("xript.exports.register requires a function");
                }
                put(exportsByOwner[exportOwner], name, fn);
            });
            objectFreeze(exportsApi);

            function xriptNamespace() {
                var ns = globalObject.xript;
                if (ns === null || typeof ns !== "object") {
                    ns = {};
                    put(globalObject, "xript", ns);
                }
                return ns;
            }
            function installProbe(paths) {
                var known = objectCreate(null);
                for (var i = 0; i < paths.length; i++) put(known, paths[i], true);
                var has = function has(path) { return typeof path === "string" && owns(known, path); };
                define(xriptNamespace(), "has", has, false, false);
            }
            function installExports() {
                put(xriptNamespace(), "exports", exportsApi);
            }

            function bridge(call, checks, name) {
                return function () {
                    var args = [];
                    for (var a = 0; a < arguments.length; a++) append(args, arguments[a]);
                    for (var i = 0; i < checks.length; i++) {
                        var check = checks[i];
                        var value = args[check.index];
                        if (typeof value === "function") continue;
                        if (check.optional && (value === undefined || value === null)) continue;
                        throw new TypeErrorCtor(name + '(): parameter "' + check.name + '" expects a function, got ' + (value === null ? "null" : typeof value));
                    }
                    var envelope = call(args);
                    switch (envelope.kind) {
                        case 0: return envelope.value;
                        case 1: throw bindingError(name, envelope.message);
                        case 2: throw bindingError(envelope.binding, envelope.message);
                        default: throw envelope.value;
                    }
                };
            }
            function defineAccessor(target, key, get, set, name) {
                var descriptor = objectCreate(null);
                descriptor.get = function () { return get(); };
                descriptor.set = set
                    ? function (value) { set(value); }
                    : function () { throw new TypeErrorCtor(name + " is read-only: the host declares no setter"); };
                descriptor.enumerable = true;
                descriptor.configurable = false;
                defineProperty(target, key, descriptor);
            }

            function seal(names, frozenNames) {
                var frozen = objectCreate(null);
                for (var f = 0; f < frozenNames.length; f++) put(frozen, frozenNames[f], true);
                for (var i = 0; i < names.length; i++) {
                    var name = names[i];
                    var current = getOwnPropertyDescriptor(globalObject, name);
                    if (current === undefined) continue;
                    var isData = owns(current, "value");
                    if (current.configurable || (isData && current.writable)) {
                        var next = objectCreate(null);
                        if (isData) {
                            next.value = current.value;
                            next.writable = false;
                        } else {
                            next.get = current.get;
                            next.set = current.set;
                        }
                        next.enumerable = current.enumerable;
                        next.configurable = false;
                        defineProperty(globalObject, name, next);
                    }
                    if (isData && owns(frozen, name)) {
                        deepFreeze(current.value);
                        if (typeof current.value === "function" && current.value.prototype) objectFreeze(current.value.prototype);
                    }
                }
            }

            var internals = objectCreate(null);
            put(internals, "freeze", objectFreeze);
            put(internals, "deepFreeze", deepFreeze);
            put(internals, "registeringFunction", registeringFunction);
            put(internals, "deniedFunction", deniedFunction);
            put(internals, "missingFunction", missingFunction);
            put(internals, "installErrorClasses", installErrorClasses);
            put(internals, "fireHandlers", fireHandlers);
            put(internals, "fireFragmentHandlers", fireFragmentHandlers);
            put(internals, "installHooks", installHooks);
            put(internals, "setExportOwner", setExportOwner);
            put(internals, "ownersOf", ownersOf);
            put(internals, "hasExport", hasExport);
            put(internals, "invokeExport", invokeExport);
            put(internals, "harvest", harvest);
            put(internals, "installProbe", installProbe);
            put(internals, "installExports", installExports);
            put(internals, "bridge", bridge);
            put(internals, "defineAccessor", defineAccessor);
            put(internals, "seal", seal);
            return objectFreeze(internals);
        })
        """;

    private readonly Engine _engine;
    private readonly ObjectInstance _internals;
    private readonly JsValue _fireHandlers;
    private readonly JsValue _fireFragmentHandlers;
    private readonly JsValue _setExportOwner;
    private readonly JsValue _ownersOf;
    private readonly JsValue _hasExport;
    private readonly JsValue _invokeExport;
    private readonly JsValue _harvest;

    /// <summary>Installs the machinery; must run before any script does.</summary>
    internal SandboxInternals(Engine engine, CallerContext caller)
    {
        _engine = engine;
        var current = new ClrFunction(engine, "current", (_, _) =>
            caller.Current is { } owner ? new JsString(owner) : JsValue.Null);
        var enter = new ClrFunction(engine, "enter", (_, args) =>
        {
            caller.Push(args.Length > 0 && args[0].IsString() ? args[0].AsString() : null);
            return JsValue.Undefined;
        });
        var exit = new ClrFunction(engine, "exit", (_, _) =>
        {
            caller.Pop();
            return JsValue.Undefined;
        });
        var factory = engine.Evaluate(Source, "xript-internals.js");
        _internals = engine.Invoke(factory, current, enter, exit).AsObject();
        _fireHandlers = _internals.Get("fireHandlers");
        _fireFragmentHandlers = _internals.Get("fireFragmentHandlers");
        _setExportOwner = _internals.Get("setExportOwner");
        _ownersOf = _internals.Get("ownersOf");
        _hasExport = _internals.Get("hasExport");
        _invokeExport = _internals.Get("invokeExport");
        _harvest = _internals.Get("harvest");
    }

    /// <summary>
    /// Defines <paramref name="key"/> on <paramref name="target"/> as an ordinary writable data
    /// property. Unlike an assignment it never reaches a setter, so <c>__proto__</c> lands as a
    /// property rather than a prototype, and a setter a script put on <c>Object.prototype</c> is
    /// never handed the value.
    /// </summary>
    internal static void Put(ObjectInstance target, JsValue key, JsValue value) =>
        target.DefineOwnProperty(key, new PropertyDescriptor(value, PropertyFlag.ConfigurableEnumerableWritable));

    /// <summary>An own property's value, or <c>undefined</c>; never reads through the prototype chain.</summary>
    internal static JsValue Own(ObjectInstance target, string key) =>
        target.GetOwnProperty(key) is { } descriptor && descriptor != PropertyDescriptor.Undefined
            ? target.Get(key)
            : JsValue.Undefined;

    /// <summary>Whether <paramref name="target"/> has <paramref name="key"/> as an own property.</summary>
    internal static bool HasOwn(ObjectInstance target, string key) =>
        target.GetOwnProperty(key) is { } descriptor && descriptor != PropertyDescriptor.Undefined;

    private JsValue Call(JsValue function, params JsValue[] args)
    {
        var items = new object?[args.Length];
        Array.Copy(args, items, args.Length);
        return _engine.Invoke(function, items);
    }

    private JsValue Call(string member, params JsValue[] args) => Call(_internals.Get(member), args);

    internal JsValue Freeze(JsValue target) => Call("freeze", target);

    internal JsValue DeepFreeze(JsValue target) => Call("deepFreeze", target);

    /// <summary>A sandbox function that registers its handler argument under <paramref name="key"/>, owned by the mod running at registration.</summary>
    internal JsValue RegisteringFunction(string key) => Call("registeringFunction", key);

    /// <summary>A sandbox function that throws <c>CapabilityDeniedError(binding, capability)</c>, for a binding the script was not granted.</summary>
    internal JsValue DeniedFunction(string binding, string capability) => Call("deniedFunction", binding, capability);

    /// <summary>A sandbox function that throws a <c>BindingError</c>, for a binding the host did not supply.</summary>
    internal JsValue MissingFunction(string binding) => Call("missingFunction", binding);

    /// <summary>
    /// Defines the <c>BindingError</c> and <c>CapabilityDeniedError</c> globals as the classes every
    /// error a binding throws is built from, so <c>instanceof</c> holds. Sealing locks them later.
    /// </summary>
    internal void InstallErrorClasses() => Call("installErrorClasses");

    /// <summary>Calls every handler under <paramref name="key"/>, each as its owning mod, and returns their results.</summary>
    internal JsValue FireHandlers(string key, JsValue data) => Call(_fireHandlers, key, data);

    internal JsValue FireFragmentHandlers(string key, JsValue data) => Call(_fireFragmentHandlers, key, data);

    /// <summary>Defines the <c>hooks</c> global holding <c>hooks.fragment</c> and returns it.</summary>
    internal ObjectInstance InstallHooks() => Call("installHooks").AsObject();

    /// <summary>Sets which mod's namespace export registrations land in; only the host can.</summary>
    internal void SetExportOwner(string owner) => Call(_setExportOwner, owner);

    internal JsValue OwnersOf(string name) => Call(_ownersOf, name);

    internal bool HasExport(string name, JsValue owner) => Call(_hasExport, name, owner).AsBoolean();

    /// <summary>
    /// Calls an export. The outcome is a prototype-free object: <c>failed</c>, then <c>value</c>
    /// on success or <c>message</c> on failure.
    /// </summary>
    internal ObjectInstance InvokeExport(string name, JsValue args, JsValue owner) =>
        Call(_invokeExport, name, args, owner).AsObject();

    /// <summary>Adds a module's named export to the current owner's namespace unless one by that name is there already.</summary>
    internal void Harvest(string name, JsValue value) => Call(_harvest, name, value);

    /// <summary>Defines <c>xript.has(path)</c>, answering from a fixed set of provided paths held in a closure.</summary>
    internal void InstallProbe(IReadOnlyList<string> paths) =>
        Call("installProbe", new JsArray(_engine, paths.Select(path => (JsValue)new JsString(path)).ToArray()));

    internal void InstallExports() => Call("installExports");

    /// <summary>The sandbox side of a bridged binding, built around the host <paramref name="call"/>.</summary>
    internal JsValue Bridge(JsValue call, JsValue checks, string name) => Call("bridge", call, checks, name);

    /// <summary>
    /// Defines an accessor binding on a sandbox object. Without a setter, assignment throws a
    /// <c>TypeError</c> in strict and sloppy code alike.
    /// </summary>
    internal void DefineAccessor(ObjectInstance target, string key, JsValue get, JsValue set, string name) =>
        Call("defineAccessor", target, key, get, set, name);

    /// <summary>
    /// Locks each of <paramref name="names"/> present on <c>globalThis</c> as a non-writable,
    /// non-configurable property (an accessor keeps its get and set), and deep-freezes those also
    /// in <paramref name="frozen"/>.
    /// </summary>
    internal void Seal(IEnumerable<string> names, IEnumerable<string> frozen) =>
        Call("seal", Strings(names), Strings(frozen));

    private JsArray Strings(IEnumerable<string> values) =>
        new(_engine, values.Select(value => (JsValue)new JsString(value)).ToArray());
}
