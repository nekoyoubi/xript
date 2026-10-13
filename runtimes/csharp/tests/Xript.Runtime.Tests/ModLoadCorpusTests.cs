using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Replays <c>spec/mod-load-tests.json</c>, the corpus that holds the four runtimes' load-time
/// mod diagnostics and entry error policy to one behaviour.
/// </summary>
public class ModLoadCorpusTests
{
    public static IEnumerable<object[]> Cases()
    {
        foreach (var entry in Corpus()["cases"]!.AsArray())
        {
            var testCase = entry!.AsObject();
            yield return [testCase["name"]!.GetValue<string>(), testCase.ToJsonString()];
        }
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Matches_Corpus(string name, string caseJson)
    {
        _ = name;
        var testCase = JsonNode.Parse(caseJson)!.AsObject();
        var seen = new List<ModDiagnostic>();
        using var rt = XriptRuntime.Create(Host(), new RuntimeOptions
        {
            EntryErrors = testCase["entryErrors"]?.GetValue<string>() == "report"
                ? EntryErrorPolicy.Report
                : EntryErrorPolicy.Throw,
            OnModDiagnostic = seen.Add,
        });
        var modJson = testCase["mod"]!.ToJsonString();
        var modName = testCase["mod"]!["name"]!.GetValue<string>();
        var sources = testCase["sources"]!.AsObject()
            .ToDictionary(kv => kv.Key, kv => kv.Value!.GetValue<string>());

        if (testCase["error"]?.GetValue<string>() is { } code)
        {
            var error = Assert.ThrowsAny<Exception>(() => rt.LoadMod(modJson, sources));
            switch (code)
            {
                case "missing-entry-script":
                    Assert.IsType<MissingEntryScriptException>(error);
                    break;
                case "entry-failed":
                    Assert.IsAssignableFrom<ModEntryException>(error);
                    Assert.IsNotType<MissingEntryScriptException>(error);
                    break;
                default:
                    throw new InvalidOperationException($"corpus names an unknown error code `{code}`");
            }
            foreach (var needle in testCase["mentions"]?.AsArray() ?? [])
                Assert.Contains(needle!.GetValue<string>(), error.Message);
            return;
        }

        var instance = rt.LoadMod(modJson, sources);
        var expected = testCase["diagnostics"]!.AsArray();
        Assert.Equal(expected.Count, instance.Diagnostics.Count);
        for (var i = 0; i < expected.Count; i++)
        {
            var got = instance.Diagnostics[i];
            Assert.Equal(modName, got.Mod);
            foreach (var (key, value) in expected[i]!.AsObject())
                Assert.Equal(value!.GetValue<string>(), FieldOf(got, key));
        }
        Assert.Equal(instance.Diagnostics, seen);

        if (testCase["bindingField"] is JsonObject check)
        {
            var fragment = instance.Fragments.Single(f => f.Id == check["fragmentId"]!.GetValue<string>());
            var binding = fragment.Declaration.Bindings!.Single(b => b.Name == check["binding"]!.GetValue<string>());
            var field = check["field"]!.GetValue<string>();
            Assert.Equal(check["value"]!.GetValue<string>(), binding.Extensions![field].GetString());
        }
    }

    [Fact]
    public void Defaults_To_Throw_And_Still_Reports()
    {
        var seen = new List<ModDiagnostic>();
        using var rt = XriptRuntime.Create(Host(), new RuntimeOptions { OnModDiagnostic = seen.Add });
        Assert.Throws<MissingEntryScriptException>(() =>
            rt.LoadMod("""{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": "main.js" }"""));
        Assert.Equal([ModDiagnosticCodes.MissingEntryScript], seen.Select(d => d.Code));
    }

    [Fact]
    public void A_Missing_Script_Stops_Every_Entry_Script_From_Running()
    {
        using var rt = XriptRuntime.Create(Host(), new RuntimeOptions { EntryErrors = EntryErrorPolicy.Report });
        rt.LoadMod(
            """{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": ["a.js", "b.js"] }""",
            new Dictionary<string, string> { ["a.js"] = "globalThis.ranA = true;" });
        Assert.Equal("undefined", rt.Execute("typeof globalThis.ranA").Value.GetString());
    }

    [Fact]
    public void A_Report_Policy_Mod_Still_Fills_Its_Slot()
    {
        using var rt = XriptRuntime.Create(Host(), new RuntimeOptions { EntryErrors = EntryErrorPolicy.Report });
        rt.LoadMod(
            """
            {
                "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": "main.js",
                "fills": { "panel": [{ "format": "text/html", "source": "<p>still here</p>", "inline": true }] }
            }
            """,
            new Dictionary<string, string> { ["main.js"] = "throw new Error('boom');" });
        Assert.Single(rt.ResolveSlot("panel"));
    }

    [Fact]
    public void A_Throwing_Callback_Does_Not_Change_The_Outcome()
    {
        using var rt = XriptRuntime.Create(Host(), new RuntimeOptions
        {
            OnModDiagnostic = _ => throw new InvalidOperationException("callback broke"),
        });
        var instance = rt.LoadMod("""
            {
                "xript": "0.9", "name": "mod-a", "version": "1.0.0",
                "fills": { "panel": [{ "format": "text/html", "source": "<p>x</p>" }] }
            }
            """);
        Assert.Single(instance.Diagnostics);
    }

    [Fact]
    public void A_Typed_Entry_Error_Keeps_Its_Type()
    {
        using var rt = XriptRuntime.Create(Host(), new RuntimeOptions
        {
            HardLimits = new ExecutionLimits { TimeoutMs = 50 },
        });
        Assert.Throws<ExecutionLimitException>(() => rt.LoadMod(
            """{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": "main.js" }""",
            new Dictionary<string, string> { ["main.js"] = "while (true) {}" }));
    }

    [Fact]
    public void A_Throwing_Module_Entry_Under_Report_Is_A_Diagnostic()
    {
        using var rt = XriptRuntime.Create(Host(), new RuntimeOptions { EntryErrors = EntryErrorPolicy.Report });
        var instance = rt.LoadMod(
            """{ "xript": "0.9", "name": "mod-a", "version": "1.0.0", "entry": { "script": "main.js", "format": "module" } }""",
            new Dictionary<string, string> { ["main.js"] = "throw new Error('boom'); export function f() {}" });
        var diagnostic = Assert.Single(instance.Diagnostics);
        Assert.Equal(ModDiagnosticCodes.EntryFailed, diagnostic.Code);
        Assert.Contains("boom", diagnostic.Message);
    }

    [Fact]
    public void Entry_Rule_Reads_Every_Form()
    {
        static JsonElement Entry(string json) => JsonDocument.Parse(json).RootElement;
        Assert.Empty(ModEntry.Scripts(null));
        Assert.Equal(["main.js"], ModEntry.Scripts(Entry("\"main.js\"")));
        Assert.Equal(["a.js", "b.js"], ModEntry.Scripts(Entry("""["a.js", "b.js"]""")));
        Assert.Equal(["m.js"], ModEntry.Scripts(Entry("""{ "script": "m.js", "format": "module" }""")));
        Assert.Equal("script", ModEntry.Format(Entry("\"main.js\"")));
        Assert.Equal("module", ModEntry.Format(Entry("""{ "script": "m.js", "format": "module" }""")));
        Assert.Empty(ModEntry.Exports(Entry("\"main.js\"")));
        Assert.Equal("x", ModEntry.Exports(Entry("""{ "script": "m.js", "exports": { "go": { "capability": "x" } } }"""))["go"]
            .GetProperty("capability").GetString());
    }

    [Fact]
    public void Looks_Like_Markup_Separates_Content_From_File_Names()
    {
        Assert.True(ModDiagnostics.LooksLikeMarkup("<p>x</p>"));
        Assert.True(ModDiagnostics.LooksLikeMarkup("  [\"p\", {}]"));
        Assert.False(ModDiagnostics.LooksLikeMarkup("panel.html"));
        Assert.False(ModDiagnostics.LooksLikeMarkup("[not json"));
    }

    private static string Host() => Corpus()["host"]!.ToJsonString();

    private static JsonObject Corpus() => JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsObject();

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "mod-load-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("could not locate spec/mod-load-tests.json from the test output directory");
    }

    private static string? FieldOf(ModDiagnostic diagnostic, string key) => key switch
    {
        "code" => diagnostic.Code,
        "severity" => diagnostic.Severity.ToString().ToLowerInvariant(),
        "script" => diagnostic.Script,
        "fragmentId" => diagnostic.FragmentId,
        "field" => diagnostic.Field,
        _ => throw new InvalidOperationException($"corpus names an unknown diagnostic field `{key}`"),
    };
}
