using System.Text.Json;

namespace Xript.Runtime;

public delegate JsonElement HostFunction(JsonElement[] args);

public sealed class HostNamespaceMember
{
    public HostFunction? Function { get; }
    public JsonElement? Property { get; }
    public Dictionary<string, HostNamespaceMember>? Namespace { get; }

    private HostNamespaceMember(
        HostFunction? function,
        JsonElement? property,
        Dictionary<string, HostNamespaceMember>? ns)
    {
        Function = function;
        Property = property;
        Namespace = ns;
    }

    public static HostNamespaceMember Fn(HostFunction function) => new(function, null, null);

    public static HostNamespaceMember Value(JsonElement value) => new(null, value, null);

    public static HostNamespaceMember Nested(Dictionary<string, HostNamespaceMember> members) =>
        new(null, null, members);
}

public class HostBindings
{
    internal Dictionary<string, HostFunction> Functions { get; } = new();
    internal Dictionary<string, Dictionary<string, HostFunction>> Namespaces { get; } = new();
    internal Dictionary<string, Dictionary<string, HostNamespaceMember>> NestedNamespaces { get; } = new();

    public void AddFunction(string name, HostFunction function)
    {
        Functions[name] = function;
    }

    public void AddNamespace(string name, Dictionary<string, HostFunction> members)
    {
        Namespaces[name] = members;
    }

    public void AddNestedNamespace(string name, Dictionary<string, HostNamespaceMember> members)
    {
        NestedNamespaces[name] = members;
    }

    internal HostFunction? GetFunction(string name) =>
        Functions.TryGetValue(name, out var f) ? f : null;

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
