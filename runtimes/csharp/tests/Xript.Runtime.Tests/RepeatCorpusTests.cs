using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime.Expressions;
using Xript.Runtime.Fragments;

namespace Xript.Runtime.Tests;

/// <summary>Replays <c>spec/repeat-tests.json</c>, the corpus that holds every runtime's <c>data-each</c> to one behaviour.</summary>
public class RepeatCorpusTests
{
    public static IEnumerable<object[]> HeaderCases() => Section("headers");
    public static IEnumerable<object[]> RenderCases() => Section("render");
    public static IEnumerable<object[]> UpdateCases() => Section("updates");
    public static IEnumerable<object[]> DiffCases() => Section("diff");

    [Fact]
    public void CopyCeilingMatchesTheCorpus() =>
        Assert.Equal(Corpus()["maxCopies"]!.GetValue<int>(), Repeat.MaxCopies);

    [Theory]
    [MemberData(nameof(HeaderCases))]
    public void ParsesHeadersTheSameWay(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var parsed = Repeat.TryParseHeader(testCase["source"]!.GetValue<string>(), out var header, out var error);
        var expected = testCase["expected"];
        if (expected is null)
        {
            Assert.False(parsed, $"{id}: expected a rejection");
            return;
        }
        Assert.True(parsed, $"{id}: {error}");
        var actual = new JsonObject
        {
            ["item"] = header!.Item,
            ["index"] = header.Index,
            ["expression"] = header.Source,
        };
        Assert.Equal(expected.ToJsonString(), actual.ToJsonString());
    }

    [Theory]
    [MemberData(nameof(RenderCases))]
    public void RendersTheSameWay(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var bindings = BindingsFrom(testCase["bindings"]);
        if (testCase["generate"] is JsonObject generate)
        {
            foreach (var (name, count) in generate)
            {
                var items = Enumerable.Range(0, count!.GetValue<int>()).Select(i => (object?)(double)i).ToList();
                bindings[name] = items;
            }
        }

        var result = Instance(testCase["source"]!.GetValue<string>(), bindings.Keys, testCase["interpolate"]?.GetValue<bool>() == true)
            .GetContent(bindings);
        var expected = testCase["expected"]!.AsObject();

        if (expected["copies"] is { } copies)
        {
            Assert.Equal(copies.GetValue<int>(), result.Repeats.Sum(r => r.Count));
            Assert.Equal(expected["repeats"]!.GetValue<int>(), result.Repeats.Count);
        }
        else
        {
            Assert.Equal(expected["html"]!.GetValue<string>(), result.Html);
            Assert.Equal(Normalize(expected["conditions"]), Normalize(ConditionsJson(result)));
            Assert.Equal(Normalize(expected["repeats"]), Normalize(RepeatsJson(result.Repeats)));
        }
        Assert.Equal(Normalize(expected["diagnostics"]), Normalize(DiagnosticsJson(result)));
    }

    [Theory]
    [MemberData(nameof(UpdateCases))]
    public void PatchesUpdatesTheSameWay(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var steps = testCase["steps"]!.AsArray();
        var names = steps
            .SelectMany(step => step!["bindings"]!.AsObject().Select(entry => entry.Key))
            .Distinct()
            .ToList();
        var instance = Instance(testCase["source"]!.GetValue<string>(), names, false);

        for (var i = 0; i < steps.Count; i++)
        {
            var step = steps[i]!.AsObject();
            var result = instance.GetContent(BindingsFrom(step["bindings"]));
            Assert.Equal(step["expected"]!["html"]!.GetValue<string>(), result.Html);
            Assert.True(
                Normalize(step["expected"]!["repeats"]) == Normalize(RepeatsJson(result.Repeats)),
                $"{id} step {i}");
        }
    }

    [Theory]
    [MemberData(nameof(DiffCases))]
    public void DiffsTheSameWay(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        (string, IReadOnlyList<object>)? previous = testCase["previous"] is JsonObject prior
            ? (prior["mode"]!.GetValue<string>(), Keys(prior["keys"]))
            : null;
        var next = testCase["next"]!.AsObject();
        var patch = RepeatDiff.Diff(previous, (next["mode"]!.GetValue<string>(), Keys(next["keys"])));
        Assert.True(Normalize(testCase["patch"]) == Normalize(PatchJson(patch)), id);
    }

    [Fact]
    public void CopiesDropTheTemplateAttributesAndKeepTheRest()
    {
        var bindings = new Dictionary<string, object?> { ["xs"] = new List<object?> { "a" } };
        var result = Instance(
                """<li id="row" data-each="x in xs" data-key="x" data-if="x" class="r" data-bind="x"></li>""",
                bindings.Keys,
                false)
            .GetContent(bindings);
        var copy = Assert.IsType<FragmentNode.Element>(Assert.Single(result.Tree));
        Assert.Equal(["id", "data-if", "class", "data-bind"], copy.Props.Keys);
    }

    private static List<object> Keys(JsonNode? node) =>
        node!.AsArray()
            .Select(key => key!.GetValueKind() == JsonValueKind.Number
                ? (object)key.GetValue<double>()
                : key.GetValue<string>())
            .ToList();

    private static FragmentInstance Instance(string source, IEnumerable<string> names, bool interpolate)
    {
        var declaration = new FragmentDeclaration
        {
            Id = "corpus",
            Slot = "corpus",
            Format = "text/html",
            Source = source,
            Inline = true,
            Interpolate = interpolate,
            Bindings = names.Select(name => new FragmentBinding { Name = name, Path = name }).ToList(),
        };
        return FragmentInstance.Create(declaration, source, null, null, false, null);
    }

    private static JsonNode KeyJson(object key) => key switch
    {
        double d => JsonValue.Create(d),
        string s => JsonValue.Create(s),
        _ => JsonValue.Create(key.ToString())!,
    };

    private static JsonArray PatchJson(IEnumerable<RepeatPatchOp> patch)
    {
        var array = new JsonArray();
        foreach (var op in patch)
        {
            var entry = new JsonObject { ["op"] = op.Op, ["key"] = KeyJson(op.Key) };
            if (op.From is { } from) entry["from"] = from;
            if (op.To is { } to) entry["to"] = to;
            array.Add(entry);
        }
        return array;
    }

    private static JsonArray Ints(IEnumerable<int> values) => new(values.Select(v => (JsonNode)JsonValue.Create(v)).ToArray());

    private static JsonArray RepeatsJson(IEnumerable<FragmentRepeat> repeats)
    {
        var array = new JsonArray();
        foreach (var repeat in repeats)
        {
            array.Add(new JsonObject
            {
                ["site"] = new JsonObject
                {
                    ["template"] = Ints(repeat.Site.Template),
                    ["within"] = new JsonArray(repeat.Site.Within.Select(KeyJson).ToArray()),
                },
                ["path"] = Ints(repeat.Path),
                ["start"] = repeat.Start,
                ["count"] = repeat.Count,
                ["expression"] = repeat.Expression,
                ["key"] = repeat.Key,
                ["mode"] = repeat.Mode,
                ["keys"] = new JsonArray(repeat.Keys.Select(KeyJson).ToArray()),
                ["patch"] = PatchJson(repeat.Patch),
            });
        }
        return array;
    }

    private static JsonArray ConditionsJson(FragmentResult result) =>
        new(result.Conditions
            .Select(c => (JsonNode)new JsonObject
            {
                ["path"] = Ints(c.Path),
                ["expression"] = c.Expression,
                ["visible"] = c.Visible,
            })
            .ToArray());

    private static JsonArray DiagnosticsJson(FragmentResult result) =>
        new(result.Diagnostics
            .Select(d => (JsonNode)new JsonObject
            {
                ["code"] = d.Code,
                ["path"] = d.Path,
                ["node"] = d.Node,
                ["prop"] = d.Prop,
            })
            .ToArray());

    /// <summary>Numbers compare by value, so <c>1</c> and <c>1.0</c> are one key.</summary>
    private static string Normalize(JsonNode? node) => Rebuild(node)?.ToJsonString() ?? "null";

    private static JsonNode? Rebuild(JsonNode? node) => node switch
    {
        null => null,
        JsonObject map => new JsonObject(map.Select(entry => KeyValuePair.Create(entry.Key, Rebuild(entry.Value)))),
        JsonArray items => new JsonArray(items.Select(Rebuild).ToArray()),
        JsonValue value when value.GetValueKind() == JsonValueKind.Number =>
            JsonValue.Create(double.Parse(value.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture)),
        _ => JsonNode.Parse(node.ToJsonString()),
    };

    private static Dictionary<string, object?> BindingsFrom(JsonNode? node)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (node is not JsonObject map) return result;
        foreach (var (key, value) in map)
        {
            result[key] = value is null ? null : JsonSerializer.Deserialize<JsonElement>(value.ToJsonString());
        }
        return result;
    }

    private static JsonObject Corpus() =>
        JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsObject();

    private static IEnumerable<object[]> Section(string name)
    {
        foreach (var entry in Corpus()[name]!.AsArray())
        {
            var testCase = entry!.AsObject();
            yield return [testCase["id"]!.GetValue<string>(), testCase.ToJsonString()];
        }
    }

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "repeat-tests.json");
            if (File.Exists(candidate)) return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("spec/repeat-tests.json not found above the test output directory");
    }
}
