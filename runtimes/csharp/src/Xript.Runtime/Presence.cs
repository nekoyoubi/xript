using System.Text.Json;

namespace Xript.Runtime;

/// <summary>
/// Which declared bindings a host actually provides, and what an omitted one becomes. A binding
/// declared <c>optional</c> may be omitted: it reads as <c>undefined</c> in the sandbox, and
/// <c>xript.has(path)</c> answers whether it is there. Omitting a binding that is not optional is
/// drift, reported through <c>MissingBindings</c> and installed as a stub that throws.
/// </summary>
internal static class Presence
{
    internal static bool IsNamespace(JsonElement def) =>
        def.ValueKind == JsonValueKind.Object && def.TryGetProperty("members", out _);

    internal static bool IsOptional(JsonElement def) =>
        def.ValueKind == JsonValueKind.Object &&
        def.TryGetProperty("optional", out var optional) &&
        optional.ValueKind == JsonValueKind.True;

    /// <summary>The declared accessor mode (<c>get</c> or <c>get-set</c>), or null for a non-accessor.</summary>
    internal static string? AccessorMode(JsonElement def) =>
        def.ValueKind == JsonValueKind.Object &&
        def.TryGetProperty("accessor", out var mode) &&
        mode.ValueKind == JsonValueKind.String
            ? mode.GetString()
            : null;

    /// <summary>
    /// Whether the host supplies what <paramref name="def"/> declares. An eager property counts for
    /// a function-declared member, since it installs as a real value.
    /// </summary>
    internal static bool Supplies(JsonElement def, HostNamespaceMember? node)
    {
        if (node is null) return false;
        if (IsNamespace(def)) return node.Namespace is not null;
        if (AccessorMode(def) is { } mode)
            return node.Accessor is not null && (mode == "get" || node.Accessor.Set is not null);
        return node.IsCallable || node.Property is not null;
    }

    /// <summary>Whether a declared binding the host left out is bound to <c>undefined</c> instead of installed.</summary>
    internal static bool Omits(JsonElement def, HostBindings host, IReadOnlyList<string> path) =>
        IsOptional(def) && !Supplies(def, host.NodeAt(path));

    /// <summary>
    /// The accessor the host supplies for <paramref name="def"/> at <paramref name="path"/>, or null
    /// when it supplies none the declaration can use.
    /// </summary>
    internal static HostAccessor? AccessorAt(JsonElement def, HostBindings host, IReadOnlyList<string> path)
    {
        var node = host.NodeAt(path);
        return Supplies(def, node) ? node!.Accessor : null;
    }

    /// <summary>Every declared binding path this host provides, for <c>xript.has</c>.</summary>
    internal static List<string> ProvidedPaths(Dictionary<string, JsonElement>? bindings, HostBindings host)
    {
        var provided = new List<string>();
        if (bindings is not null)
        {
            foreach (var (name, def) in bindings)
                CollectProvided(def, host, new List<string> { name }, provided);
        }
        provided.Sort(StringComparer.Ordinal);
        return provided;
    }

    /// <summary>
    /// The rule the missing-bindings check uses, which <c>xript.has</c> follows: a
    /// function-declared binding counts only when the host registered something callable for
    /// it. An eager value still installs for such a member (<see cref="Supplies"/>), but it is
    /// reported missing, so <c>has</c> answers false for it too.
    /// </summary>
    private static bool Provides(JsonElement def, HostNamespaceMember? node)
    {
        if (IsNamespace(def) || AccessorMode(def) is not null) return Supplies(def, node);
        return node is not null && node.IsCallable;
    }

    private static void CollectProvided(JsonElement def, HostBindings host, List<string> path, List<string> provided)
    {
        if (!Provides(def, host.NodeAt(path))) return;
        provided.Add(string.Join(".", path));
        if (!IsNamespace(def)) return;
        foreach (var member in def.GetProperty("members").EnumerateObject())
        {
            path.Add(member.Name);
            CollectProvided(member.Value, host, path, provided);
            path.RemoveAt(path.Count - 1);
        }
    }

    /// <summary>
    /// Installs <c>xript.has(path)</c> over a fixed set of provided paths. The set lives in a
    /// closure the script cannot reach, and <c>has</c> is a non-writable property, so a mod can
    /// neither forge presence nor replace the probe.
    /// </summary>
    internal static string ProbeSource(IReadOnlyList<string> paths) => $$"""
        (function (paths) {
            var known = Object.create(null);
            for (var i = 0; i < paths.length; i++) known[paths[i]] = true;
            var has = function has(path) { return typeof path === "string" && known[path] === true; };
            var ns = globalThis.xript;
            if (ns === null || typeof ns !== "object") { ns = {}; globalThis.xript = ns; }
            Object.defineProperty(ns, "has", { value: has, enumerable: true, writable: false, configurable: false });
        })({{JsonSerializer.Serialize(paths)}});
        """;

    /// <summary>
    /// Defines an accessor binding on a sandbox object. Without a setter, assignment throws a
    /// <c>TypeError</c> in strict and sloppy code alike.
    /// </summary>
    internal const string DefineAccessorSource = """
        (function (target, key, get, set, name) {
            Object.defineProperty(target, key, {
                get: function () { return get(); },
                set: set ? function (value) { set(value); } : function () { throw new TypeError(name + " is read-only: the host declares no setter"); },
                enumerable: true,
                configurable: false
            });
        })
        """;
}
