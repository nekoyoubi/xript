using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared isolation corpus: a second mod's tampering leaves the first mod's handlers,
/// exports, bindings and console exactly as they were.
/// </summary>
public class IsolationCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "isolation-tests.json");
            return JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(path))).RootElement.Clone();
        }
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var testCase in Corpus.GetProperty("cases").EnumerateArray())
            data.Add(testCase.GetProperty("name").GetString()!);
        data.Add(Corpus.GetProperty("debugCase").GetProperty("name").GetString()!);
        return data;
    }

    private static HostBindings Host()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("log", args => JsonSerializer.SerializeToElement("log:" + args[0].GetString()));
        bindings.AddNamespace("ns", new Dictionary<string, HostFunction>
        {
            ["get"] = args => JsonSerializer.SerializeToElement("get:" + args[0].GetString()),
        });
        return bindings;
    }

    private static string Canonical(JsonElement value) => JsonNode.Parse(value.GetRawText())?.ToJsonString() ?? "null";

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void A_Second_Mod_Cannot_Tamper_With_The_First(string name)
    {
        var corpus = Corpus;
        var debugCase = corpus.GetProperty("debugCase");
        var debug = debugCase.GetProperty("name").GetString() == name;
        var testCase = debug
            ? debugCase
            : corpus.GetProperty("cases").EnumerateArray().First(c => c.GetProperty("name").GetString() == name);
        var logs = new List<string>();
        using var rt = XriptRuntime.Create(corpus.GetProperty("host").GetRawText(), new RuntimeOptions
        {
            HostBindings = Host(),
            Console = new ConsoleHandler { OnLog = (_, message) => logs.Add(message) },
            Debug = debug ? new DebugOptions() : null,
        });

        var a = corpus.GetProperty("a");
        rt.LoadMod(a.GetProperty("manifest").GetRawText(), new Dictionary<string, string>
        {
            [a.GetProperty("manifest").GetProperty("entry").GetProperty("script").GetString()!] = a.GetProperty("source").GetString()!,
        });
        var probes = debug ? Canonical(rt.Execute(debugCase.GetProperty("probes").GetString()!).Value) : null;
        if (!debug)
            Assert.Equal("[]", Canonical(rt.Execute(corpus.GetProperty("internals").GetString()!).Value));

        var b = corpus.GetProperty("b");
        try
        {
            rt.LoadMod(b.GetRawText(), new Dictionary<string, string>
            {
                [b.GetProperty("entry").GetProperty("script").GetString()!] = testCase.GetProperty("tamper").GetString()!,
            });
        }
        catch (Exception)
        {
        }

        rt.InvokeModExport("a", "setup", []);
        logs.Clear();

        foreach (var step in corpus.GetProperty("steps").EnumerateArray())
        {
            var label = step.GetRawText();
            if (step.TryGetProperty("fire", out var hook))
            {
                var results = rt.FireHook(hook.GetString()!, new FireHookOptions
                {
                    Phase = step.TryGetProperty("phase", out var phase) ? phase.GetString() : null,
                    Data = step.GetProperty("data"),
                });
                Assert.True(Canonical(step.GetProperty("expected")) == JsonSerializer.Serialize(results), $"{label}: {JsonSerializer.Serialize(results)}");
            }
            else if (step.TryGetProperty("fragment", out var fragment))
            {
                var ops = rt.FireFragmentHook(fragment.GetString()!, step.GetProperty("lifecycle").GetString()!);
                Assert.True(step.GetProperty("ops").GetInt32() == ops.Length, $"{label}: {ops.Length} ops");
            }
            else if (step.TryGetProperty("invoke", out var export))
            {
                var value = rt.InvokeModExport(step.GetProperty("mod").GetString()!, export.GetString()!, []);
                if (step.TryGetProperty("logs", out var expectedLogs))
                    Assert.True(Canonical(expectedLogs) == JsonSerializer.Serialize(logs), $"{label}: {JsonSerializer.Serialize(logs)}");
                else
                    Assert.True(Canonical(step.GetProperty("expected")) == Canonical(value), $"{label}: {Canonical(value)}");
            }
            else if (step.TryGetProperty("emit", out var eventId))
            {
                var results = rt.Emit(eventId.GetString()!, new FireHookOptions { Data = step.GetProperty("payload") });
                Assert.True(Canonical(step.GetProperty("expected")) == JsonSerializer.Serialize(results), $"{label}: {JsonSerializer.Serialize(results)}");
            }
            else if (step.TryGetProperty("execute", out var source))
            {
                var value = rt.Execute(source.GetString()!).Value;
                Assert.True(Canonical(step.GetProperty("expected")) == Canonical(value), $"{label}: {Canonical(value)}");
            }
            else
                throw new InvalidOperationException($"unknown step {label}");
        }

        if (debug)
        {
            Assert.Equal(probes, Canonical(rt.Execute(debugCase.GetProperty("probes").GetString()!).Value));
            Assert.Equal("[]", Canonical(rt.Execute(debugCase.GetProperty("locked").GetString()!).Value));
        }
    }
}
