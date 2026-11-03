using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared accessor corpus: accessor members read and write live the same here as in the
/// other three runtimes.
/// </summary>
public class AccessorCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "accessor-tests.json");
            return JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(path))).RootElement.Clone();
        }
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var entry in Corpus.GetProperty("cases").EnumerateArray())
            data.Add(entry.GetProperty("name").GetString()!);
        return data;
    }

    private sealed class ProbeState
    {
        public int Reads;
        public readonly List<JsonElement> Writes = [];
        public JsonElement Speed = JsonSerializer.SerializeToElement(1);
    }

    private static JsonElement Json(object? value) => JsonSerializer.SerializeToElement(value);

    private static HostBindings Probe(ProbeState state)
    {
        var bindings = new HostBindings();
        bindings.AddNestedNamespace("clock", new Dictionary<string, HostNamespaceMember>
        {
            ["now"] = HostNamespaceMember.Live(new HostAccessor(() => Json(++state.Reads))),
            ["speed"] = HostNamespaceMember.Live(new HostAccessor(
                () => state.Speed,
                value =>
                {
                    state.Writes.Add(value.Clone());
                    state.Speed = value.Clone();
                })),
            ["broken"] = HostNamespaceMember.Live(new HostAccessor(() => throw new InvalidOperationException("clock offline"))),
            ["jammed"] = HostNamespaceMember.Live(new HostAccessor(
                () => Json(0),
                _ => throw new InvalidOperationException("rejected value"))),
            ["locked"] = HostNamespaceMember.Live(new HostAccessor(() => Json("secret"))),
        });
        bindings.AddAccessor("phase", new HostAccessor(() => Json("day")));
        return bindings;
    }

    private static bool JsonEquals(JsonElement a, JsonElement b) =>
        JsonNode.DeepEquals(JsonNode.Parse(a.GetRawText()), JsonNode.Parse(b.GetRawText()));

    [Fact]
    public void Carries_Cases()
    {
        Assert.NotEmpty(Corpus.GetProperty("cases").EnumerateArray());
    }

    [Fact]
    public void Reports_The_Omitted_Non_Optional_Accessor_As_Missing()
    {
        var corpus = Corpus;
        using var rt = XriptRuntime.Create(
            corpus.GetProperty("manifest").GetRawText(), new RuntimeOptions { HostBindings = Probe(new ProbeState()) });
        Assert.Equal(
            corpus.GetProperty("missingBindings").EnumerateArray().Select(c => c.GetString()!).ToArray(),
            rt.MissingBindings);
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Case_Holds(string name)
    {
        var corpus = Corpus;
        var entry = corpus.GetProperty("cases").EnumerateArray().First(c => c.GetProperty("name").GetString() == name);
        var script = entry.GetProperty("script").GetString()!;
        var expect = entry.GetProperty("expect");
        var state = new ProbeState();

        using var rt = XriptRuntime.Create(
            corpus.GetProperty("manifest").GetRawText(), new RuntimeOptions { HostBindings = Probe(state) });

        if (expect.TryGetProperty("limit", out _))
        {
            Assert.Throws<ExecutionLimitException>(() => rt.Execute(script));
            return;
        }

        if (expect.TryGetProperty("error", out var parts))
        {
            var error = Assert.ThrowsAny<Exception>(() => rt.Execute(script));
            foreach (var part in parts.EnumerateArray())
                Assert.Contains(part.GetString()!, error.Message);
        }
        else
        {
            var value = rt.Execute(script).Value;
            Assert.True(
                JsonEquals(value, expect.GetProperty("result")),
                $"expected {expect.GetProperty("result").GetRawText()}, got {value.GetRawText()}");
        }

        if (expect.TryGetProperty("reads", out var reads))
            Assert.Equal(reads.GetInt32(), state.Reads);
        if (expect.TryGetProperty("writes", out var writes))
            Assert.True(
                JsonEquals(Json(state.Writes), writes),
                $"expected writes {writes.GetRawText()}, got {Json(state.Writes).GetRawText()}");
    }

    private const string Shapes = """
        {
            "xript": "0.10",
            "name": "accessor-shapes",
            "bindings": {
                "ns": {
                    "description": "Accessors.",
                    "members": {
                        "value": { "description": "Read and written live.", "accessor": "get-set" }
                    }
                }
            }
        }
        """;

    [Fact]
    public void Each_Access_Is_Audited_As_A_Binding_Call()
    {
        var events = new List<string>();
        var bindings = new HostBindings();
        bindings.AddNestedNamespace("ns", new Dictionary<string, HostNamespaceMember>
        {
            ["value"] = HostNamespaceMember.Live(new HostAccessor(() => Json(1), _ => { })),
        });
        using var rt = XriptRuntime.Create(Shapes, new RuntimeOptions
        {
            HostBindings = bindings,
            Audit = e => events.Add(e.Binding),
        });
        rt.Execute("ns.value; ns.value = 2;");
        Assert.Equal(new[] { "ns.value", "ns.value" }, events);
    }

    [Fact]
    public void A_Get_Set_Declaration_With_No_Host_Setter_Is_Missing()
    {
        var bindings = new HostBindings();
        bindings.AddNestedNamespace("ns", new Dictionary<string, HostNamespaceMember>
        {
            ["value"] = HostNamespaceMember.Live(new HostAccessor(() => Json(1))),
        });
        using var rt = XriptRuntime.Create(Shapes, new RuntimeOptions { HostBindings = bindings });
        Assert.Equal(new[] { "ns.value" }, rt.MissingBindings);
        var error = Assert.ThrowsAny<Exception>(() => rt.Execute("ns.value"));
        Assert.Contains("ns.value", error.Message);
    }
}
