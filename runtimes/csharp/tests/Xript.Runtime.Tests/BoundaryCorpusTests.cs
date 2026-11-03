using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds the host boundary to the shared corpora in <c>spec/value-fidelity-tests.json</c>
/// (run with <see cref="RuntimeOptions.ValueFidelity"/> on), <c>spec/key-order-tests.json</c>,
/// and <c>spec/hook-phase-tests.json</c>.
/// </summary>
public class BoundaryCorpusTests
{
    private const string FidelityHook =
        "hooks.probe(function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";

    private const string FidelityEvent =
        "events.on('probed', function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";

    private const string KeyOrderHook =
        "hooks.probe(function () { return Array.prototype.join.call(arguments, ','); })";

    public static TheoryData<string, int, string> Cases()
    {
        var data = new TheoryData<string, int, string>();
        foreach (var section in new[] { "inbound", "echo", "results", "hook", "event", "eventResult" })
        {
            var cases = Load("value-fidelity-tests.json")[section]!.AsArray();
            for (var i = 0; i < cases.Count; i++)
                data.Add($"fidelity.{section}", i, cases[i]!["name"]!.GetValue<string>());
        }
        foreach (var section in new[] { "inbound", "echo", "hook" })
        {
            var cases = Load("key-order-tests.json")[section]!.AsArray();
            for (var i = 0; i < cases.Count; i++)
                data.Add($"order.{section}", i, cases[i]!["name"]!.GetValue<string>());
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Matches_Shared_Boundary_Corpora(string section, int index, string name)
    {
        var fidelity = section.StartsWith("fidelity.");
        var corpus = Load(fidelity ? "value-fidelity-tests.json" : "key-order-tests.json");
        var kind = section[(section.IndexOf('.') + 1)..];
        var testCase = corpus[kind]!.AsArray()[index]!.AsObject();

        var hostValue = testCase["hostValue"] is { } hv ? Element(hv) : Element(null);
        JsonElement[] received = [];
        var bindings = new HostBindings();
        bindings.AddFunction("value", _ => hostValue);
        bindings.AddFunction("echo", args =>
        {
            received = args;
            return JsonSerializer.SerializeToElement(args);
        });

        using var rt = XriptRuntime.Create(
            corpus["manifest"]!.ToJsonString(),
            new RuntimeOptions { HostBindings = bindings, ValueFidelity = fidelity });

        switch (kind)
        {
            case "inbound":
            {
                var value = rt.Execute($"(function () {{ var v = value(); return ({testCase["probe"]!.GetValue<string>()}); }})()").Value;
                Assert.True(testCase["expected"]!.GetValue<string>() == value.GetString(), $"{name}: got {value}");
                break;
            }
            case "echo":
            {
                var value = rt.Execute(testCase["script"]!.GetValue<string>()).Value;
                Assert.True(testCase["expected"]!.GetValue<string>() == value.GetString(), $"{name}: got {value}");
                if (testCase["received"] is { } expectedReceived)
                    Assert.True(JsonNode.DeepEquals(expectedReceived, JsonSerializer.SerializeToNode(received)),
                        $"{name}: host received {JsonSerializer.Serialize(received)}");
                break;
            }
            case "results":
            {
                var value = rt.Execute(testCase["script"]!.GetValue<string>()).Value;
                Assert.True(JsonNode.DeepEquals(testCase["expected"], JsonNode.Parse(value.GetRawText())),
                    $"{name}: got {value.GetRawText()}");
                break;
            }
            case "hook":
            {
                rt.Execute(fidelity ? FidelityHook : KeyOrderHook);
                var results = rt.FireHook("probe", new FireHookOptions { Data = Element(testCase["data"]) });
                Assert.Single(results);
                Assert.Equal(testCase["expected"]!.GetValue<string>(), results[0].GetString());
                break;
            }
            case "event":
            {
                rt.Execute(FidelityEvent);
                var results = rt.Emit("probed", new FireHookOptions { Data = Element(testCase["data"]) });
                Assert.Single(results);
                Assert.Equal(testCase["expected"]!.GetValue<string>(), results[0].GetString());
                break;
            }
            case "eventResult":
            {
                rt.Execute($"events.on('probed', function () {{ return {testCase["returns"]!.GetValue<string>()}; }})");
                var results = rt.Emit("probed");
                Assert.Single(results);
                Assert.True(JsonNode.DeepEquals(testCase["expected"], JsonNode.Parse(results[0].GetRawText())),
                    $"{name}: got {results[0].GetRawText()}");
                break;
            }
        }
    }

    [Fact]
    public void Hook_Phases_Fire_One_Phase_At_A_Time()
    {
        var corpus = Load("hook-phase-tests.json");
        using var rt = XriptRuntime.Create(corpus["manifest"]!.ToJsonString());
        rt.LoadMod(corpus["mod"]!["manifest"]!.ToJsonString(),
            new Dictionary<string, string> { ["mod.js"] = corpus["mod"]!["source"]!.GetValue<string>() });
        rt.Execute(corpus["setup"]!.GetValue<string>());
        foreach (var node in corpus["cases"]!.AsArray())
        {
            var testCase = node!.AsObject();
            var options = new FireHookOptions
            {
                Phase = testCase["phase"]!.GetValue<string>(),
                Data = testCase.ContainsKey("data") ? Element(testCase["data"]) : null,
            };
            var results = rt.FireHook(testCase["hook"]!.GetValue<string>(), options);
            Assert.True(JsonNode.DeepEquals(testCase["expected"], JsonSerializer.SerializeToNode(results)),
                $"{testCase["name"]}: got {JsonSerializer.Serialize(results)}");
        }
    }

    [Fact]
    public void Negative_Zero_Crosses_At_Any_Depth()
    {
        var corpus = Load("value-fidelity-tests.json");
        JsonElement[] received = [];
        var bindings = new HostBindings();
        bindings.AddFunction("echo", args =>
        {
            received = args;
            return JsonSerializer.SerializeToElement(args);
        });
        using var rt = XriptRuntime.Create(corpus["manifest"]!.ToJsonString(),
            new RuntimeOptions { HostBindings = bindings, ValueFidelity = true });
        var result = rt.Execute(
            "(function () { var r = echo({ z: -0, list: [-0, 1] }); return [Object.is(r[0].z, -0), Object.is(r[0].list[0], -0)].join('|'); })()");
        Assert.Equal("true|true", result.Value.GetString());
        Assert.Equal("""[{"z":{"$xript":"-0"},"list":[{"$xript":"-0"},1]}]""", JsonSerializer.Serialize(received));
        Assert.Equal("""{"z":{"$xript":"-0"}}""", rt.Execute("({ z: -0 })").Value.GetRawText());
    }

    [Fact]
    public void Without_Fidelity_Specials_Are_Null()
    {
        var corpus = Load("value-fidelity-tests.json");
        JsonElement[] received = [];
        var bindings = new HostBindings();
        bindings.AddFunction("value", _ => XriptValue.NaN);
        bindings.AddFunction("echo", args =>
        {
            received = args;
            return Element(null);
        });
        using var rt = XriptRuntime.Create(corpus["manifest"]!.ToJsonString(), new RuntimeOptions { HostBindings = bindings });
        Assert.Equal(JsonValueKind.Null, rt.Execute("undefined").Value.ValueKind);
        Assert.Equal(JsonValueKind.Null, rt.Execute("0 / 0").Value.ValueKind);
        rt.Execute("echo(Infinity, undefined, 1)");
        Assert.Equal("[null,null,1]", JsonSerializer.Serialize(received));
        Assert.Equal("object", rt.Execute("typeof value()").Value.GetString());
        Assert.Equal("0", rt.Execute("-0").Value.GetRawText());
        rt.Execute("echo(-0)");
        Assert.Equal("[0]", JsonSerializer.Serialize(received));
    }

    [Fact]
    public void Helpers_Build_And_Read_Markers()
    {
        Assert.True(XriptValue.IsUndefined(XriptValue.Undefined));
        Assert.True(XriptValue.TryGetNumber(XriptValue.NegativeInfinity, out var negative) && double.IsNegativeInfinity(negative));
        Assert.True(XriptValue.TryGetNumber(XriptValue.Number(10.0), out var ten) && ten == 10);
        Assert.Equal("10", XriptValue.Number(10.0).GetRawText());
        Assert.True(XriptValue.TryGetSpecial(XriptValue.Number(double.NaN), out var special) && special == XriptSpecial.NaN);
        Assert.False(XriptValue.TryGetSpecial(JsonDocument.Parse("""{ "$xript": "NaN", "x": 1 }""").RootElement, out _));
        Assert.Equal("""{"$xript":"-0"}""", XriptValue.NegativeZero.GetRawText());
        Assert.Equal("""{"$xript":"-0"}""", XriptValue.Number(-0.0).GetRawText());
        Assert.Equal("0", XriptValue.Number(0.0).GetRawText());
        Assert.True(XriptValue.TryGetNumber(XriptValue.NegativeZero, out var zero) && zero == 0 && double.IsNegative(zero));
    }

    private static JsonElement Element(JsonNode? node) =>
        JsonDocument.Parse(node?.ToJsonString() ?? "null").RootElement.Clone();

    private static JsonObject Load(string file) =>
        JsonNode.Parse(File.ReadAllText(CorpusPath(file)))!.AsObject();

    private static string CorpusPath(string file)
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", file);
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException($"could not locate spec/{file} from the test output directory");
    }
}
