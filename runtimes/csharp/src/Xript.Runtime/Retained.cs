using System.Text.Json;
using System.Text.Json.Nodes;
using Jint.Native;

namespace Xript.Runtime;

/// <summary>
/// A callback the host retained past the binding call that received it. It stays callable, on
/// the thread that retained it, until it is released, the mod that supplied it is released, or
/// the runtime is disposed. Two handles are equal when they name the same retained callback.
/// </summary>
public sealed class RetainedCallback : IEquatable<RetainedCallback>
{
    private readonly RetainedRegistry _registry;
    internal RetainedRecord Record { get; }

    /// <summary>The binding the callback was retained from.</summary>
    public string Binding => Record.Binding;

    /// <summary>The token naming this retained callback inside its marker.</summary>
    public string Token => Record.Token;

    /// <summary>Whether the callback has been released.</summary>
    public bool Released => Record.Released;

    internal RetainedCallback(RetainedRegistry registry, RetainedRecord record)
    {
        _registry = registry;
        Record = record;
    }

    /// <summary>
    /// The marker object, <c>{ "$xriptCallback": "&lt;token&gt;" }</c>, the host passes back into the
    /// sandbox (in a binding's return value, hook data, an event payload, or export arguments) for
    /// the script to receive its own original function.
    /// </summary>
    public JsonElement ToMarker() =>
        JsonSerializer.SerializeToElement(new JsonObject { [XriptCallback.Marker] = Token });

    /// <summary>
    /// Calls the script function with <paramref name="args"/> and returns what it returned, both
    /// marshalled as JSON. From inside a binding call it spends that script call's budget; between
    /// script calls it runs on a fresh budget. Throws <see cref="CallbackException"/> when it cannot.
    /// </summary>
    public JsonElement Invoke(params JsonElement[] args) => _registry.Invoke(Record, args);

    /// <summary>Releases the callback. Releasing it again does nothing.</summary>
    public void Release() => _registry.Release(Record);

    public bool Equals(RetainedCallback? other) => other is not null && other.Token == Token;

    public override bool Equals(object? obj) => obj is RetainedCallback other && Equals(other);

    public override int GetHashCode() => Token.GetHashCode();
}

/// <summary>
/// Thrown when <see cref="XriptCallback.Retain"/> refuses: <see cref="Reason"/> is <c>undeclared</c>
/// (the callback is not at a position the manifest marks <c>"retain": true</c>) or <c>limit</c>
/// (the runtime already holds <c>max_retained_callbacks</c> retained callbacks).
/// </summary>
public sealed class RetainException : Exception
{
    public string Binding { get; }

    public string Reason { get; }

    internal RetainException(string binding, string reason, int limit = 0)
        : base(reason == "limit"
            ? $"{binding}(): callback cannot be retained; the runtime already holds max_retained_callbacks ({limit}) retained callbacks"
            : $"{binding}(): callback cannot be retained; only a callback at a parameter or field the manifest marks \"retain\": true can be retained")
    {
        Binding = binding;
        Reason = reason;
    }
}

internal sealed class RetainedRecord
{
    internal required string Token { get; init; }
    internal required string Binding { get; init; }
    internal required string? Owner { get; init; }
    internal required int Thread { get; init; }
    internal JsValue? Function { get; set; }
    internal bool Released { get; set; }
    internal RetainedCallback? Handle { get; set; }
}

/// <summary>Every callback one runtime has retained.</summary>
internal sealed class RetainedRegistry
{
    internal const string TokenPrefix = "r:";

    private readonly Sandbox _sandbox;
    private readonly int _limit;
    private readonly long _nonce = BitConverter.ToInt64(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8));
    private readonly Dictionary<string, RetainedRecord> _live = new();
    private readonly HashSet<string> _released = [];
    private long _nextId;

    internal RetainedRegistry(Sandbox sandbox, int limit)
    {
        _sandbox = sandbox;
        _limit = limit;
    }

    internal RetainedCallback Retain(JsValue function, bool declared, string binding)
    {
        var owner = _sandbox.Caller.Current;
        foreach (var record in _live.Values)
        {
            if (ReferenceEquals(record.Function, function) && record.Owner == owner)
                return record.Handle!;
        }
        if (!declared)
            throw new RetainException(binding, "undeclared");
        if (_live.Count >= _limit)
            throw new RetainException(binding, "limit", _limit);

        var id = ++_nextId;
        var created = new RetainedRecord
        {
            Token = $"{TokenPrefix}{id}:{_nonce}:{binding}",
            Binding = binding,
            Owner = owner,
            Thread = Environment.CurrentManagedThreadId,
            Function = function,
        };
        created.Handle = new RetainedCallback(this, created);
        _live[created.Token] = created;
        return created.Handle;
    }

    internal JsonElement Invoke(RetainedRecord record, JsonElement[] args)
    {
        if (record.Released || record.Function is null)
            throw new CallbackException(record.Binding, "released");
        if (record.Thread != Environment.CurrentManagedThreadId)
            throw new CallbackException(record.Binding, "expired", detail: CallbackException.OffThread);

        using var caller = _sandbox.Caller.Enter(record.Owner);
        if (CallbackScope.Innermost(_sandbox.Engine) is { } scope)
            return scope.InvokeFunction(record.Function, args, record.Binding);
        return _sandbox.InvokeRetainedFresh(record.Function, args, record.Binding);
    }

    internal void Release(RetainedRecord record)
    {
        if (record.Released) return;
        record.Released = true;
        record.Function = null;
        _live.Remove(record.Token);
        _released.Add(record.Token);
    }

    internal int ReleaseOwner(string owner)
    {
        var owned = _live.Values.Where(r => r.Owner == owner).ToList();
        foreach (var record in owned) Release(record);
        return owned.Count;
    }

    internal void ReleaseAll()
    {
        foreach (var record in _live.Values.ToList()) Release(record);
    }

    /// <summary>
    /// The script function a marker crossing into the sandbox names, or null when the token names
    /// no retained callback this runtime issued, in which case the marker stays plain data. A
    /// released one is refused as released, and a live one is refused as expired while a mod other
    /// than the one that supplied it is running.
    /// </summary>
    internal JsValue? Resolve(string token)
    {
        if (!token.StartsWith(TokenPrefix, StringComparison.Ordinal))
            return null;
        if (_live.TryGetValue(token, out var record))
        {
            var current = _sandbox.Caller.Current;
            if (current is null || current == record.Owner)
                return record.Function!;
            throw new CallbackException(record.Binding, "expired", detail: CallbackException.Foreign);
        }
        if (_released.Contains(token))
            throw new CallbackException(BindingOf(token), "released");
        return null;
    }

    private static string BindingOf(string token)
    {
        var parts = token[TokenPrefix.Length..].Split(':', 3);
        return parts.Length == 3 && parts[2].Length > 0 ? parts[2] : "callback";
    }
}
