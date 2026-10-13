using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds the C# fragment-vocabulary implementation to the shared cross-runtime corpus in
/// <c>spec/fragment-vocabulary-tests.json</c>: the sanitized tree, the HTML projection,
/// the content type, and every diagnostic's code, severity, path, node, prop, and message.
/// </summary>
public class FragmentVocabularyCorpusTests
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
    public void Matches_Shared_Vocabulary_Corpus(int index, string description)
    {
        var testCase = JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsArray()[index]!.AsObject();

        var formats = ParseFormats(testCase["formats"]);
        var vocabularies = ParseFormats(testCase["vocabularies"]);
        var format = testCase["format"]!.GetValue<string>();

        if (testCase["expectedError"] is JsonObject expectedError)
        {
            var refusal = Assert.Throws<FormatProfileException>(
                () => FormatProfiles.Resolve(format, formats, vocabularies));
            Assert.Equal(expectedError["message"]!.GetValue<string>(), refusal.Message);
            return;
        }

        var profile = FormatProfiles.Resolve(format, formats, vocabularies);
        Assert.NotNull(profile);

        var result = FragmentSanitizer.Sanitize(testCase["source"]!.GetValue<string>(), profile!);
        var expected = testCase["expected"]!.AsObject();

        Assert.Equal(
            expected["contentType"]!.GetValue<string>(),
            result.ContentType == FragmentContentType.Html ? "html" : "tree");
        Assert.Equal(expected["html"]!.GetValue<string>(), result.Html);

        AssertJsonEqual(expected["tree"]!, TreeToJson(result.Tree), $"{description}: tree");
        if (expected["jsml"] is JsonNode expectedJsml)
            AssertJsonEqual(expectedJsml, FragmentTree.ToJsml(result.Tree), $"{description}: jsml");
        AssertJsonEqual(expected["diagnostics"]!, DiagnosticsToJson(result.Diagnostics), $"{description}: diagnostics");
        AssertJsonEqual(
            expected["strippedElements"]!,
            new JsonArray([.. result.StrippedElements.Select(e => (JsonNode?)JsonValue.Create(e))]),
            $"{description}: strippedElements");
        AssertJsonEqual(
            expected["strippedAttributes"]!,
            new JsonArray([.. result.StrippedAttributes.Select(a => (JsonNode?)new JsonObject
            {
                ["element"] = a.Element,
                ["attribute"] = a.Attribute,
            })]),
            $"{description}: strippedAttributes");
    }

    private static IReadOnlyDictionary<string, JsonElement>? ParseFormats(JsonNode? formats)
    {
        if (formats is not JsonObject obj) return null;
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, value) in obj)
            result[key] = JsonDocument.Parse(value!.ToJsonString()).RootElement.Clone();
        return result;
    }

    private static JsonArray TreeToJson(IReadOnlyList<FragmentNode> tree) =>
        new([.. tree.Select(NodeToJson)]);

    private static JsonNode NodeToJson(FragmentNode node)
    {
        if (node is FragmentNode.Text text) return new JsonObject { ["text"] = text.Value };

        var element = (FragmentNode.Element)node;
        var props = new JsonObject();
        foreach (var (key, value) in element.Props) props[key] = value.ToJson();

        var result = new JsonObject
        {
            ["name"] = element.Name,
            ["props"] = props,
            ["children"] = TreeToJson(element.Children),
        };
        if (element.SelfClosing) result["selfClosing"] = true;
        return result;
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
                ["path"] = d.Path,
                ["node"] = d.Node,
            };
            if (d.Prop is not null) entry["prop"] = d.Prop;
            entry["message"] = d.Message;
            array.Add(entry);
        }
        return array;
    }

    private static void AssertJsonEqual(JsonNode expected, JsonNode actual, string context)
    {
        var expectedText = Canonicalize(expected);
        var actualText = Canonicalize(actual);
        Assert.True(expectedText == actualText,
            $"{context}\nexpected: {expectedText}\nactual:   {actualText}");
    }

    /// <summary>
    /// Serializes for comparison with every number spelled the JavaScript way, so a value
    /// the corpus writes as <c>1e+21</c> and System.Text.Json writes as <c>1E+21</c> compare equal.
    /// </summary>
    private static string Canonicalize(JsonNode? node) => node switch
    {
        null => "null",
        JsonObject obj => "{" + string.Join(",", obj.Select(entry =>
            JsonValue.Create(entry.Key).ToJsonString() + ":" + Canonicalize(entry.Value))) + "}",
        JsonArray array => "[" + string.Join(",", array.Select(Canonicalize)) + "]",
        JsonValue value when value.GetValueKind() == System.Text.Json.JsonValueKind.Number =>
            PropValue.NumberToString(value.GetValue<double>()),
        _ => node.ToJsonString(),
    };

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "fragment-vocabulary-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException(
            "could not locate spec/fragment-vocabulary-tests.json from the test output directory");
    }
}
