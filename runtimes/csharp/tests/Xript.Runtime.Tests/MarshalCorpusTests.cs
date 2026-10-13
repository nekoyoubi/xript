using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds host-to-sandbox marshalling to the shared corpus in <c>spec/marshal-tests.json</c>:
/// a host value is data, and an own key spelled <c>__proto__</c> arrives as an own data
/// property rather than as a prototype assignment.
/// </summary>
public class MarshalCorpusTests
{
    private const string Manifest = """
        {
            "xript": "0.1",
            "name": "marshal-probe",
            "bindings": { "value": { "description": "Returns the case's host value." } }
        }
        """;

    public static TheoryData<int, string> Corpus()
    {
        var cases = Cases();
        var data = new TheoryData<int, string>();
        for (var i = 0; i < cases.Count; i++)
            data.Add(i, cases[i]!["description"]!.GetValue<string>());
        return data;
    }

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Matches_Shared_Marshal_Corpus(int index, string description)
    {
        var testCase = Cases()[index]!.AsObject();
        var hostValue = JsonDocument.Parse(testCase["hostValue"]!.GetValue<string>()).RootElement.Clone();
        var bindings = new HostBindings();
        bindings.AddFunction("value", _ => hostValue);

        using var rt = XriptRuntime.Create(Manifest, new RuntimeOptions { HostBindings = bindings });
        var result = rt.Execute($"(function () {{ var v = value(); return ({testCase["probe"]!.GetValue<string>()}); }})()");

        Assert.True(testCase["expected"]!.GetValue<string>() == result.Value.GetString(),
            $"{description}\nexpected: {testCase["expected"]}\nactual:   {result.Value}");
    }

    private static JsonArray Cases() =>
        JsonNode.Parse(File.ReadAllText(CorpusPath()))!["cases"]!.AsArray();

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "marshal-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("could not locate spec/marshal-tests.json from the test output directory");
    }
}
