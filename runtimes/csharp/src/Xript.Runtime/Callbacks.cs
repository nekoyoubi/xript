using System.Collections.Concurrent;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime;

namespace Xript.Runtime;

/// <summary>
/// A script function passed to the binding currently running. A host binding receives its
/// arguments as JSON, so wherever a script function appears (top level, object field, array
/// element, any depth) the host finds a marker object, <c>{ "$xriptCallback": "&lt;token&gt;" }</c>,
/// and resolves it with <see cref="From"/>. The callback is valid only while the binding call
/// that received it is running, and only on the thread running it.
/// </summary>
public sealed class XriptCallback
{
    /// <summary>The key of the marker object that stands in for a script function.</summary>
    public const string Marker = "$xriptCallback";

    private readonly long _scope;
    private readonly int _index;
    private readonly long _nonce;

    /// <summary>The binding this callback was passed to.</summary>
    public string Binding { get; }

    private XriptCallback(long scope, int index, long nonce, string binding)
    {
        _scope = scope;
        _index = index;
        _nonce = nonce;
        Binding = binding;
    }

    /// <summary>
    /// Resolves a marker object, or returns null for anything that is not a marker the runtime
    /// itself produced for a live callback. A token the script spelled into plain data cannot
    /// carry a live scope's random nonce, so it resolves to nothing, exactly as the same data
    /// shape is inert in the runtimes that pass functions directly.
    /// </summary>
    public static XriptCallback? From(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return null;
        var count = 0;
        string? token = null;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (property.Name == Marker && property.Value.ValueKind == JsonValueKind.String)
                token = property.Value.GetString();
        }
        if (count != 1 || token is null) return null;

        var parts = token.Split(':', 4);
        if (parts.Length != 4
            || !long.TryParse(parts[0], out var scope)
            || !int.TryParse(parts[1], out var index)
            || !long.TryParse(parts[2], out var nonce))
            return null;
        if (!CallbackScope.IsLive(scope, nonce)) return null;
        return new XriptCallback(scope, index, nonce, parts[3]);
    }

    /// <summary>
    /// Calls the script function with <paramref name="args"/> and returns what it returned, both
    /// marshalled as JSON. Throws <see cref="CallbackException"/> when it cannot.
    /// </summary>
    public JsonElement Invoke(params JsonElement[] args)
    {
        if (!CallbackScope.TryFind(_scope, _nonce, out var scope))
            throw new CallbackException(Binding, "expired");
        return scope.Invoke(_index, args);
    }

    /// <summary>
    /// Keeps the callback past the binding call so the host can call it later. Succeeds only for
    /// a callback at a position the manifest marks <c>"retain": true</c>, or for a script function
    /// this mod already retained, which returns that same retained callback. Throws
    /// <see cref="RetainException"/> when refused and <see cref="CallbackException"/> (expired)
    /// once the binding call has returned.
    /// </summary>
    public RetainedCallback Retain()
    {
        if (!CallbackScope.TryFind(_scope, _nonce, out var scope))
            throw new CallbackException(Binding, "expired");
        return scope.Retain(_index);
    }
}

/// <summary>One binding call's callbacks on the sandbox side.</summary>
internal sealed class CallbackScope : IDisposable
{
    private static readonly ConcurrentDictionary<long, CallbackScope> Live = new();
    private static long _nextId;

    /// <summary>
    /// The process-local key a token's nonce is derived from. A token cannot be forged without
    /// it, and a token this process issued stays recognisable after its call has ended.
    /// </summary>
    private static readonly byte[] TokenKey = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);

    private readonly long _id = Interlocked.Increment(ref _nextId);
    private long? _nonce;

    private long Nonce => _nonce ??= NonceFor(_id);

    private static long NonceFor(long id) =>
        BitConverter.ToInt64(System.Security.Cryptography.HMACSHA256.HashData(TokenKey, BitConverter.GetBytes(id)), 0);
    private readonly int _thread = Environment.CurrentManagedThreadId;
    private readonly Engine _engine;
    private readonly string _binding;
    private readonly List<JsValue> _functions = [];
    private readonly Func<JsonElement, string, JsValue> _toJs;
    private readonly Func<JsValue, string, JsonElement> _toJson;
    private readonly RetainPositions _positions;
    private readonly RetainedRegistry? _registry;
    private readonly List<bool> _retainable = [];
    private readonly List<(CallbackException Error, JsValue Original)> _thrown = [];

    [ThreadStatic]
    private static List<CallbackScope>? _open;

    /// <summary>A budget stop raised inside a callback; the binding call must end with it.</summary>
    internal Exception? Fatal { get; private set; }

    internal CallbackScope(
        Engine engine,
        string binding,
        Func<JsonElement, string, JsValue> toJs,
        Func<JsValue, string, JsonElement> toJson,
        RetainPositions? positions = null,
        RetainedRegistry? registry = null)
    {
        _engine = engine;
        _binding = binding;
        _toJs = toJs;
        _toJson = toJson;
        _positions = positions ?? RetainPositions.None;
        _registry = registry;
        Live[_id] = this;
        (_open ??= []).Add(this);
    }

    /// <summary>The innermost binding call of <paramref name="engine"/> running on this thread, if any.</summary>
    internal static CallbackScope? Innermost(Engine engine)
    {
        if (_open is null) return null;
        for (var i = _open.Count - 1; i >= 0; i--)
        {
            if (ReferenceEquals(_open[i]._engine, engine))
                return _open[i];
        }
        return null;
    }

    internal RetainedCallback Retain(int index)
    {
        if (_registry is null || index < 0 || index >= _functions.Count)
            throw new RetainException(_binding, "undeclared");
        return _registry.Retain(_functions[index], _retainable[index], _binding);
    }

    internal static bool TryFind(long id, long nonce, out CallbackScope scope)
    {
        if (Live.TryGetValue(id, out scope!) && scope._thread == Environment.CurrentManagedThreadId && scope.Nonce == nonce)
            return true;
        scope = null!;
        return false;
    }

    /// <summary>
    /// What a callback marker crossing into the sandbox of <paramref name="engine"/> becomes:
    /// the script's own function while the call it was passed to is running here, <c>undefined</c>
    /// for a token this process issued that no longer resolves (its call ended, or it belongs to
    /// another runtime or thread), and null for anything else, which stays plain data. The token
    /// itself never reaches the script.
    /// </summary>
    internal static JsValue? Revive(string token, Engine engine)
    {
        var parts = token.Split(':', 4);
        if (parts.Length != 4
            || !long.TryParse(parts[0], out var id)
            || !int.TryParse(parts[1], out var index)
            || !long.TryParse(parts[2], out var nonce)
            || nonce != NonceFor(id))
            return null;
        if (TryFind(id, nonce, out var scope) && ReferenceEquals(scope._engine, engine)
            && index >= 0 && index < scope._functions.Count)
            return scope._functions[index];
        return JsValue.Undefined;
    }

    /// <summary>Whether a scope with this id and nonce is live on the calling thread.</summary>
    internal static bool IsLive(long id, long nonce) => TryFind(id, nonce, out _);

    /// <summary>
    /// Takes a script function found at <paramref name="path"/> in the binding's arguments and
    /// returns the token its callback marker carries.
    /// </summary>
    internal string Add(JsValue function, IReadOnlyList<object> path)
    {
        var index = _functions.Count;
        _functions.Add(function);
        _retainable.Add(_positions.Matches(path));
        return $"{_id}:{index}:{Nonce}:{_binding}";
    }

    internal JsonElement Invoke(int index, JsonElement[] args)
    {
        if (index < 0 || index >= _functions.Count)
        {
            if (Fatal is not null)
                throw new CallbackException(_binding, "limit");
            throw new CallbackException(_binding, "expired");
        }
        return InvokeFunction(_functions[index], args, _binding);
    }

    /// <summary>
    /// Calls a script function re-entrantly inside this binding call, on the calling script's
    /// budget. A budget stop becomes the call's fatal outcome and a throw is remembered so a host
    /// that lets it escape rethrows the script's own error; <paramref name="binding"/> names the
    /// binding the function was passed to, in every failure.
    /// </summary>
    internal JsonElement InvokeFunction(JsValue function, JsonElement[] args, string binding)
    {
        if (Fatal is not null)
            throw new CallbackException(binding, "limit");

        var jsArgs = args.Select(arg => _toJs(arg, binding)).ToArray();
        try
        {
            var result = _engine.Call(function, JsValue.Undefined, jsArgs);
            if (IsThenable(result))
                throw new CallbackException(binding, "promise");
            return _toJson(result, binding);
        }
        catch (JavaScriptException ex)
        {
            var (name, message) = Describe(ex.Error);
            var error = new CallbackException(binding, "threw", name, message);
            _thrown.Add((error, ex.Error));
            throw error;
        }
        catch (Exception ex) when (IsBudgetStop(ex))
        {
            Fatal = ex;
            throw new CallbackException(binding, "limit");
        }
    }

    /// <summary>
    /// Ends the binding call the way a callback demands: rethrows a budget stop whatever the host
    /// did, and turns a callback's throw the host let escape back into the script's own error.
    /// Returns normally when the call should end as the host decided.
    /// </summary>
    internal void Settle(Exception? hostError)
    {
        if (Fatal is { } fatal)
            ExceptionDispatchInfo.Capture(fatal).Throw();
        if (hostError is CallbackException callbackError)
        {
            foreach (var (error, original) in _thrown)
            {
                if (ReferenceEquals(error, callbackError))
                    throw new JavaScriptException(original);
            }
        }
    }

    public void Dispose()
    {
        Live.TryRemove(_id, out _);
        _open?.Remove(this);
    }

    internal static bool IsBudgetStop(Exception ex) =>
        ex is ExecutionCanceledException or TimeoutException or MemoryLimitExceededException or RecursionDepthOverflowException;

    internal static bool IsThenable(JsValue value)
    {
        if (value.IsPromise()) return true;
        return value is ObjectInstance obj && obj.Get("then") is { } then && then.IsObject() && then.AsObject() is Jint.Native.Function.Function;
    }

    /// <summary>
    /// The <c>name</c> and message a thrown value reaches the host with, the way the JavaScript
    /// runtimes describe it: an object's own <c>message</c> (a string, or a number or boolean as
    /// its text), <c>callback threw</c> for an object without one, and any other thrown value,
    /// a primitive or a function, as <c>String(value)</c> (<c>42</c>, <c>null</c>, <c>undefined</c>).
    /// </summary>
    internal static (string? Name, string Message) Describe(JsValue error)
    {
        if (error is Jint.Native.Function.Function function)
        {
            try
            {
                return (null, Jint.Runtime.TypeConverter.ToString(function));
            }
            catch (JavaScriptException)
            {
                return (null, "callback threw");
            }
        }
        if (error is ObjectInstance obj)
        {
            var name = obj.Get("name");
            var message = obj.Get("message");
            var text = message.IsString() ? message.AsString()
                : message.IsNumber() || message.IsBoolean() ? Jint.Runtime.TypeConverter.ToString(message)
                : "callback threw";
            return (name.IsString() ? name.AsString() : null, text);
        }
        return (null, error.IsSymbol() ? error.ToString() : Jint.Runtime.TypeConverter.ToString(error));
    }
}

/// <summary>A parameter the manifest declares as a function, checked before the host runs.</summary>
internal sealed record FunctionParamCheck(int Index, string Name, bool Optional)
{
    /// <summary>The parameters of a binding declaration typed <c>function</c>, bare, with a signature, or optional.</summary>
    internal static List<FunctionParamCheck> For(JsonElement bindingDef)
    {
        var checks = new List<FunctionParamCheck>();
        if (bindingDef.ValueKind != JsonValueKind.Object || !bindingDef.TryGetProperty("params", out var parameters)
            || parameters.ValueKind != JsonValueKind.Array)
            return checks;

        var index = 0;
        foreach (var param in parameters.EnumerateArray())
        {
            if (param.ValueKind == JsonValueKind.Object && param.TryGetProperty("type", out var type))
            {
                var name = param.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()! : $"#{index}";
                if (IsFunctionType(type))
                {
                    var optional = (param.TryGetProperty("required", out var required) && required.ValueKind == JsonValueKind.False)
                        || (param.TryGetProperty("optional", out var optionalFlag) && optionalFlag.ValueKind == JsonValueKind.True)
                        || param.TryGetProperty("default", out _);
                    checks.Add(new FunctionParamCheck(index, name, optional));
                }
                else if (type.ValueKind == JsonValueKind.Object && type.TryGetProperty("optional", out var inner) && IsFunctionType(inner))
                {
                    checks.Add(new FunctionParamCheck(index, name, true));
                }
            }
            index++;
        }
        return checks;
    }

    private static bool IsFunctionType(JsonElement type) =>
        (type.ValueKind == JsonValueKind.String && type.GetString() == "function")
        || (type.ValueKind == JsonValueKind.Object && type.TryGetProperty("function", out _));
}
