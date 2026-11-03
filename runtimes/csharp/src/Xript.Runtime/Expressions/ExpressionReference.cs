using System.Text.Json;

namespace Xript.Runtime.Expressions;

/// <summary>
/// The machine-readable XEG reference (<c>spec/expression-reference.json</c>), embedded in the
/// assembly: builtin signatures and descriptions, operators by precedence, evaluation rules,
/// and the fragment attributes that carry expressions. The builtin table is derived from it,
/// so what an editor documents and what the parser accepts are one source.
/// </summary>
public static class ExpressionReference
{
    private static readonly Lazy<string> LazyJson = new(() =>
    {
        using var stream = typeof(ExpressionReference).Assembly.GetManifestResourceStream("Xript.Runtime.expression-reference.json")
            ?? throw new InvalidOperationException("expression-reference.json is not embedded in Xript.Runtime");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });

    private static readonly Lazy<JsonDocument> LazyDocument = new(() => JsonDocument.Parse(LazyJson.Value));

    private static readonly Lazy<IReadOnlyDictionary<string, (int Min, int Max)>> LazyArity = new(() =>
    {
        var table = new Dictionary<string, (int Min, int Max)>(StringComparer.Ordinal);
        foreach (var builtin in LazyDocument.Value.RootElement.GetProperty("builtins").EnumerateArray())
        {
            var min = 0;
            var count = 0;
            var variadic = false;
            foreach (var param in builtin.GetProperty("params").EnumerateArray())
            {
                count++;
                if (!(param.TryGetProperty("optional", out var optional) && optional.GetBoolean())) min++;
                if (param.TryGetProperty("variadic", out var rest) && rest.GetBoolean()) variadic = true;
            }
            table[builtin.GetProperty("name").GetString()!] = (min, variadic ? int.MaxValue : count);
        }
        return table;
    });

    /// <summary>The reference as published JSON text.</summary>
    public static string Json => LazyJson.Value;

    /// <summary>The parsed reference. Shared and read-only; do not dispose it.</summary>
    public static JsonElement Root => LazyDocument.Value.RootElement;

    /// <summary>Builtin call arity as <c>(min, max)</c>, with <see cref="int.MaxValue"/> marking a variadic tail.</summary>
    public static IReadOnlyDictionary<string, (int Min, int Max)> BuiltinArity => LazyArity.Value;
}
