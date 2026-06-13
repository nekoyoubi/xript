using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class CapabilityCorpusTests
{
    public static IEnumerable<object[]> Cases()
    {
        var corpus = JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsArray();
        for (var i = 0; i < corpus.Count; i++)
            yield return [i, ((JsonObject)corpus[i]!).ToJsonString()];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Matches_Corpus_Case(int index, string caseJson)
    {
        var testCase = JsonNode.Parse(caseJson)!.AsObject();
        var require = testCase["require"]!.GetValue<string>();
        var expected = testCase["expected"]!.GetValue<bool>();

        var granted = ReadGranted(testCase);

        Assert.Equal(expected, Capabilities.GrantedSatisfies(granted, require));

        if (testCase.TryGetPropertyValue("grant", out var grantNode) && grantNode is not null)
            Assert.Equal(expected, Capabilities.Satisfies(grantNode.GetValue<string>(), require));
    }

    private static List<string> ReadGranted(JsonObject testCase)
    {
        if (testCase.TryGetPropertyValue("granted", out var grantedNode) && grantedNode is JsonArray arr)
            return arr.Select(n => n!.GetValue<string>()).ToList();

        if (testCase.TryGetPropertyValue("grant", out var grantNode) && grantNode is not null)
            return [grantNode.GetValue<string>()];

        return [];
    }

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "capability-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("could not locate spec/capability-tests.json from the test output directory");
    }
}
