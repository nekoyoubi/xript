using System.Text.Json;

namespace Xript.Runtime;

public delegate JsonElement HostFunction(JsonElement[] args);

public class HostBindings
{
    internal Dictionary<string, HostFunction> Functions { get; } = new();
    internal Dictionary<string, Dictionary<string, HostFunction>> Namespaces { get; } = new();

    public void AddFunction(string name, HostFunction function)
    {
        Functions[name] = function;
    }

    public void AddNamespace(string name, Dictionary<string, HostFunction> members)
    {
        Namespaces[name] = members;
    }

    internal HostFunction? GetFunction(string name) =>
        Functions.TryGetValue(name, out var f) ? f : null;

    internal Dictionary<string, HostFunction>? GetNamespace(string name) =>
        Namespaces.TryGetValue(name, out var ns) ? ns : null;
}
