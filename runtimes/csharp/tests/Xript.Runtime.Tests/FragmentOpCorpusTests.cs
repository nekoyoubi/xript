using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds the C# command-buffer implementation to the shared cross-runtime corpus in
/// <c>spec/fragment-op-tests.json</c>: the finalized op list (including which ops survive,
/// what value each carries, and how its target resolved) and every diagnostic raised.
/// </summary>
public class FragmentOpCorpusTests
{
    public static TheoryData<int, string> Corpus()
    {
        var cases = JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsArray();
        var data = new TheoryData<int, string>();
        for (var i = 0; i < cases.Count; i++)
            data.Add(i, cases[i]!["description"]!.GetValue<string>());
        return data;
    }

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Matches_Shared_Op_Corpus(int index, string description)
    {
        var testCase = JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsArray()[index]!.AsObject();

        var formats = ParseFormats(testCase["formats"]);
        var vocabularies = ParseFormats(testCase["vocabularies"]);
        var profile = FormatProfiles.Resolve(
            testCase["format"]!.GetValue<string>(), formats, vocabularies);
        Assert.NotNull(profile);

        var raw = testCase["ops"]!.AsArray().Select(ToRawOp).ToList();
        var diagnostics = new List<FragmentDiagnostic>();
        var ops = FragmentOps.Finalize(raw, profile!, diagnostics.Add);

        var expected = testCase["expected"]!.AsObject();
        AssertJsonEqual(expected["ops"]!, OpsToJson(ops), $"{description}: ops");
        AssertJsonEqual(
            expected["diagnostics"]!, DiagnosticsToJson(diagnostics), $"{description}: diagnostics");
    }

    private static RawFragmentOp ToRawOp(JsonNode? node)
    {
        var obj = node!.AsObject();
        return new RawFragmentOp(
            obj["op"]!.GetValue<string>(),
            obj["selector"]!.GetValue<string>(),
            obj.TryGetPropertyValue("prop", out var prop) ? prop?.GetValue<string>() : null,
            obj.TryGetPropertyValue("attr", out var attr) ? attr?.GetValue<string>() : null,
            obj.TryGetPropertyValue("value", out var value) ? PropValue.FromJson(value) : null);
    }

    private static JsonArray OpsToJson(IReadOnlyList<FragmentOp> ops)
    {
        var array = new JsonArray();
        foreach (var op in ops)
        {
            var entry = new JsonObject
            {
                ["op"] = op.Op,
                ["selector"] = op.Selector,
                ["target"] = op.Target switch
                {
                    NodeRef.Id id => new JsonObject { ["by"] = "id", ["id"] = id.Value },
                    NodeRef.Selector sel => new JsonObject { ["by"] = "selector", ["selector"] = sel.Value },
                    _ => throw new InvalidOperationException("unknown node reference"),
                },
            };
            if (op.Prop is not null) entry["prop"] = op.Prop;
            if (op.Attr is not null) entry["attr"] = op.Attr;
            if (op.Value is not null) entry["value"] = op.Value.ToJson();
            array.Add(entry);
        }
        return array;
    }

    private static JsonArray DiagnosticsToJson(IReadOnlyList<FragmentDiagnostic> diagnostics)
    {
        var array = new JsonArray();
        foreach (var d in diagnostics)
        {
            var entry = new JsonObject
            {
                ["code"] = d.Code,
                ["severity"] = d.SeverityName,
                ["node"] = d.Node,
            };
            if (d.Prop is not null) entry["prop"] = d.Prop;
            entry["message"] = d.Message;
            entry["path"] = d.Path;
            array.Add(entry);
        }
        return array;
    }

    private static IReadOnlyDictionary<string, JsonElement>? ParseFormats(JsonNode? formats)
    {
        if (formats is not JsonObject obj) return null;
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, value) in obj)
            result[key] = JsonDocument.Parse(value!.ToJsonString()).RootElement.Clone();
        return result;
    }

    private static void AssertJsonEqual(JsonNode expected, JsonNode actual, string context)
    {
        var expectedText = Canonicalize(expected);
        var actualText = Canonicalize(actual);
        Assert.True(expectedText == actualText,
            $"{context}\nexpected: {expectedText}\nactual:   {actualText}");
    }

    private static string Canonicalize(JsonNode? node) => node?.ToJsonString() ?? "null";

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "fragment-op-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException(
            "could not locate spec/fragment-op-tests.json from the test output directory");
    }
}
