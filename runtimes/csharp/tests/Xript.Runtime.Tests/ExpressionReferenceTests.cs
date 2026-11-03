using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime.Expressions;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds the embedded <c>spec/expression-reference.json</c> to the spec copy, the builtin
/// table to its signatures, and the evaluator to every example it documents.
/// </summary>
public class ExpressionReferenceTests
{
    public static IEnumerable<object[]> Examples()
    {
        var reference = JsonNode.Parse(ExpressionReference.Json)!;
        foreach (var section in new[] { "builtins", "operators" })
        {
            foreach (var entry in reference[section]!.AsArray())
            {
                var index = 0;
                foreach (var example in entry!["examples"]!.AsArray())
                {
                    index++;
                    yield return [$"{entry["name"]} #{index}", example!.ToJsonString()];
                }
            }
        }
    }

    [Fact]
    public void EmbeddedCopyIsTheSpecFile()
    {
        var spec = File.ReadAllText(SpecPath("expression-reference.json"));
        Assert.Equal(spec.ReplaceLineEndings("\n"), ExpressionReference.Json.ReplaceLineEndings("\n"));
    }

    [Fact]
    public void BuiltinTableIsDerivedFromTheSignatures()
    {
        var names = ExpressionReference.Root.GetProperty("builtins").EnumerateArray()
            .Select(builtin => builtin.GetProperty("name").GetString()!)
            .ToArray();
        Assert.Equal(names, Builtins.Names);
        Assert.Equal((1, int.MaxValue), Builtins.Arity("min"));
        Assert.Equal((2, 3), Builtins.Arity("pad"));
        Assert.Equal((3, 3), Builtins.Arity("clamp"));
        Assert.Equal((1, 2), Builtins.Arity("join"));
        Assert.Null(Builtins.Arity("eval"));
    }

    [Theory]
    [MemberData(nameof(Examples))]
    public void EvaluatesEachExample(string id, string json)
    {
        var example = JsonNode.Parse(json)!.AsObject();
        var corpus = JsonNode.Parse(File.ReadAllText(SpecPath("expression-tests.json")))!;
        var source = example["bindings"] ?? corpus["defaultBindings"]!;
        var bindings = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, value) in source.AsObject())
            bindings[key] = ExprValue.Normalize(JsonSerializer.Deserialize<JsonElement>(value?.ToJsonString() ?? "null"));

        var actual = Xeg.Evaluate(example["expression"]!.GetValue<string>(), bindings);
        var expected = ExprValue.Normalize(JsonSerializer.Deserialize<JsonElement>(example["expect"]?.ToJsonString() ?? "null"));

        Assert.True(
            JsonSerializer.Serialize(actual) == JsonSerializer.Serialize(expected),
            $"{id}: `{example["expression"]}` -> {JsonSerializer.Serialize(actual)} (expected {JsonSerializer.Serialize(expected)})");
    }

    private static string SpecPath(string file)
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", file);
            if (File.Exists(candidate)) return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException($"could not locate spec/{file} from the test output directory");
    }
}
