using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds sandbox-to-host marshalling to the shared corpus in <c>spec/marshal-out-tests.json</c>:
/// a script value crossing out is data, and a script function never reaches the host as something
/// callable. A function marshals to null at the top level and as an array element and is omitted
/// as an object property, matching what JSON serialization produces.
/// </summary>
public class MarshalOutCorpusTests
{
    private const string Manifest = """
        { "xript": "0.1", "name": "marshal-out-probe" }
        """;

    public static TheoryData<int, string> Corpus()
    {
        var cases = Cases();
        var data = new TheoryData<int, string>();
        for (var i = 0; i < cases.Count; i++)
            data.Add(i, cases[i]!["name"]!.GetValue<string>());
        return data;
    }

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Matches_Shared_Marshal_Out_Corpus(int index, string name)
    {
        var testCase = Cases()[index]!.AsObject();
        using var rt = XriptRuntime.Create(Manifest, new RuntimeOptions { HostBindings = new HostBindings() });
        var result = rt.Execute(testCase["script"]!.GetValue<string>());

        // A JSON null in the corpus is a null JsonNode reference, so serialize defensively.
        var expectedJson = testCase.TryGetPropertyValue("expected", out var e) && e is not null ? e.ToJsonString() : "null";
        var expected = JsonNode.Parse(expectedJson);
        var actual = JsonNode.Parse(result.Value.GetRawText());

        Assert.True(JsonNode.DeepEquals(expected, actual),
            $"{name}\nexpected: {expectedJson}\nactual:   {result.Value.GetRawText()}");
    }

    private static JsonArray Cases() =>
        JsonNode.Parse(File.ReadAllText(CorpusPath()))!["cases"]!.AsArray();

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "marshal-out-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("could not locate spec/marshal-out-tests.json from the test output directory");
    }
}
