using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds the host boundary to the shared corpora in <c>spec/value-fidelity-tests.json</c>
/// (run with <see cref="RuntimeOptions.ValueFidelity"/> on), <c>spec/key-order-tests.json</c>,
/// <c>spec/hook-phase-tests.json</c>, and the sections of <c>spec/async-tests.json</c> C# has a surface for.
/// </summary>
public class BoundaryCorpusTests
{
    private const string FidelityHook =
        "hooks.probe(function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";

    private const string FidelityEvent =
        "events.on('probed', function () { return Array.prototype.map.call(arguments, String).join('|') + '#' + arguments.length; })";

    private const string KeyOrderHook =
        "hooks.probe(function () { return Array.prototype.join.call(arguments, ','); })";

    private static readonly string[] FidelitySections =
        ["inbound", "echo", "sink", "results", "hook", "event", "eventResult", "callbackResult", "depth", "prefix"];

    private static readonly string[] OrderSections = ["inbound", "echo", "hook"];

    private static readonly JsonDocumentOptions Deep = new() { MaxDepth = XriptValue.MaxDepth + 10 };

    public static TheoryData<string, int, string> Cases()
    {
        var data = new TheoryData<string, int, string>();
        foreach (var (prefix, file, sections) in new[]
        {
            ("fidelity", "value-fidelity-tests.json", FidelitySections),
            ("order", "key-order-tests.json", OrderSections),
        })
        {
            var corpus = Load(file);
            foreach (var section in sections)
            {
                if (corpus[section] is not JsonArray cases) continue;
                for (var i = 0; i < cases.Count; i++)
                    data.Add($"{prefix}.{section}", i, cases[i]!["name"]!.GetValue<string>());
            }
        }
        return data;
    }

    /// <summary>The host's arguments as one array, at any depth <see cref="XriptValue.MaxDepth"/> allows.</summary>
    private static JsonElement ArrayOf(JsonElement[] items) =>
        JsonDocument.Parse("[" + string.Join(",", items.Select(item => item.GetRawText())) + "]", Deep).RootElement.Clone();

    private static JsonNode? NodeOf(JsonElement value) => JsonNode.Parse(value.GetRawText(), documentOptions: Deep);

    /// <summary>
    /// Structural equality that compares numbers by value, since <see cref="JsonNode.DeepEquals"/>
    /// tells <c>1e21</c> and <c>1e+21</c> apart by their text.
    /// </summary>
    private static bool SameValue(JsonNode? expected, JsonNode? actual) => (expected, actual) switch
    {
        (null, null) => true,
        (JsonObject e, JsonObject a) => e.Count == a.Count
            && e.All(property => a.TryGetPropertyValue(property.Key, out var other) && SameValue(property.Value, other)),
        (JsonArray e, JsonArray a) => e.Count == a.Count && e.Zip(a).All(pair => SameValue(pair.First, pair.Second)),
        (JsonValue e, JsonValue a) when e.GetValueKind() == JsonValueKind.Number && a.GetValueKind() == JsonValueKind.Number =>
            e.GetValue<double>().Equals(a.GetValue<double>()),
        (JsonValue e, JsonValue a) => JsonNode.DeepEquals(e, a),
        _ => false,
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void Matches_Shared_Boundary_Corpora(string section, int index, string name)
    {
        var fidelity = section.StartsWith("fidelity.");
        var corpus = Load(fidelity ? "value-fidelity-tests.json" : "key-order-tests.json");
        var kind = section[(section.IndexOf('.') + 1)..];
        var testCase = corpus[kind]!.AsArray()[index]!.AsObject();

        var hostValue = kind == "depth" && testCase["direction"]!.GetValue<string>() == "inbound"
            ? Nest(testCase["shape"]!.GetValue<string>(), testCase["depth"]!.GetValue<int>())
            : testCase["hostValue"] is { } hv ? Element(hv) : Element(null);
        JsonElement[] received = [];
        JsonElement[]? sunk = null;
        var bindings = new HostBindings();
        bindings.AddFunction("value", _ => hostValue);
        bindings.AddFunction("echo", args =>
        {
            received = args;
            return ArrayOf(args);
        });
        bindings.AddFunction("sink", args =>
        {
            sunk = args;
            return XriptValue.Undefined;
        });
        JsonElement? callbackReturned = null;
        bindings.AddFunction("call", args =>
        {
            var returned = XriptCallback.From(args[0])!.Invoke();
            callbackReturned = returned;
            return returned;
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
                    Assert.True(SameValue(expectedReceived, NodeOf(ArrayOf(received))),
                        $"{name}: host received {ArrayOf(received).GetRawText()}");
                break;
            }
            case "sink":
            {
                var value = rt.Execute(testCase["script"]!.GetValue<string>()).Value;
                Assert.True(testCase["expected"]!.GetValue<string>() == value.GetString(), $"{name}: got {value}");
                if (testCase["received"] is { } expectedSunk)
                    Assert.True(sunk is not null && SameValue(expectedSunk, NodeOf(ArrayOf(sunk))),
                        $"{name}: host received {(sunk is null ? "nothing" : ArrayOf(sunk).GetRawText())}");
                else
                    Assert.True(sunk is null, $"{name}: sink was called with {(sunk is null ? "" : ArrayOf(sunk).GetRawText())}");
                break;
            }
            case "depth":
            {
                var value = rt.Execute(testCase["script"]!.GetValue<string>()).Value.GetString()!;
                if (testCase["error"] is { } error)
                {
                    Assert.True(value.StartsWith(error.GetValue<string>(), StringComparison.Ordinal), $"{name}: got {value}");
                    break;
                }
                Assert.True(testCase["expected"]!.GetValue<string>() == value, $"{name}: got {value}");
                if (testCase["direction"]!.GetValue<string>() == "outbound")
                    Assert.Equal(testCase["depth"]!.GetValue<int>(), NestedLevels(testCase["shape"]!.GetValue<string>(), received[0]));
                break;
            }
            case "callbackResult" when testCase["error"] is { } error:
            {
                var caught = rt.Execute(
                    $"(function () {{ try {{ call(function () {{ return {testCase["returns"]!.GetValue<string>()}; }}); return 'crossed'; }} catch (e) {{ return e.name; }} }})()").Value;
                Assert.True(error.GetValue<string>() == caught.GetString(), $"{name}: got {caught}");
                break;
            }
            case "callbackResult":
            {
                rt.Execute($"call(function () {{ return {testCase["returns"]!.GetValue<string>()}; }}); undefined");
                Assert.True(callbackReturned is { } returned && SameValue(testCase["expected"], NodeOf(returned)),
                    $"{name}: host recorded {callbackReturned?.GetRawText() ?? "nothing"}");
                break;
            }
            case "prefix":
            {
                var value = rt.Execute(testCase["script"]!.GetValue<string>()).Value.GetString()!;
                var prefix = testCase["prefix"]!.GetValue<string>();
                Assert.True(value.StartsWith(prefix, StringComparison.Ordinal), $"{name}: got {value}");
                Assert.False(value.StartsWith(prefix + prefix, StringComparison.Ordinal), $"{name}: got {value}");
                break;
            }
            case "results" when testCase["fails"] is { } fails && fails.GetValue<bool>():
            {
                var script = testCase["script"]!.GetValue<string>();
                var failure = Record.Exception(() => rt.Execute(script));
                Assert.True(failure is not null, $"{name}: the call did not fail");
                break;
            }
            case "results":
            {
                var value = rt.Execute(testCase["script"]!.GetValue<string>()).Value;
                Assert.True(SameValue(testCase["expected"], NodeOf(value)),
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
                Assert.True(SameValue(testCase["expected"], NodeOf(results[0])),
                    $"{name}: got {results[0].GetRawText()}");
                break;
            }
        }
    }

    /// <summary>
    /// <c>spec/async-tests.json</c>, where C# has the surface. It has no <c>ExecuteAsync</c>, so
    /// <c>body</c>, <c>promise</c>, and <c>syncReach</c> do not apply. For <c>executeResult</c> the
    /// corpus has C# settle instead of refuse: Jint drains its job queue before <c>Execute</c>
    /// returns, so a settled promise crosses as its value and a pending one fails clearly.
    /// </summary>
    [Fact]
    public void Async_Corpus_Promise_Results_Settle()
    {
        var corpus = Load("async-tests.json");
        var bindings = new HostBindings();
        bindings.AddFunction("slow", args => args[1]);
        bindings.AddFunction("fail", args => throw new InvalidOperationException(args[0].GetString()));
        bindings.AddFunction("sync", _ => JsonSerializer.SerializeToElement("sync"));
        using var rt = XriptRuntime.Create(corpus["manifest"]!.ToJsonString(), new RuntimeOptions { HostBindings = bindings });
        foreach (var node in corpus["executeResult"]!.AsArray())
        {
            var script = node!["script"]!.GetValue<string>();
            if (script.Contains("new Promise(function () {})"))
            {
                var pending = Assert.Throws<InvalidOperationException>(() => rt.Execute(script));
                Assert.Contains("still pending", pending.Message);
            }
            else
            {
                Assert.Equal(1, rt.Execute(script).Value.GetInt32());
            }
        }
        Assert.Equal("v", rt.Execute("slow(1, 'v')").Value.GetString());
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

    /// <summary>A <c>depth</c> case's host value: <paramref name="levels"/> containers of <paramref name="shape"/> around <c>0</c>.</summary>
    private static JsonElement Nest(string shape, int levels)
    {
        var (open, close) = shape == "object" ? ("{\"d\":", "}") : ("[", "]");
        var text = new System.Text.StringBuilder(levels * (open.Length + close.Length) + 1);
        for (var i = 0; i < levels; i++) text.Append(open);
        text.Append('0');
        for (var i = 0; i < levels; i++) text.Append(close);
        return JsonDocument.Parse(text.ToString(), new JsonDocumentOptions { MaxDepth = levels + 1 }).RootElement.Clone();
    }

    private static int NestedLevels(string shape, JsonElement value)
    {
        var levels = 0;
        while (shape == "object" ? value.ValueKind == JsonValueKind.Object : value.ValueKind == JsonValueKind.Array)
        {
            value = shape == "object" ? value.GetProperty("d") : value[0];
            levels++;
        }
        return levels;
    }

    private static readonly JsonSerializerOptions DeepWrite = new() { MaxDepth = XriptValue.MaxDepth + 10 };

    private static JsonElement Element(JsonNode? node) =>
        JsonDocument.Parse(node?.ToJsonString(DeepWrite) ?? "null", Deep).RootElement.Clone();

    private static JsonObject Load(string file) =>
        JsonNode.Parse(File.ReadAllText(CorpusPath(file)), documentOptions: Deep)!.AsObject();

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
