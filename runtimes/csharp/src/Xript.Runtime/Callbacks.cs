using System.Collections.Concurrent;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using System.Text.Json.Nodes;
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
}

/// <summary>One binding call's callbacks on the sandbox side.</summary>
internal sealed class CallbackScope : IDisposable
{
    private static readonly ConcurrentDictionary<long, CallbackScope> Live = new();
    private static long _nextId;

    private readonly long _id = Interlocked.Increment(ref _nextId);
    // A random, process-local nonce makes a callback token unforgeable: script data shaped
    // like a token cannot carry a live scope's nonce, so it never resolves.
    private readonly long _nonce = BitConverter.ToInt64(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8));
    private readonly int _thread = Environment.CurrentManagedThreadId;
    private readonly Engine _engine;
    private readonly string _binding;
    private readonly JsValue[] _functions;
    private readonly Func<JsonElement, JsValue> _toJs;
    private readonly Func<JsValue, JsonElement> _toJson;
    private readonly List<(CallbackException Error, JsValue Original)> _thrown = [];

    /// <summary>A budget stop raised inside a callback; the binding call must end with it.</summary>
    internal Exception? Fatal { get; private set; }

    internal CallbackScope(
        Engine engine,
        string binding,
        JsValue functions,
        Func<JsonElement, JsValue> toJs,
        Func<JsValue, JsonElement> toJson)
    {
        _engine = engine;
        _binding = binding;
        _toJs = toJs;
        _toJson = toJson;
        _functions = functions is ObjectInstance array && functions.IsArray()
            ? Enumerable.Range(0, (int)array.Get("length").AsNumber()).Select(i => array.Get(i.ToString())).ToArray()
            : [];
        Live[_id] = this;
    }

    internal static bool TryFind(long id, long nonce, out CallbackScope scope)
    {
        if (Live.TryGetValue(id, out scope!) && scope._thread == Environment.CurrentManagedThreadId && scope._nonce == nonce)
            return true;
        scope = null!;
        return false;
    }

    /// <summary>Whether a scope with this id and nonce is live on the calling thread.</summary>
    internal static bool IsLive(long id, long nonce) => TryFind(id, nonce, out _);

    /// <summary>Rewrites the numeric markers the sandbox emitted into resolvable tokens.</summary>
    internal JsonElement[] ResolveMarkers(JsonElement[] args)
    {
        if (_functions.Length == 0) return args;
        return args.Select(arg =>
        {
            var node = JsonNode.Parse(arg.GetRawText());
            node = Resolve(node);
            return JsonSerializer.SerializeToElement(node);
        }).ToArray();
    }

    private JsonNode? Resolve(JsonNode? node)
    {
        switch (node)
        {
            case JsonArray array:
                for (var i = 0; i < array.Count; i++)
                {
                    var resolved = Resolve(array[i]);
                    if (!ReferenceEquals(resolved, array[i]))
                    {
                        array[i] = null;
                        array[i] = resolved;
                    }
                }
                return array;
            case JsonObject obj:
                if (obj.Count == 1
                    && obj.TryGetPropertyValue(XriptCallback.Marker, out var marker)
                    && marker is JsonValue value
                    && value.TryGetValue<double>(out var number)
                    && number >= 0 && number < _functions.Length && number == Math.Floor(number))
                {
                    return new JsonObject { [XriptCallback.Marker] = $"{_id}:{(int)number}:{_nonce}:{_binding}" };
                }
                foreach (var key in obj.Select(p => p.Key).ToList())
                {
                    var current = obj[key];
                    var resolved = Resolve(current);
                    if (!ReferenceEquals(resolved, current))
                    {
                        obj[key] = null;
                        obj[key] = resolved;
                    }
                }
                return obj;
            default:
                return node;
        }
    }

    internal JsonElement Invoke(int index, JsonElement[] args)
    {
        if (Fatal is not null)
            throw new CallbackException(_binding, "limit");
        if (index < 0 || index >= _functions.Length)
            throw new CallbackException(_binding, "expired");

        var jsArgs = args.Select(_toJs).ToArray();
        JsValue result;
        try
        {
            result = _engine.Call(_functions[index], JsValue.Undefined, jsArgs);
        }
        catch (JavaScriptException ex)
        {
            var (name, message) = Describe(ex.Error, ex.Message);
            var error = new CallbackException(_binding, "threw", name, message);
            _thrown.Add((error, ex.Error));
            throw error;
        }
        catch (Exception ex) when (IsBudgetStop(ex))
        {
            Fatal = ex;
            throw new CallbackException(_binding, "limit");
        }

        if (IsThenable(result))
            throw new CallbackException(_binding, "promise");
        return _toJson(result);
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

    public void Dispose() => Live.TryRemove(_id, out _);

    private static bool IsBudgetStop(Exception ex) =>
        ex is ExecutionCanceledException or TimeoutException or MemoryLimitExceededException or RecursionDepthOverflowException;

    private static bool IsThenable(JsValue value)
    {
        if (value.IsPromise()) return true;
        return value is ObjectInstance obj && obj.Get("then") is { } then && then.IsObject() && then.AsObject() is Jint.Native.Function.Function;
    }

    private static (string? Name, string Message) Describe(JsValue error, string fallback)
    {
        if (error is ObjectInstance obj)
        {
            var name = obj.Get("name");
            var message = obj.Get("message");
            return (name.IsString() ? name.AsString() : null, message.IsString() ? message.AsString() : fallback);
        }
        return (null, error.IsString() ? error.AsString() : fallback);
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

    internal static string ToJson(List<FunctionParamCheck> checks) =>
        JsonSerializer.Serialize(checks.Select(c => new { index = c.Index, name = c.Name, optional = c.Optional }));
}
