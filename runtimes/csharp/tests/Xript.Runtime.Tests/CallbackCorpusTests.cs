using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared callback corpus: script functions crossing into host bindings behave the same
/// here as in the other three runtimes.
/// </summary>
public class CallbackCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "callback-tests.json");
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
        public int TypedCalls;
        public XriptCallback? Stashed;
    }

    private static JsonElement Json(object? value) => JsonSerializer.SerializeToElement(value);

    private static JsonElement? Resolve(JsonElement[] payload, JsonElement path)
    {
        var steps = path.EnumerateArray().ToList();
        if (steps.Count == 0) return null;
        var first = steps[0].GetInt32();
        if (first >= payload.Length) return null;
        var current = payload[first];
        foreach (var step in steps.Skip(1))
        {
            if (step.ValueKind == JsonValueKind.String)
            {
                if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(step.GetString()!, out var next))
                    return null;
                current = next;
            }
            else
            {
                var i = step.GetInt32();
                if (current.ValueKind != JsonValueKind.Array || i >= current.GetArrayLength()) return null;
                current = current[i];
            }
        }
        return current;
    }

    private static (XriptCallback Callback, JsonElement[] CallArgs) CallbackAt(JsonElement[] args)
    {
        var target = Resolve(args.Skip(2).ToArray(), args[0]) ?? throw new InvalidOperationException("nothing at path");
        var callback = XriptCallback.From(target) ?? throw new InvalidOperationException("not a callback");
        return (callback, args[1].EnumerateArray().ToArray());
    }

    private static string JsonKind(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => "null",
        JsonValueKind.True or JsonValueKind.False => "boolean",
        JsonValueKind.Number => "number",
        JsonValueKind.String => "string",
        JsonValueKind.Array => "array",
        _ => "object",
    };

    private static HostBindings Probe(ProbeState state)
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("probe", new Dictionary<string, HostFunction>
        {
            ["call"] = args =>
            {
                var (callback, callArgs) = CallbackAt(args);
                return callback.Invoke(callArgs);
            },
            ["catchCall"] = args =>
            {
                var (callback, callArgs) = CallbackAt(args);
                try
                {
                    return Json(new { kind = "returned", value = callback.Invoke(callArgs) });
                }
                catch (CallbackException e) when (e.Reason == "threw")
                {
                    return Json(new { kind = "threw", message = e.Message });
                }
                catch (CallbackException e)
                {
                    return Json(new { kind = e.Reason });
                }
            },
            ["kind"] = args =>
            {
                var at = Resolve(args.Skip(1).ToArray(), args[0]);
                if (at is not { } value) return Json("missing");
                return Json(XriptCallback.From(value) is not null ? "callback" : JsonKind(value));
            },
            ["stash"] = args =>
            {
                var at = Resolve(args.Skip(1).ToArray(), args[0]);
                state.Stashed = at is { } value ? XriptCallback.From(value) : null;
                return Json(null);
            },
            ["typed"] = _ =>
            {
                state.TypedCalls++;
                return Json("called");
            },
            ["typedSignature"] = _ =>
            {
                state.TypedCalls++;
                return Json("called");
            },
            ["typedOptional"] = args =>
            {
                state.TypedCalls++;
                return Json(args.Length > 0 && XriptCallback.From(args[0]) is not null ? "called" : "absent");
            },
        });
        return bindings;
    }

    private static string ManifestFor(JsonElement entry)
    {
        var manifest = JsonNode.Parse(Corpus.GetProperty("manifest").GetRawText())!.AsObject();
        if (entry.TryGetProperty("timeoutMs", out var timeout))
            manifest["limits"] = new JsonObject { ["timeout_ms"] = timeout.GetInt64() };
        return manifest.ToJsonString();
    }

    private static bool JsonEquals(JsonElement a, JsonElement b) =>
        JsonNode.DeepEquals(JsonNode.Parse(a.GetRawText()), JsonNode.Parse(b.GetRawText()));

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Holds_The_Corpus_Case(string name)
    {
        var entry = Corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);
        var expect = entry.GetProperty("expect");
        var script = entry.GetProperty("script").GetString()!;
        var state = new ProbeState();

        using var rt = XriptRuntime.Create(ManifestFor(entry), new RuntimeOptions { HostBindings = Probe(state) });

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

        if (expect.TryGetProperty("typedCalls", out var calls))
            Assert.Equal(calls.GetInt32(), state.TypedCalls);

        if (expect.TryGetProperty("expiredAfter", out _))
        {
            Assert.NotNull(state.Stashed);
            var expired = Assert.Throws<CallbackException>(() => state.Stashed!.Invoke());
            Assert.Equal("expired", expired.Reason);
            Assert.Contains("probe.stash", expired.Message);
        }
    }

    [Fact]
    public void The_Corpus_Carries_Cases()
    {
        Assert.NotEmpty(Corpus.GetProperty("cases").EnumerateArray());
    }

    [Fact]
    public void A_Callback_Is_Unusable_From_Another_Thread()
    {
        string? elsewhere = null;
        var bindings = new HostBindings();
        bindings.AddFunction("take", args =>
        {
            var callback = XriptCallback.From(args[0])!;
            var thread = new Thread(() =>
            {
                try
                {
                    callback.Invoke();
                }
                catch (CallbackException e)
                {
                    elsewhere = e.Reason;
                }
            });
            thread.Start();
            thread.Join();
            return Json(elsewhere);
        });
        using var rt = XriptRuntime.Create(
            """{ "xript": "0.8", "name": "t", "bindings": { "take": { "description": "d" } } }""",
            new RuntimeOptions { HostBindings = bindings });

        Assert.Equal("expired", rt.Execute("take(() => 1)").Value.GetString());
    }

    [Fact]
    public void A_Marker_The_Script_Forges_Without_A_Function_Is_Plain_Data()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("kind", args => Json(XriptCallback.From(args[0]) is not null));
        using var rt = XriptRuntime.Create(
            """{ "xript": "0.8", "name": "t", "bindings": { "kind": { "description": "d" } } }""",
            new RuntimeOptions { HostBindings = bindings });

        Assert.False(rt.Execute("kind({ '$xriptCallback': 0 })").Value.GetBoolean());
    }
}
