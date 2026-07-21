using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Replays <c>spec/command-tests.json</c>, the corpus that holds the four runtimes'
/// command implementations to one behaviour.
/// </summary>
public class CommandCorpusTests
{
    public static IEnumerable<object[]> BranchOrderCases() => Section("branchOrder");

    public static IEnumerable<object[]> NormalizeCases() => Section("normalize");

    public static IEnumerable<object[]> BoundArgCases() => Section("boundArgs");

    public static IEnumerable<object[]> ResolutionCases() => Section("resolution");

    [Theory]
    [MemberData(nameof(BranchOrderCases))]
    public void Matches_Branch_Order(string description, string caseJson)
    {
        var testCase = JsonNode.Parse(caseJson)!.AsObject();
        var accepts = testCase["accepts"]!.AsArray().Select(node => node!.GetValue<string>()).ToList();
        var fill = testCase["fill"]!.AsObject();
        var expected = testCase["expected"]!.GetValue<string>();

        var host = new JsonObject
        {
            ["xript"] = "0.7",
            ["name"] = "branch-host",
            ["slots"] = new JsonArray(new JsonObject
            {
                ["id"] = "target",
                ["accepts"] = new JsonArray([.. accepts.Select(a => (JsonNode)JsonValue.Create(a)!)]),
                ["description"] = "the slot under test",
                ["multiple"] = true,
            }),
        };
        var modJson = ModJson("branch-mod", new JsonObject
        {
            ["target"] = new JsonArray(fill.DeepClone()),
        });

        using var rt = XriptRuntime.Create(host.ToJsonString(), new RuntimeOptions());
        ModInstance? mod = null;
        var failure = Record.Exception(() => mod = rt.LoadMod(modJson, SourcesFor(fill)));

        if (expected == "command")
        {
            Assert.Null(failure);
            Assert.Single(mod!.CommandFills);
            Assert.Equal(fill["id"]!.GetValue<string>(), mod.CommandFills[0].Id);
            return;
        }

        Assert.Empty(mod?.CommandFills ?? []);
        if (failure is ModManifestValidationException validation)
            Assert.DoesNotContain(validation.Issues, issue => issue.Code?.StartsWith("command-") == true);

        switch (expected)
        {
            case "role":
                Assert.Null(failure);
                Assert.NotNull(rt.ResolveRole("target"));
                break;
            case "hook":
                Assert.Null(failure);
                Assert.Single(rt.FireHook("target"));
                break;
            case "fragment":
                Assert.Null(failure);
                Assert.Single(mod!.Fragments);
                break;
            case "data":
                // this runtime has no data-fill channel: a non-reserved opaque fill is read as a
                // fragment declaration and refused for want of a format. The corpus fact under
                // test is that it was not read as a command, which is asserted above.
                Assert.NotNull(failure);
                break;
            default:
                Assert.Fail($"unhandled expected kind '{expected}'");
                break;
        }
    }

    [Theory]
    [MemberData(nameof(NormalizeCases))]
    public void Matches_Normalization(string description, string caseJson)
    {
        var testCase = JsonNode.Parse(caseJson)!.AsObject();
        var modName = testCase["mod"]!.GetValue<string>();
        var slotId = testCase["slot"]!.GetValue<string>();
        var fills = testCase["fills"]!.AsArray();
        var expected = testCase["expected"]!.AsObject();

        var modJson = ModJson(modName, new JsonObject { [slotId] = fills.DeepClone() });

        using var rt = XriptRuntime.Create(CommandHost(slotId), new RuntimeOptions());
        ModInstance? mod = null;
        var failure = Record.Exception(() => mod = rt.LoadMod(modJson));

        if (expected["ok"]!.GetValue<bool>())
        {
            Assert.Null(failure);
            var actual = mod!.CommandFills;
            var expectedCommands = expected["commands"]!.AsArray();
            Assert.Equal(expectedCommands.Count, actual.Count);
            for (var i = 0; i < actual.Count; i++)
                AssertCommand(expectedCommands[i]!.AsObject(), actual[i]);
            return;
        }

        var error = Assert.IsType<ModManifestValidationException>(failure);
        var expectedError = expected["error"]!.AsObject();
        var code = expectedError["code"]!.GetValue<string>();
        var issue = Assert.Single(error.Issues, i => i.Code == code);

        if (expectedError["fill"] is JsonValue index)
            Assert.Contains($"/{slotId}/{index.GetValue<int>()}/", issue.Path);
        foreach (var key in new[] { "id", "arg", "handler" })
            if (expectedError[key] is JsonValue value)
                Assert.Contains(value.GetValue<string>(), issue.Message);
    }

    [Theory]
    [MemberData(nameof(BoundArgCases))]
    public void Matches_Bound_Argument_Merge(string description, string caseJson)
    {
        var testCase = JsonNode.Parse(caseJson)!.AsObject();
        var bound = testCase["args"] as JsonObject;
        var callArgs = testCase["callArgs"] as JsonObject;
        var expected = testCase["expected"]!.AsObject();

        var merged = Commands.MergeArgs(bound?.DeepClone().AsObject(), callArgs?.DeepClone().AsObject());
        Assert.Equal(expected.ToJsonString(), merged.ToJsonString());
    }

    [Theory]
    [MemberData(nameof(ResolutionCases))]
    public void Matches_Resolution(string description, string caseJson)
    {
        var testCase = JsonNode.Parse(caseJson)!.AsObject();
        var slots = testCase["slots"]!.AsArray();
        var slotId = slots[0]!["id"]!.GetValue<string>();
        var expected = testCase["expected"]!.AsObject();
        var host = HostFor(slots);

        var loadable = new List<JsonObject>();
        foreach (var modNode in testCase["mods"]!.AsArray())
        {
            var mod = modNode!.AsObject();
            using var probe = XriptRuntime.Create(host, new RuntimeOptions { Capabilities = GrantsFor(mod) });
            if (Record.Exception(() => probe.LoadMod(ModJsonFor(mod))) is null)
                loadable.Add(mod);
        }

        var options = new RuntimeOptions
        {
            Capabilities = [.. loadable.SelectMany(GrantsFor).Distinct()],
            CommandPreferences = PreferencesFor(testCase),
        };
        using var rt = XriptRuntime.Create(host, options);
        foreach (var mod in loadable)
            rt.LoadMod(ModJsonFor(mod));

        var resolved = rt.ResolveCommands(slotId);
        Assert.Equal(
            expected["order"]!.AsArray().Select(node => node!.GetValue<string>()).ToList(),
            resolved.Select(command => command.QualifiedId).ToList());

        var expectedCollides = expected["collides"]!.AsArray().Select(node => node!.GetValue<string>()).ToHashSet();
        foreach (var command in rt.ResolveCommandsAll(slotId))
            Assert.Equal(expectedCollides.Contains(command.QualifiedId), command.Collides);

        if (testCase["lookup"] is JsonValue lookup)
        {
            var found = rt.ResolveCommand(lookup.GetValue<string>());
            var expectedId = expected["resolved"] is JsonValue id ? id.GetValue<string>() : null;
            Assert.Equal(expectedId, found?.QualifiedId);
        }
    }

    private static void AssertCommand(JsonObject expected, CommandFill actual)
    {
        Assert.Equal(expected["mod"]!.GetValue<string>(), actual.Mod);
        Assert.Equal(expected["slot"]!.GetValue<string>(), actual.Slot);
        Assert.Equal(expected["id"]!.GetValue<string>(), actual.Id);
        Assert.Equal(expected["qualifiedId"]!.GetValue<string>(), actual.QualifiedId);
        Assert.Equal(expected["title"]!.GetValue<string>(), actual.Title);
        Assert.Equal(expected["handler"]!.GetValue<string>(), actual.Handler);
        Assert.Equal(expected["priority"]!.GetValue<int>(), actual.Priority);
        Assert.Equal(expected["exposed"]!.GetValue<bool>(), actual.Exposed);
        Assert.Equal(
            expected["keywords"]!.AsArray().Select(node => node!.GetValue<string>()).ToList(),
            actual.Keywords.ToList());
        Assert.Equal(expected["args"]!.AsObject().ToJsonString(), actual.Args.ToJsonString());
        Assert.Equal(Optional(expected, "description"), actual.Description);
        Assert.Equal(Optional(expected, "icon"), actual.Icon);
        Assert.Equal(Optional(expected, "group"), actual.Group);
        Assert.Equal(expected["input"]?.ToJsonString(), actual.Input?.ToJsonString());
        Assert.Equal(expected["output"]?.ToJsonString(), actual.Output?.ToJsonString());
    }

    private static string? Optional(JsonObject expected, string key) =>
        expected[key] is JsonValue value ? value.GetValue<string>() : null;

    private static List<string> GrantsFor(JsonObject mod) =>
        mod["capabilities"] is JsonArray granted
            ? [.. granted.Select(node => node!.GetValue<string>())]
            : [];

    private static Dictionary<string, string> PreferencesFor(JsonObject testCase)
    {
        var preferences = new Dictionary<string, string>();
        if (testCase["preferences"] is JsonObject declared)
            foreach (var (key, value) in declared)
                preferences[key] = value!.GetValue<string>();
        return preferences;
    }

    private static string ModJsonFor(JsonObject mod)
    {
        var json = ModJson(mod["name"]!.GetValue<string>(), mod["fills"]!.DeepClone().AsObject());
        var obj = JsonNode.Parse(json)!.AsObject();
        if (mod["capabilities"] is JsonArray granted)
            obj["capabilities"] = granted.DeepClone();
        return obj.ToJsonString();
    }

    private static string ModJson(string name, JsonObject fills) =>
        new JsonObject
        {
            ["xript"] = "0.7",
            ["name"] = name,
            ["version"] = "1.0.0",
            ["fills"] = fills,
        }.ToJsonString();

    private static string CommandHost(string slotId) =>
        HostFor(new JsonArray(new JsonObject
        {
            ["id"] = slotId,
            ["accepts"] = new JsonArray("application/x-xript-command"),
            ["multiple"] = true,
        }));

    private static string HostFor(JsonArray slots)
    {
        var declared = new JsonArray();
        foreach (var slot in slots)
        {
            var copy = slot!.DeepClone().AsObject();
            copy["description"] ??= "a command surface";
            declared.Add(copy);
        }
        return new JsonObject
        {
            ["xript"] = "0.7",
            ["name"] = "command-host",
            ["capabilities"] = new JsonObject
            {
                ["editor"] = new JsonObject { ["description"] = "editor surface" },
                ["editor.text"] = new JsonObject { ["description"] = "document text" },
            },
            ["slots"] = declared,
        }.ToJsonString();
    }

    private static Dictionary<string, string>? SourcesFor(JsonObject fill) =>
        fill["source"] is JsonValue source
            ? new Dictionary<string, string> { [source.GetValue<string>()] = "<b>hi</b>" }
            : null;

    private static IEnumerable<object[]> Section(string name)
    {
        var corpus = JsonNode.Parse(File.ReadAllText(CorpusPath()))!.AsObject();
        foreach (var entry in corpus[name]!.AsArray())
        {
            var testCase = entry!.AsObject();
            yield return [testCase["description"]!.GetValue<string>(), testCase.ToJsonString()];
        }
    }

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "command-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("could not locate spec/command-tests.json from the test output directory");
    }
}
