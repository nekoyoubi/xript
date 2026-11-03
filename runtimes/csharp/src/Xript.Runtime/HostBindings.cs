using System.Linq;
using System.Text.Json;

namespace Xript.Runtime;

public delegate JsonElement HostFunction(JsonElement[] args);

/// <summary>What a caller-aware binding learns about the call it is serving.</summary>
/// <param name="ModId">The calling mod's id, or <c>null</c> for code no mod owns.</param>
/// <param name="Binding">The binding's qualified name, <c>save</c> or <c>world.getHealth</c>.</param>
public sealed record HostCallInfo(string? ModId, string Binding);

/// <summary>A host binding that receives <see cref="HostCallInfo"/> ahead of the script's arguments.</summary>
public delegate JsonElement CallerHostFunction(HostCallInfo info, JsonElement[] args);
/// <summary>
/// A live value a host supplies for a binding the manifest declares with <c>accessor</c>:
/// <see cref="Get"/> runs on every read, and <see cref="Set"/>, when present, on every
/// assignment. A <c>get-set</c> declaration needs a setter; a host that can only read
/// declares <c>get</c>.
/// </summary>
public sealed class HostAccessor
{
    public Func<JsonElement> Get { get; }
    public Action<JsonElement>? Set { get; }

    public HostAccessor(Func<JsonElement> get, Action<JsonElement>? set = null)
    {
        Get = get;
        Set = set;
    }
}

public sealed class HostNamespaceMember
{
    public HostFunction? Function { get; }
    public CallerHostFunction? CallerFunction { get; }
    public JsonElement? Property { get; }
    public Dictionary<string, HostNamespaceMember>? Namespace { get; }
    public HostAccessor? Accessor { get; }

    private HostNamespaceMember(
        HostFunction? function,
        CallerHostFunction? callerFunction,
        JsonElement? property,
        Dictionary<string, HostNamespaceMember>? ns,
        HostAccessor? accessor = null)
    {
        Function = function;
        CallerFunction = callerFunction;
        Property = property;
        Namespace = ns;
        Accessor = accessor;
    }

    public static HostNamespaceMember Fn(HostFunction function) => new(function, null, null, null);

    /// <summary>A caller-aware member: the runtime passes the calling mod and the binding name first.</summary>
    public static HostNamespaceMember Fn(CallerHostFunction function) => new(null, function, null, null);

    public static HostNamespaceMember Value(JsonElement value) => new(null, null, value, null);

    public static HostNamespaceMember Nested(Dictionary<string, HostNamespaceMember> members) =>
        new(null, null, null, members);

    /// <summary>A member whose value is computed on every read, for a manifest accessor.</summary>
    public static HostNamespaceMember Live(HostAccessor accessor) => new(null, null, null, null, accessor);

    internal bool IsCallable => Function is not null || CallerFunction is not null;
}

public class HostBindings
{
    internal Dictionary<string, HostFunction> Functions { get; } = new();
    internal Dictionary<string, CallerHostFunction> CallerFunctions { get; } = new();
    internal Dictionary<string, Dictionary<string, HostFunction>> Namespaces { get; } = new();
    internal Dictionary<string, Dictionary<string, HostNamespaceMember>> NestedNamespaces { get; } = new();
    internal Dictionary<string, HostAccessor> Accessors { get; } = new();

    public void AddFunction(string name, HostFunction function)
    {
        CallerFunctions.Remove(name);
        Functions[name] = function;
    }

    /// <summary>
    /// Adds a caller-aware binding: the runtime calls it with a <see cref="HostCallInfo"/>
    /// naming the calling mod and the binding, then the script's arguments.
    /// </summary>
    public void AddFunction(string name, CallerHostFunction function)
    {
        Functions.Remove(name);
        CallerFunctions[name] = function;
    }

    /// <summary>Registers a top-level accessor for a global the manifest declares with <c>accessor</c>.</summary>
    public void AddAccessor(string name, HostAccessor accessor)
    {
        Accessors[name] = accessor;
    }

    /// <summary>
    /// What the host registered at a dotted binding path, as a member: a top-level function,
    /// accessor, or namespace, or a member reached through nested namespaces.
    /// </summary>
    internal HostNamespaceMember? NodeAt(IReadOnlyList<string> path)
    {
        if (path.Count == 0) return null;
        var head = path[0];
        HostNamespaceMember? node =
            Functions.TryGetValue(head, out var fn) ? HostNamespaceMember.Fn(fn)
            : CallerFunctions.TryGetValue(head, out var callerFn) ? HostNamespaceMember.Fn(callerFn)
            : Accessors.TryGetValue(head, out var accessor) ? HostNamespaceMember.Live(accessor)
            : GetNestedNamespace(head) is { } ns ? HostNamespaceMember.Nested(ns)
            : null;
        for (var i = 1; i < path.Count && node is not null; i++)
        {
            if (node.Namespace is null || !node.Namespace.TryGetValue(path[i], out var next)) return null;
            node = next;
        }
        return node;
    }

    public void AddNamespace(string name, Dictionary<string, HostFunction> members)
    {
        Namespaces[name] = members;
    }

    public void AddNestedNamespace(string name, Dictionary<string, HostNamespaceMember> members)
    {
        NestedNamespaces[name] = members;
    }

    /// <summary>
    /// Whether a dotted binding path resolves to something callable in this set. The walk
    /// mirrors registration exactly, so the missing set never disagrees with what installs.
    /// </summary>
    internal bool Supplies(IReadOnlyList<string> path)
    {
        if (path.Count == 0) return false;
        var head = path[0];
        var rest = path.Skip(1).ToList();

        if (rest.Count == 0) return Functions.ContainsKey(head) || CallerFunctions.ContainsKey(head);

        if (Namespaces.TryGetValue(head, out var flat))
            return rest.Count == 1 && flat.ContainsKey(rest[0]);

        if (NestedNamespaces.TryGetValue(head, out var nested))
            return NestedSupplies(nested, rest);

        return false;
    }

    private static bool NestedSupplies(Dictionary<string, HostNamespaceMember> members, IReadOnlyList<string> path)
    {
        if (path.Count == 0) return false;
        if (!members.TryGetValue(path[0], out var member)) return false;
        var rest = path.Skip(1).ToList();
        if (rest.Count == 0) return member.IsCallable;
        return member.Namespace is not null && NestedSupplies(member.Namespace, rest);
    }

    internal HostFunction? GetFunction(string name) =>
        Functions.TryGetValue(name, out var f) ? f : null;

    internal CallerHostFunction? GetCallerFunction(string name) =>
        CallerFunctions.TryGetValue(name, out var f) ? f : null;

    internal Dictionary<string, HostFunction>? GetNamespace(string name) =>
        Namespaces.TryGetValue(name, out var ns) ? ns : null;

    internal Dictionary<string, HostNamespaceMember>? GetNestedNamespace(string name)
    {
        if (NestedNamespaces.TryGetValue(name, out var nested))
            return nested;

        if (Namespaces.TryGetValue(name, out var flat))
        {
            var lifted = new Dictionary<string, HostNamespaceMember>();
            foreach (var (key, fn) in flat)
                lifted[key] = HostNamespaceMember.Fn(fn);
            return lifted;
        }

        return null;
    }
}
