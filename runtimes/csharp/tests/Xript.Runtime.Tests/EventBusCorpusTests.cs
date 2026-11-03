using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared events bus corpus: every verb, ownership rule, and caller-aware binding behaves
/// here exactly as in the other three runtimes.
/// </summary>
public class EventBusCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "event-bus-tests.json");
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

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Applies_The_Corpus_Case(string name)
    {
        var corpus = Corpus;
        var testCase = corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);

        var manifest = JsonNode.Parse(corpus.GetProperty("base").GetRawText())!.AsObject();
        foreach (var property in testCase.GetProperty("host").EnumerateObject())
            manifest[property.Name] = JsonNode.Parse(property.Value.GetRawText());

        var options = new RuntimeOptions { HostBindings = CallerBindings(testCase) };
        if (testCase.TryGetProperty("grants", out var grants))
            options.Capabilities = [.. grants.EnumerateArray().Select(g => g.GetString()!)];

        using var runtime = XriptRuntime.Create(manifest.ToJsonString(), options);
        runtime.Execute(corpus.GetProperty("prelude").GetString()!);
        runtime.Execute(testCase.GetProperty("script").GetString()!);

        var trampoline = corpus.GetProperty("trampoline").GetString()!;
        if (testCase.TryGetProperty("mods", out var mods))
        {
            foreach (var mod in mods.EnumerateArray())
            {
                var modName = mod.GetProperty("name").GetString()!;
                var source = mod.TryGetProperty("source", out var extra) ? extra.GetString() : "";
                var modManifest = JsonSerializer.Serialize(new { xript = "0.10", name = modName, version = "1.0.0", entry = "main.js" });
                runtime.LoadMod(modManifest, new Dictionary<string, string> { ["main.js"] = trampoline + source });
            }
        }

        var index = 0;
        foreach (var step in testCase.GetProperty("steps").EnumerateArray())
        {
            var label = $"step {index++}: {step.GetRawText()}";
            if (step.TryGetProperty("call", out var call))
            {
                var args = step.TryGetProperty("args", out var given) ? given : JsonDocument.Parse("[]").RootElement;
                var caller = step.GetProperty("as");
                var actual = caller.ValueKind == JsonValueKind.Null
                    ? runtime.Execute($"{call.GetString()}.apply(null, {args.GetRawText()})").Value
                    : runtime.InvokeModExport(caller.GetString()!, "call", [call, args]);
                AssertJson(step.GetProperty("expect"), actual, label);
            }
            else if (step.TryGetProperty("emit", out var emit))
            {
                var emitOptions = step.TryGetProperty("payload", out var payload)
                    ? new FireHookOptions { Data = payload }
                    : null;
                var actual = runtime.Emit(emit.GetString()!, emitOptions);
                AssertJson(step.GetProperty("expect"), JsonSerializer.SerializeToElement(actual), label);
            }
            else if (step.TryGetProperty("cancelOwned", out var owner))
            {
                var count = runtime.CancelOwned(owner.ValueKind == JsonValueKind.Null ? null : owner.GetString());
                Assert.True(step.GetProperty("expect").GetInt32() == count, $"{label}: got {count}");
            }
            else if (step.TryGetProperty("declare", out var entry))
            {
                if (step.TryGetProperty("throws", out var throws) && throws.GetBoolean())
                    Assert.Throws<BindingException>(() => runtime.DeclareEvent(entry));
                else
                    AssertJson(step.GetProperty("expect"), runtime.DeclareEvent(entry), label);
            }
            else
            {
                Assert.Fail($"unknown step kind: {label}");
            }
        }
    }

    private static HostBindings CallerBindings(JsonElement testCase)
    {
        var bindings = new HostBindings();
        if (!testCase.TryGetProperty("callerBindings", out var names))
            return bindings;

        var nested = new Dictionary<string, Dictionary<string, HostNamespaceMember>>();
        foreach (var qualified in names.EnumerateArray().Select(n => n.GetString()!))
        {
            var parts = qualified.Split('.');
            if (parts.Length == 1)
            {
                bindings.AddFunction(parts[0], (CallerHostFunction)Report);
                continue;
            }
            if (!nested.TryGetValue(parts[0], out var members))
                nested[parts[0]] = members = new Dictionary<string, HostNamespaceMember>();
            members[parts[1]] = HostNamespaceMember.Fn((CallerHostFunction)Report);
        }
        foreach (var (ns, members) in nested)
            bindings.AddNestedNamespace(ns, members);
        return bindings;
    }

    private static JsonElement Report(HostCallInfo info, JsonElement[] args) =>
        JsonSerializer.SerializeToElement(new { modId = info.ModId, binding = info.Binding, args });

    private static void AssertJson(JsonElement expected, JsonElement actual, string label)
    {
        var want = Canon(expected);
        var got = Canon(actual);
        Assert.True(want == got, $"{label}\n expected: {want}\n   actual: {got}");
    }

    /// <summary>A key-sorted rendering with numbers as doubles, so equal JSON compares equal.</summary>
    private static string Canon(JsonElement element)
    {
        var builder = new StringBuilder();
        Write(element, builder);
        return builder.ToString();
    }

    private static void Write(JsonElement element, StringBuilder builder)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                builder.Append('{');
                var first = true;
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    if (!first) builder.Append(',');
                    first = false;
                    builder.Append(JsonSerializer.Serialize(property.Name)).Append(':');
                    Write(property.Value, builder);
                }
                builder.Append('}');
                break;
            case JsonValueKind.Array:
                builder.Append('[');
                var firstItem = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!firstItem) builder.Append(',');
                    firstItem = false;
                    Write(item, builder);
                }
                builder.Append(']');
                break;
            case JsonValueKind.Number:
                builder.Append(element.GetDouble().ToString("R", CultureInfo.InvariantCulture));
                break;
            case JsonValueKind.String:
                builder.Append(JsonSerializer.Serialize(element.GetString()));
                break;
            case JsonValueKind.Undefined:
                builder.Append("null");
                break;
            default:
                builder.Append(element.GetRawText());
                break;
        }
    }
}
