using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared host events corpus: under <see cref="RuntimeOptions.HostEvents"/> a host-declared
/// top-level <c>events</c> binding is the <c>events</c> mods see, sealed like every other
/// binding, and the built-in bus's host API is refused; without it nothing changes.
/// </summary>
public class HostEventsCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "host-events-tests.json");
            return JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(path))).RootElement.Clone();
        }
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var testCase in Corpus.GetProperty("cases").EnumerateArray())
            data.Add(testCase.GetProperty("name").GetString()!);
        return data;
    }

    private static HostFunction Answer(string prefix) =>
        args => JsonSerializer.SerializeToElement(prefix + ":" + (args.Length > 0 ? args[0].GetString() : ""));

    private static HostBindings HostFor(JsonElement manifest)
    {
        var bindings = new HostBindings();
        if (!manifest.TryGetProperty("bindings", out var declared)) return bindings;
        foreach (var binding in declared.EnumerateObject())
        {
            if (binding.Value.TryGetProperty("members", out var members))
                bindings.AddNamespace(binding.Name, members.EnumerateObject().ToDictionary(m => m.Name, m => Answer(m.Name)));
            else
                bindings.AddFunction(binding.Name, Answer(binding.Name));
        }
        return bindings;
    }

    private static string Canonical(JsonElement value) => JsonNode.Parse(value.GetRawText())?.ToJsonString() ?? "null";

    private static JsonElement HostCall(XriptRuntime rt, string api, JsonElement[] args) => api switch
    {
        "emit" => JsonSerializer.SerializeToElement(rt.Emit(args[0].GetString()!)),
        "declareEvent" => rt.DeclareEvent(args[0]),
        "cancelOwned" => JsonSerializer.SerializeToElement(rt.CancelOwned(args[0].GetString())),
        _ => throw new InvalidOperationException($"unknown host API {api}"),
    };

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Host_Events_Mode_Holds(string name)
    {
        var corpus = Corpus;
        var testCase = corpus.GetProperty("cases").EnumerateArray().First(c => c.GetProperty("name").GetString() == name);
        var manifest = corpus.GetProperty("hosts").GetProperty(testCase.GetProperty("host").GetString()!);
        var codes = new List<string>();
        XriptRuntime Construct() => XriptRuntime.Create(manifest.GetRawText(), new RuntimeOptions
        {
            HostBindings = HostFor(manifest),
            HostEvents = testCase.GetProperty("hostEvents").GetBoolean(),
            OnDeprecation = notice => codes.Add(notice.Code),
        });

        if (testCase.TryGetProperty("error", out var error))
        {
            var thrown = Assert.Throws<HostEventsException>(() => Construct());
            Assert.Contains(error.GetString()!, thrown.Message);
            return;
        }

        using var rt = Construct();
        Assert.Equal(Canonical(testCase.GetProperty("deprecations")), JsonSerializer.Serialize(codes));

        if (testCase.TryGetProperty("tamper", out var tamper))
        {
            var mod = corpus.GetProperty("mod");
            try
            {
                rt.LoadMod(mod.GetRawText(), new Dictionary<string, string>
                {
                    [mod.GetProperty("entry").GetProperty("script").GetString()!] = tamper.GetString()!,
                });
            }
            catch (Exception)
            {
                // a tamper that throws while loading is still a tamper; the corpus ignores the failure
            }
        }

        foreach (var step in testCase.GetProperty("steps").EnumerateArray())
        {
            if (step.TryGetProperty("execute", out var source))
            {
                Assert.Equal(Canonical(step.GetProperty("expected")), Canonical(rt.Execute(source.GetString()!).Value));
            }
            else if (step.TryGetProperty("host", out var api))
            {
                var args = step.GetProperty("args").EnumerateArray().ToArray();
                if (step.TryGetProperty("throws", out var throws))
                {
                    var refused = Assert.Throws<HostEventsException>(() => HostCall(rt, api.GetString()!, args));
                    Assert.Contains(throws.GetString()!, refused.Message);
                }
                else
                {
                    Assert.Equal(Canonical(step.GetProperty("expected")), Canonical(HostCall(rt, api.GetString()!, args)));
                }
            }
            else
            {
                Assert.Fail($"unknown step {step.GetRawText()}");
            }
        }
    }
}
