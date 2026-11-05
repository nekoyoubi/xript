using System.Globalization;
using System.Text;
using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared re-entrancy corpus: a host binding calling back into the runtime that is running
/// it, through every host entry point, behaves here exactly as in the other three runtimes.
/// </summary>
public class ReentrancyCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "reentrancy-tests.json");
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

    private sealed class Host
    {
        public XriptRuntime? Runtime;
        public readonly List<RetainedCallback> Kept = [];
        public readonly List<JsonElement> Settled = [];
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Applies_The_Corpus_Case(string name)
    {
        var corpus = Corpus;
        var testCase = corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);
        var mod = corpus.GetProperty("mod");
        var modName = mod.GetProperty("manifest").GetProperty("name").GetString()!;

        var host = new Host();
        var options = new RuntimeOptions { HostBindings = Bindings(host, modName) };
        using var runtime = XriptRuntime.Create(corpus.GetProperty("manifest").GetRawText(), options);
        host.Runtime = runtime;

        var entry = mod.GetProperty("manifest").GetProperty("entry").GetProperty("script").GetString()!;
        runtime.LoadMod(
            mod.GetProperty("manifest").GetRawText(),
            new Dictionary<string, string> { [entry] = mod.GetProperty("source").GetString()! });
        runtime.Execute(corpus.GetProperty("setup").GetString()!);

        var scriptValue = runtime.Execute(testCase.GetProperty("script").GetString()!).Value;
        var actual = testCase.TryGetProperty("kept", out var kept)
            ? host.Kept[kept.GetProperty("index").GetInt32()].Invoke(kept.GetProperty("args").EnumerateArray().ToArray())
            : scriptValue;
        AssertJson(testCase.GetProperty("expected"), actual, name);

        var expectedSettled = testCase.TryGetProperty("settled", out var settled)
            ? settled
            : JsonDocument.Parse("[]").RootElement;
        AssertJson(expectedSettled, JsonSerializer.SerializeToElement(host.Settled), $"{name} (settled)");

        AssertJson(JsonSerializer.SerializeToElement("usable"), runtime.Execute("'usable'").Value, $"{name} (afterwards)");
    }

    private static HostBindings Bindings(Host host, string modName)
    {
        var bindings = new HostBindings();
        bindings.AddFunction("enter", (HostFunction)(args => Enter(host, modName, args)));
        bindings.AddFunction("keep", (HostFunction)(args =>
        {
            var callback = XriptCallback.From(args[0]) ?? throw new InvalidOperationException("not a callback");
            host.Kept.Add(callback.Retain());
            return JsonSerializer.SerializeToElement(host.Kept.Count - 1);
        }));
        bindings.AddFunction("callKept", (HostFunction)(args =>
            host.Kept[args[0].GetInt32()].Invoke(args.Length > 1 ? args[1] : JsonSerializer.SerializeToElement<object?>(null))));
        bindings.AddFunction("who", (CallerHostFunction)((info, _) =>
            JsonSerializer.SerializeToElement(new { modId = info.ModId, binding = info.Binding })));
        return bindings;
    }

    /// <summary>
    /// The runtime has no asynchronous entry point; <c>Execute</c> drains the job queue before it
    /// returns, so an async body run as an async function settles in place.
    /// </summary>
    private static JsonElement Enter(Host host, string modName, JsonElement[] args)
    {
        var runtime = host.Runtime!;
        var arg = args.Length > 1 ? args[1] : default;
        switch (args[0].GetString())
        {
            case "execute":
                return runtime.Execute(arg.GetString()!).Value;
            case "executeAsync":
                host.Settled.Add(runtime.Execute($"(async () => {{\n{arg.GetString()}\n}})()").Value);
                return JsonSerializer.SerializeToElement<object?>(null);
            case "invokeExport":
                return runtime.InvokeExport(arg[0].GetString()!, arg[1].EnumerateArray().ToArray());
            case "invokeModExport":
                return runtime.InvokeModExport(modName, arg[0].GetString()!, arg[1].EnumerateArray().ToArray());
            case "fireHook":
                return JsonSerializer.SerializeToElement(
                    runtime.FireHook(arg[0].GetString()!, new FireHookOptions { Data = arg[1] }));
            case "emit":
                return JsonSerializer.SerializeToElement(
                    runtime.Emit(arg[0].GetString()!, new FireHookOptions { Data = arg[1] }));
            default:
                throw new InvalidOperationException($"unknown entry {args[0]}");
        }
    }

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
