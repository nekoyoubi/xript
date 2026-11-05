using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared names-as-data corpus: every name a manifest, a mod manifest, or a host call
/// carries reaches the sandbox as data, so no name breaks the runtime or runs as script.
/// </summary>
public class NamesAsDataCorpusTests
{
    private const string Token = "$NAME";

    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "names-as-data-tests.json");
            return JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(path))).RootElement.Clone();
        }
    }

    public static TheoryData<string, string> Pairs()
    {
        var data = new TheoryData<string, string>();
        foreach (var testCase in Corpus.GetProperty("cases").EnumerateArray())
            foreach (var name in Corpus.GetProperty("names").EnumerateArray())
                data.Add(testCase.GetProperty("name").GetString()!, name.GetProperty("label").GetString()!);
        return data;
    }

    private static JsonNode? PlaceData(JsonNode? node, string name) => node switch
    {
        JsonValue value when value.TryGetValue<string>(out var text) && text == Token => JsonValue.Create(name),
        JsonArray array => new JsonArray(array.Select(item => PlaceData(item, name)).ToArray()),
        JsonObject obj => new JsonObject(obj.Select(entry =>
            KeyValuePair.Create(entry.Key == Token ? name : entry.Key, PlaceData(entry.Value, name)))),
        null => null,
        _ => node.DeepClone(),
    };

    private static JsonNode? PlaceData(JsonElement element, string name) => PlaceData(JsonNode.Parse(element.GetRawText()), name);

    private static string PlaceSource(string source, string name) =>
        source.Replace(Token, JsonSerializer.Serialize(name));

    private static HostBindings Provide(JsonNode? provide)
    {
        var bindings = new HostBindings();
        if (provide is not JsonArray paths) return bindings;
        HostFunction ok = _ => JsonSerializer.SerializeToElement("ok");
        var namespaces = new Dictionary<string, Dictionary<string, HostFunction>>();
        foreach (var path in paths)
        {
            var segments = path!.AsArray().Select(s => s!.GetValue<string>()).ToArray();
            if (segments.Length == 1)
                bindings.AddFunction(segments[0], ok);
            else if (segments.Length == 2)
            {
                if (!namespaces.TryGetValue(segments[0], out var members))
                    namespaces[segments[0]] = members = new Dictionary<string, HostFunction>();
                members[segments[1]] = ok;
            }
            else
                throw new InvalidOperationException("the runner provides paths of one or two segments");
        }
        foreach (var (ns, members) in namespaces)
            bindings.AddNamespace(ns, members);
        return bindings;
    }

    [Theory]
    [MemberData(nameof(Pairs))]
    public void Every_Name_Reaches_The_Sandbox_As_Data(string caseName, string label)
    {
        var testCase = Corpus.GetProperty("cases").EnumerateArray().First(c => c.GetProperty("name").GetString() == caseName);
        var name = Corpus.GetProperty("names").EnumerateArray().First(n => n.GetProperty("label").GetString() == label)
            .GetProperty("value").GetString()!;

        var provide = testCase.TryGetProperty("provide", out var provided) ? PlaceData(provided, name) : null;
        using var rt = XriptRuntime.Create(
            PlaceData(testCase.GetProperty("manifest"), name)!.ToJsonString(),
            new RuntimeOptions { HostBindings = Provide(provide) });

        if (testCase.TryGetProperty("mod", out var mod))
        {
            var manifest = PlaceData(mod.GetProperty("manifest"), name)!;
            var script = manifest["entry"]!["script"]!.GetValue<string>();
            rt.LoadMod(manifest.ToJsonString(), new Dictionary<string, string>
            {
                [script] = PlaceSource(mod.GetProperty("source").GetString()!, name),
            });
        }
        if (testCase.TryGetProperty("setup", out var setup))
            rt.Execute(PlaceSource(setup.GetString()!, name));

        foreach (var raw in testCase.GetProperty("steps").EnumerateArray())
        {
            var step = PlaceData(raw, name)!.AsObject();
            if (raw.TryGetProperty("execute", out var source))
            {
                var value = rt.Execute(PlaceSource(source.GetString()!, name)).Value;
                if (step["includes"] is JsonArray parts)
                {
                    Assert.Equal(JsonValueKind.String, value.ValueKind);
                    foreach (var part in parts)
                        Assert.Contains(part!.GetValue<string>(), value.GetString()!);
                }
                else
                    Assert.Equal(step["expected"]!.ToJsonString(), JsonNode.Parse(value.GetRawText())!.ToJsonString());
            }
            else if (step["fire"] is { } hook)
            {
                var data = JsonSerializer.SerializeToElement(step["data"]);
                var results = rt.FireHook(hook.GetValue<string>(), new FireHookOptions
                {
                    Phase = step["phase"]?.GetValue<string>(),
                    Data = data,
                });
                Assert.Equal(step["expected"]!.ToJsonString(), JsonSerializer.Serialize(results));
            }
            else if (step["fragment"] is { } fragment)
            {
                var ops = rt.FireFragmentHook(fragment.GetValue<string>(), step["lifecycle"]!.GetValue<string>());
                Assert.Equal(step["ops"]!.GetValue<int>(), ops.Length);
            }
            else if (step["invoke"] is { } export)
            {
                var value = step["mod"] is { } owner
                    ? rt.InvokeModExport(owner.GetValue<string>(), export.GetValue<string>(), [])
                    : rt.InvokeExport(export.GetValue<string>(), []);
                Assert.Equal(step["expected"]!.ToJsonString(), JsonNode.Parse(value.GetRawText())!.ToJsonString());
            }
            else
                throw new InvalidOperationException($"unknown step {step.ToJsonString()}");
        }

        Assert.Equal("undefined", rt.Execute("typeof globalThis.ran").Value.GetString());
    }
}
