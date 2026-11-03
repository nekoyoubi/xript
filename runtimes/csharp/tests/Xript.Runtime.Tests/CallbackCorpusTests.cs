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
        public readonly List<RetainedCallback> Kept = [];

        public int Keep(RetainedCallback handle)
        {
            var index = Kept.IndexOf(handle);
            if (index >= 0) return index;
            Kept.Add(handle);
            return Kept.Count - 1;
        }

        public JsonElement TryKeep(JsonElement? value)
        {
            try
            {
                var callback = value is { } v ? XriptCallback.From(v) : null;
                if (callback is null) return Json(new { kind = "missing" });
                return Json(Keep(callback.Retain()));
            }
            catch (RetainException e)
            {
                return Json(new { kind = e.Reason });
            }
            catch (CallbackException e)
            {
                return Json(new { kind = e.Reason });
            }
        }
    }

    private static JsonElement CatchInvoke(Func<JsonElement> call)
    {
        try
        {
            return Json(new { kind = "returned", value = call() });
        }
        catch (CallbackException e) when (e.Reason == "threw")
        {
            return Json(new { kind = "threw", message = e.Message });
        }
        catch (CallbackException e)
        {
            return Json(new { kind = e.Reason });
        }
    }

    private static RetainedCallback RetainAt(JsonElement value) =>
        (XriptCallback.From(value) ?? throw new InvalidOperationException("not a callback")).Retain();

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
                return CatchInvoke(() => callback.Invoke(callArgs));
            },
            ["keep"] = args => state.TryKeep(args[0]),
            ["retainField"] = args =>
                state.TryKeep(args[0].TryGetProperty(args[1].GetString()!, out var field) ? field : null),
            ["keepAll"] = args => Json(args[0].EnumerateArray()
                .Select(item => state.Keep(RetainAt(item.GetProperty("onDone")))).ToArray()),
            ["keepEach"] = args => Json(args.Select(arg => state.Keep(RetainAt(arg))).ToArray()),
            ["tryRetain"] = args => state.TryKeep(Resolve(args.Skip(1).ToArray(), args[0])),
            ["retainTreeAt"] = args => state.TryKeep(Resolve(
                [args[0]], JsonSerializer.SerializeToElement(new JsonArray([0, .. args[1].EnumerateArray().Select(step => JsonNode.Parse(step.GetRawText()))])))),
            ["node"] = args =>
            {
                var handle = RetainAt(args[0]);
                state.Keep(handle);
                return JsonSerializer.SerializeToElement(
                    new JsonObject { ["kind"] = "action", ["fn"] = JsonNode.Parse(handle.ToMarker().GetRawText()) });
            },
            ["runKept"] = args => state.Kept[args[0].GetInt32()].Invoke(args[1].EnumerateArray().ToArray()),
            ["catchKept"] = args =>
            {
                var handle = state.Kept[args[0].GetInt32()];
                return CatchInvoke(() => handle.Invoke(args[1].EnumerateArray().ToArray()));
            },
            ["release"] = args =>
            {
                state.Kept[args[0].GetInt32()].Release();
                return Json(null);
            },
            ["giveBack"] = args => state.Kept[args[0].GetInt32()].ToMarker(),
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
            ["typedOptionalFlag"] = args =>
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
        var limits = manifest["limits"] as JsonObject ?? new JsonObject();
        if (entry.TryGetProperty("limits", out var caseLimits))
        {
            foreach (var limit in caseLimits.EnumerateObject())
                limits[limit.Name] = JsonNode.Parse(limit.Value.GetRawText());
        }
        if (entry.TryGetProperty("timeoutMs", out var timeout))
            limits["timeout_ms"] = timeout.GetInt64();
        if (limits.Count > 0)
            manifest["limits"] = limits;
        return manifest.ToJsonString();
    }

    private static JsonElement WithKept(JsonElement value, ProbeState state)
    {
        var node = JsonNode.Parse(value.GetRawText());
        return JsonSerializer.SerializeToElement(Substitute(node, state));
    }

    private static JsonNode? Substitute(JsonNode? node, ProbeState state)
    {
        switch (node)
        {
            case JsonObject obj when obj.Count == 1 && obj.TryGetPropertyValue("$kept", out var index):
                return JsonNode.Parse(state.Kept[index!.GetValue<int>()].ToMarker().GetRawText());
            case JsonObject obj:
                foreach (var key in obj.Select(p => p.Key).ToList())
                {
                    var replaced = Substitute(obj[key], state);
                    obj[key] = null;
                    obj[key] = replaced;
                }
                return obj;
            case JsonArray array:
                for (var i = 0; i < array.Count; i++)
                {
                    var replaced = Substitute(array[i], state);
                    array[i] = null;
                    array[i] = replaced;
                }
                return array;
            default:
                return node;
        }
    }

    private static void ExpectCallbackFailure(Action call, JsonElement step)
    {
        var failure = Assert.Throws<CallbackException>(call);
        Assert.Equal(step.GetProperty("fails").GetString(), failure.Reason);
        if (step.TryGetProperty("message", out var message))
            Assert.Equal(message.GetString(), failure.Message);
    }

    private static void ExpectOutcome(Func<JsonElement> run, JsonElement step)
    {
        if (step.TryGetProperty("error", out var parts))
        {
            var error = Assert.ThrowsAny<Exception>(() => run());
            foreach (var part in parts.EnumerateArray())
                Assert.Contains(part.GetString()!, error.Message);
            return;
        }
        var value = run();
        if (step.TryGetProperty("result", out var expected))
            Assert.True(JsonEquals(value, expected), $"expected {expected.GetRawText()}, got {value.GetRawText()}");
    }

    private static JsonElement[] ArgsOf(JsonElement step, ProbeState state) =>
        step.TryGetProperty("args", out var args)
            ? [.. WithKept(args, state).EnumerateArray()]
            : [];

    private static void RunAfterStep(JsonElement step, ref XriptRuntime? rt, ProbeState state)
    {
        var runtime = rt;
        if (step.TryGetProperty("call", out var call))
        {
            var handle = state.Kept[call.GetInt32()];
            var args = ArgsOf(step, state);
            if (step.TryGetProperty("fails", out _))
                ExpectCallbackFailure(() => handle.Invoke(args), step);
            else
                ExpectOutcome(() => handle.Invoke(args), step);
        }
        else if (step.TryGetProperty("callOffThread", out var offThread))
        {
            var handle = state.Kept[offThread.GetInt32()];
            var args = ArgsOf(step, state);
            Exception? caught = null;
            var thread = new Thread(() =>
            {
                try
                {
                    handle.Invoke(args);
                }
                catch (Exception e)
                {
                    caught = e;
                }
            });
            thread.Start();
            thread.Join();
            var failure = Assert.IsType<CallbackException>(caught);
            Assert.Equal(step.GetProperty("fails").GetString(), failure.Reason);
        }
        else if (step.TryGetProperty("release", out var release))
        {
            state.Kept[release.GetInt32()].Release();
        }
        else if (step.TryGetProperty("releaseMod", out var mod))
        {
            Assert.Equal(step.GetProperty("released").GetInt32(), runtime!.ReleaseRetained(mod.GetString()!));
        }
        else if (step.TryGetProperty("dispose", out _))
        {
            runtime!.Dispose();
            rt = null;
        }
        else if (step.TryGetProperty("execute", out var code))
        {
            ExpectOutcome(() => runtime!.Execute(code.GetString()!).Value, step);
        }
        else if (step.TryGetProperty("fireHook", out var hook))
        {
            var data = step.TryGetProperty("data", out var d) ? WithKept(d, state) : (JsonElement?)null;
            Action fire = () => runtime!.FireHook(hook.GetString()!, new FireHookOptions { Data = data });
            if (step.TryGetProperty("fails", out _)) ExpectCallbackFailure(fire, step);
            else fire();
        }
        else if (step.TryGetProperty("emit", out var ev))
        {
            var payload = step.TryGetProperty("payload", out var p) ? WithKept(p, state) : (JsonElement?)null;
            Action fire = () => runtime!.Emit(ev.GetString()!, new FireHookOptions { Data = payload });
            if (step.TryGetProperty("fails", out _)) ExpectCallbackFailure(fire, step);
            else fire();
        }
        else if (step.TryGetProperty("invoke", out var export))
        {
            var args = ArgsOf(step, state);
            var name = export.GetString()!;
            if (step.TryGetProperty("owner", out var owner))
                ExpectOutcome(() => runtime!.InvokeModExport(owner.GetString()!, name, args), step);
            else
                ExpectOutcome(() => runtime!.InvokeExport(name, args), step);
        }
        else if (step.TryGetProperty("retainStashed", out _))
        {
            Assert.NotNull(state.Stashed);
            ExpectCallbackFailure(() => state.Stashed!.Retain(), step);
        }
        else
        {
            throw new InvalidOperationException($"unknown after step {step.GetRawText()}");
        }
    }

    private static string ModManifest(string name) =>
        new JsonObject { ["xript"] = "0.9", ["name"] = name, ["version"] = "1.0.0", ["entry"] = "main.js" }.ToJsonString();

    private static bool JsonEquals(JsonElement a, JsonElement b) =>
        JsonNode.DeepEquals(JsonNode.Parse(a.GetRawText()), JsonNode.Parse(b.GetRawText()));

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Holds_The_Corpus_Case(string name)
    {
        var entry = Corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);
        var script = entry.TryGetProperty("script", out var s) ? s.GetString() : null;
        var state = new ProbeState();

        XriptRuntime? rt = XriptRuntime.Create(ManifestFor(entry), new RuntimeOptions { HostBindings = Probe(state) });
        try
        {
            if (entry.TryGetProperty("mods", out var mods))
            {
                foreach (var mod in mods.EnumerateArray())
                {
                    rt.LoadMod(
                        ModManifest(mod.GetProperty("name").GetString()!),
                        new Dictionary<string, string> { ["main.js"] = mod.GetProperty("script").GetString()! });
                }
            }

            if (entry.TryGetProperty("expect", out var expect))
            {
                if (expect.TryGetProperty("limit", out _))
                {
                    Assert.Throws<ExecutionLimitException>(() => rt.Execute(script!));
                    return;
                }

                if (expect.TryGetProperty("error", out var parts))
                {
                    var error = Assert.ThrowsAny<Exception>(() => rt.Execute(script!));
                    foreach (var part in parts.EnumerateArray())
                        Assert.Contains(part.GetString()!, error.Message);
                }
                else
                {
                    var value = rt.Execute(script!).Value;
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
            else if (script is not null)
            {
                rt.Execute(script);
            }

            if (entry.TryGetProperty("after", out var after))
            {
                foreach (var step in after.EnumerateArray())
                    RunAfterStep(step, ref rt, state);
            }
        }
        finally
        {
            rt?.Dispose();
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

    private const string RetainManifest = """
        { "xript": "0.8", "name": "t", "bindings": {
            "keep": { "description": "d", "params": [{ "name": "fn", "type": "function", "retain": true }] },
            "give": { "description": "d" } } }
        """;

    [Fact]
    public void A_Marker_Naming_No_Retained_Callback_Of_This_Runtime_Stays_Plain_Data()
    {
        RetainedCallback? foreign = null;
        var otherBindings = new HostBindings();
        otherBindings.AddFunction("keep", args => { foreign = XriptCallback.From(args[0])!.Retain(); return Json(null); });
        otherBindings.AddFunction("give", _ => Json(null));
        using var other = XriptRuntime.Create(RetainManifest, new RuntimeOptions { HostBindings = otherBindings });
        other.Execute("keep(function () {})");

        var handed = new Queue<JsonElement>([
            foreign!.ToMarker(),
            Json(new Dictionary<string, string> { ["$xriptCallback"] = "r:1:2:keep" }),
            Json(new Dictionary<string, string> { ["$xriptCallback"] = "1:0:3:keep" }),
        ]);
        var bindings = new HostBindings();
        bindings.AddFunction("keep", _ => Json(null));
        bindings.AddFunction("give", _ => handed.Dequeue());
        using var rt = XriptRuntime.Create(RetainManifest, new RuntimeOptions { HostBindings = bindings });

        for (var i = 0; i < 3; i++)
            Assert.Equal("object", rt.Execute("var v = give(); typeof v === 'object' && typeof v['$xriptCallback'] === 'string' ? 'object' : typeof v").Value.GetString());
    }

    [Fact]
    public void Retaining_The_Same_Function_Again_Yields_An_Equal_Handle()
    {
        var kept = new List<RetainedCallback>();
        var bindings = new HostBindings();
        bindings.AddFunction("keep", args => { kept.Add(XriptCallback.From(args[0])!.Retain()); return Json(null); });
        bindings.AddFunction("give", _ => Json(null));
        using var rt = XriptRuntime.Create(RetainManifest, new RuntimeOptions { HostBindings = bindings });

        rt.Execute("var f = function () { return 7; }; keep(f); keep(f); keep(function () {});");

        Assert.Equal(kept[0], kept[1]);
        Assert.Same(kept[0], kept[1]);
        Assert.NotEqual(kept[0], kept[2]);
        Assert.Equal(7, kept[1].Invoke().GetInt32());
    }

    [Fact]
    public void Hook_And_Event_Handlers_Run_As_The_Mod_That_Registered_Them()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("keep", args => { XriptCallback.From(args[0])!.Retain(); return Json(null); });
        bindings.AddFunction("give", _ => Json(null));
        using var rt = XriptRuntime.Create(
            """
            { "xript": "0.8", "name": "t",
              "bindings": { "keep": { "description": "d", "params": [{ "name": "fn", "type": "function", "retain": true }] } },
              "hooks": { "tick": { "description": "d" } },
              "events": [{ "id": "ping", "description": "d" }] }
            """,
            new RuntimeOptions { HostBindings = bindings });
        rt.LoadMod(
            ModManifest("alpha"),
            new Dictionary<string, string>
            {
                ["main.js"] = "hooks.tick(function () { keep(function () {}); }); events.on('ping', function () { keep(function () {}); });",
            });

        rt.FireHook("tick");
        rt.Emit("ping");

        Assert.Equal(2, rt.ReleaseRetained("alpha"));
    }
}
