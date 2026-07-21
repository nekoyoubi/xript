using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime.Expressions;
using Xript.Runtime.Fragments;

namespace Xript.Runtime.Tests;

/// <summary>
/// Replays <c>spec/expression-tests.json</c>, the corpus that holds every runtime's
/// expression implementation to one behaviour.
///
/// The corpus exists because its absence was the root cause: five readings of the same
/// attribute drifted apart because nothing ever asserted they agreed.
/// </summary>
public class ExpressionCorpusTests
{
    public static IEnumerable<object[]> EvaluationCases() => Section("cases");
    public static IEnumerable<object[]> RejectCases() => Section("rejects");
    public static IEnumerable<object[]> InterpolationCases() => Section("interpolation");
    public static IEnumerable<object[]> SafetyCases() => Section("safety");
    public static IEnumerable<object[]> AttributeCases() => Section("attributes");
    public static IEnumerable<object[]> ConditionCases() => Section("conditions");
    public static IEnumerable<object[]> BindCases() => Section("bind");

    [Theory]
    [MemberData(nameof(EvaluationCases))]
    public void EvaluatesToTheCorpusValue(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var bindings = BindingsFrom(testCase["bindings"] ?? Corpus()["defaultBindings"]);
        var actual = Xeg.Evaluate(testCase["expression"]!.GetValue<string>(), bindings);

        Assert.True(
            ValuesEqual(actual, testCase["expect"]),
            $"{id}: `{testCase["expression"]}` -> {Describe(actual)} (expected {testCase["expect"]?.ToJsonString() ?? "null"})");
    }

    [Theory]
    [MemberData(nameof(RejectCases))]
    public void RefusesWhatTheGrammarDoesNotContain(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var expression = testCase["expression"]!.GetValue<string>();

        Assert.False(ExpressionParser.TryParse(expression, out _, out _), $"{id}: parsed but must not");
        Assert.Null(Xeg.Evaluate(expression, new Dictionary<string, object?>()));
        Assert.False(Xeg.EvaluateCondition(expression, BindingsFrom(Corpus()["defaultBindings"])), id);
    }

    [Theory]
    [MemberData(nameof(InterpolationCases))]
    public void SegmentsTextNodesTheSameWay(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var result = Interpolation.SegmentText(testCase["text"]!.GetValue<string>());

        if (testCase["invalid"]?.GetValue<bool>() == true)
        {
            Assert.True(result.Issues.Count > 0, $"{id}: expected a segmentation issue");
            return;
        }

        Assert.True(result.Issues.Count == 0, $"{id}: unexpected issues");

        var expected = testCase["segments"];
        if (expected is null)
        {
            Assert.Null(result.Segments);
            return;
        }

        Assert.NotNull(result.Segments);
        var actual = result.Segments!;
        var expectedArray = expected.AsArray();
        Assert.Equal(expectedArray.Count, actual.Count);

        for (var i = 0; i < actual.Count; i++)
        {
            var entry = expectedArray[i]!.AsObject();
            if (entry["kind"]!.GetValue<string>() == "literal")
            {
                var literal = Assert.IsType<TextSegment.Literal>(actual[i]);
                Assert.Equal(entry["value"]!.GetValue<string>(), literal.Value);
            }
            else
            {
                var expr = Assert.IsType<TextSegment.Expr>(actual[i]);
                Assert.Equal(entry["source"]!.GetValue<string>(), expr.Source);
            }
        }
    }

    [Theory]
    [MemberData(nameof(SafetyCases))]
    public void AnInterpolatedValueCannotBecomeMarkup(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var bindings = BindingsFrom(testCase["bindings"]);
        var result = Render(
            $"<p>{testCase["text"]!.GetValue<string>()}</p>", "text/html", bindings, interpolate: true);

        Assert.Equal($"<p>{testCase["html"]!.GetValue<string>()}</p>", result.Html);

        var paragraph = Assert.IsType<FragmentNode.Element>(result.Tree[0]);
        var text = Assert.IsType<FragmentNode.Text>(Assert.Single(paragraph.Children));
        Assert.Equal(testCase["rendered"]!.GetValue<string>(), text.Value);
        Assert.Null(text.Segments);
    }

    [Theory]
    [MemberData(nameof(AttributeCases))]
    public void AttributeSinksAreUnreachableFromInterpolation(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var result = Render(
            testCase["source"]!.GetValue<string>(),
            testCase["format"]!.GetValue<string>(),
            BindingsFrom(testCase["bindings"]),
            interpolate: true);

        Assert.Equal(testCase["expectedHtml"]!.GetValue<string>(), result.Html);
    }

    [Theory]
    [MemberData(nameof(ConditionCases))]
    public void ConditionsAreKeyedByTreePosition(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var result = Render(
            testCase["source"]!.GetValue<string>(),
            "text/html",
            BindingsFrom(testCase["bindings"]),
            interpolate: false);

        var expected = testCase["expected"]!.AsArray();
        Assert.Equal(expected.Count, result.Conditions.Count);

        for (var i = 0; i < expected.Count; i++)
        {
            var entry = expected[i]!.AsObject();
            Assert.Equal(
                entry["path"]!.AsArray().Select(node => node!.GetValue<int>()).ToList(),
                result.Conditions[i].Path);
            Assert.Equal(entry["expression"]!.GetValue<string>(), result.Conditions[i].Expression);
            Assert.Equal(entry["visible"]!.GetValue<bool>(), result.Conditions[i].Visible);
        }
    }

    [Theory]
    [MemberData(nameof(BindCases))]
    public void ClassifiesWhatIsWritable(string id, string json)
    {
        var testCase = JsonNode.Parse(json)!.AsObject();
        var expected = testCase["kind"]!.GetValue<string>() == "name"
            ? ExpressionKind.Name
            : ExpressionKind.Expression;

        Assert.Equal(expected, Xeg.Kind(testCase["expression"]!.GetValue<string>()));
    }

    [Fact]
    public void InterpolationIsOptIn()
    {
        var bindings = new Dictionary<string, object?> { ["hp"] = 35 };

        Assert.Equal(
            "<p>Health: {{ hp }}</p>",
            Render("<p>Health: {{ hp }}</p>", "text/html", bindings, interpolate: false).Html);
        Assert.Equal(
            "<p>Health: 35</p>",
            Render("<p>Health: {{ hp }}</p>", "text/html", bindings, interpolate: true).Html);
    }

    [Fact]
    public void AnExpressionValuedDataBindComputes()
    {
        var bindings = new Dictionary<string, object?> { ["hp"] = 35, ["maxHp"] = 100 };
        Assert.Equal(
            "<p data-bind=\"round(hp / maxHp * 100)\">35</p>",
            Render("<p data-bind=\"round(hp / maxHp * 100)\">0</p>", "text/html", bindings, false).Html);
    }

    [Fact]
    public void ABareNameWithNoBindingKeepsItsFallback()
    {
        Assert.Equal(
            "<p data-bind=\"missing\">fallback</p>",
            Render("<p data-bind=\"missing\">fallback</p>", "text/html", new Dictionary<string, object?>(), false).Html);
    }

    [Fact]
    public void ACompoundConditionIsNoLongerSilentlyFalse()
    {
        var bindings = new Dictionary<string, object?> { ["alive"] = true, ["health"] = 35 };
        Assert.True(FragmentProcessor.EvaluateCondition("alive && health < 50", bindings));
        Assert.False(FragmentProcessor.EvaluateCondition("alive && health > 50", bindings));
    }

    [Fact]
    public void NothingOnThisPathReachesTheCommonLanguageRuntime()
    {
        var bindings = new Dictionary<string, object?> { ["hp"] = 1 };

        Assert.False(FragmentProcessor.EvaluateCondition("System.Environment.Exit(0)", bindings));
        Assert.False(FragmentProcessor.EvaluateCondition("hp.GetType()", bindings));
        Assert.False(FragmentProcessor.EvaluateCondition("globalThis", bindings));
        Assert.False(FragmentProcessor.EvaluateCondition("eval('1')", bindings));
        Assert.Equal(1, bindings["hp"]);
    }

    [Fact]
    public void ABindingCannotSmuggleACallableIntoTheEvaluator()
    {
        var called = false;
        var bindings = new Dictionary<string, object?>
        {
            ["boom"] = new Func<int>(() => { called = true; return 1; }),
        };

        Assert.Null(Xeg.Evaluate("boom", bindings));
        Assert.False(ExpressionParser.TryParse("boom()", out _, out _));
        Assert.False(called);
    }

    [Fact]
    public void AnUnparseableSiteIsASanitizeTimeDiagnostic()
    {
        var profile = FormatProfiles.Resolve("text/html", null, null)!;
        var sanitized = FragmentSanitizer.Sanitize("<p>{{ hp = 1 }}</p>", profile, false, true);
        var error = Assert.Single(
            sanitized.Diagnostics.Where(d => d.Code == DiagnosticCodes.InvalidExpression));
        Assert.Equal(DiagnosticSeverity.Error, error.Severity);
    }

    [Fact]
    public void AnUnclosedDelimiterIsNotADiagnostic()
    {
        var profile = FormatProfiles.Resolve("text/html", null, null)!;
        var sanitized = FragmentSanitizer.Sanitize("<p>use {{ to open</p>", profile, false, true);
        Assert.Empty(sanitized.Diagnostics.Where(d => d.Code == DiagnosticCodes.InvalidExpression));
    }

    private static FragmentResult Render(
        string source, string format, Dictionary<string, object?> bindings, bool interpolate)
    {
        var declaration = new FragmentDeclaration
        {
            Id = "corpus",
            Slot = "corpus",
            Format = format,
            Source = source,
            Inline = true,
            Interpolate = interpolate,
            Bindings = bindings.Keys
                .Select(name => new FragmentBinding { Name = name, Path = name })
                .ToList(),
        };

        return FragmentInstance.Create(declaration, source, null, null, false, null).GetContent(bindings);
    }

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

    private static bool ValuesEqual(object? actual, JsonNode? expected)
    {
        if (expected is null) return actual is null;

        return expected.GetValueKind() switch
        {
            JsonValueKind.Null => actual is null,
            JsonValueKind.True => actual is true,
            JsonValueKind.False => actual is false,
            JsonValueKind.Number => actual is double d
                && Math.Abs(d - expected.GetValue<double>()) < 1e-9,
            JsonValueKind.String => actual is string s && s == expected.GetValue<string>(),
            JsonValueKind.Array => actual is List<object?> items
                && items.Count == expected.AsArray().Count
                && items.Select((item, i) => ValuesEqual(item, expected.AsArray()[i])).All(x => x),
            JsonValueKind.Object => actual is Dictionary<string, object?> map
                && map.Count == expected.AsObject().Count
                && expected.AsObject().All(entry =>
                    map.TryGetValue(entry.Key, out var value) && ValuesEqual(value, entry.Value)),
            _ => false,
        };
    }

    private static string Describe(object? value) =>
        value is null ? "null" : $"{value} ({value.GetType().Name})";

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
            var candidate = Path.Combine(dir, "spec", "expression-tests.json");
            if (File.Exists(candidate)) return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException(
            "could not locate spec/expression-tests.json from the test output directory");
    }
}
