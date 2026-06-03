using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class ManifestExtendsCorpusTests : IDisposable
{
    private readonly string _dir;

    public ManifestExtendsCorpusTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "xript-extends-corpus-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    public static IEnumerable<object[]> Cases()
    {
        var corpus = JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsArray();
        for (var i = 0; i < corpus.Count; i++)
            yield return [i, ((JsonObject)corpus[i]!).ToJsonString()];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Resolves_Corpus_Case(int index, string caseJson)
    {
        var testCase = JsonNode.Parse(caseJson)!.AsObject();
        var isError = testCase.TryGetPropertyValue("error", out var errorNode)
            && errorNode is JsonValue ev && ev.TryGetValue<bool>(out var eb) && eb;

        var basePath = Path.Combine(_dir, $"base-{index}.json");
        File.WriteAllText(basePath, testCase["base"]!.ToJsonString());

        var child = (JsonObject)testCase["extender"]!.DeepClone();
        child["extends"] = basePath;

        if (isError)
        {
            Assert.Throws<ManifestValidationException>(
                () => ManifestResolver.Resolve(child.ToJsonString(), _dir));
            return;
        }

        var resolved = ManifestResolver.Resolve(child.ToJsonString(), _dir);
        var actual = JsonNode.Parse(resolved)!;
        var expected = testCase["resolved"]!;

        Assert.True(
            JsonDeepEquals(actual, expected),
            $"case {index}: resolved manifest did not match expected.\n" +
            $"expected: {expected.ToJsonString()}\n" +
            $"actual:   {actual.ToJsonString()}");
    }

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "extends-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("could not locate spec/extends-tests.json from the test output directory");
    }

    private static bool JsonDeepEquals(JsonNode? a, JsonNode? b)
    {
        if (a is null || b is null)
            return a is null && b is null;

        if (a is JsonObject ao && b is JsonObject bo)
        {
            if (ao.Count != bo.Count) return false;
            foreach (var (key, value) in ao)
            {
                if (!bo.TryGetPropertyValue(key, out var other)) return false;
                if (!JsonDeepEquals(value, other)) return false;
            }
            return true;
        }

        if (a is JsonArray aa && b is JsonArray ba)
        {
            if (aa.Count != ba.Count) return false;
            for (var i = 0; i < aa.Count; i++)
                if (!JsonDeepEquals(aa[i], ba[i])) return false;
            return true;
        }

        if (a is JsonValue && b is JsonValue)
            return a.ToJsonString() == b.ToJsonString();

        return false;
    }
}
