using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared binding error corpus: what a script catches when a host binding fails, here
/// exactly as in the other three runtimes. This runtime has no async bindings, so the async
/// case is skipped.
/// </summary>
public class BindingErrorCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "binding-error-tests.json");
            return JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(path))).RootElement.Clone();
        }
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var entry in Corpus.GetProperty("cases").EnumerateArray())
        {
            if (entry.TryGetProperty("async", out var isAsync) && isAsync.GetBoolean()) continue;
            data.Add(entry.GetProperty("name").GetString()!);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Applies_The_Corpus_Case(string name)
    {
        var corpus = Corpus;
        var testCase = corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);

        using var runtime = XriptRuntime.Create(
            corpus.GetProperty("manifest").GetRawText(), new RuntimeOptions { HostBindings = Bindings() });
        runtime.Execute(corpus.GetProperty("setup").GetString()!);
        var actual = runtime.Execute(testCase.GetProperty("script").GetString()!).Value;
        var expected = testCase.GetProperty("expected");

        if (expected.ValueKind != JsonValueKind.Object)
        {
            Assert.Equal(Canon(expected), Canon(actual));
            return;
        }
        Assert.True(actual.ValueKind == JsonValueKind.Object, $"expected a thrown error, got {actual.GetRawText()}");
        foreach (var field in expected.EnumerateObject())
        {
            if (field.Name == "messageStartsWith")
            {
                var message = actual.GetProperty("message").GetString()!;
                Assert.True(message.StartsWith(field.Value.GetString()!, StringComparison.Ordinal), $"message {message}");
                continue;
            }
            var got = actual.TryGetProperty(field.Name, out var value) ? value.GetRawText() : "undefined";
            Assert.True(field.Value.GetRawText() == got, $"{field.Name}: expected {field.Value.GetRawText()}, got {got} in {actual.GetRawText()}");
        }
    }

    private static string Canon(JsonElement element) =>
        element.ValueKind == JsonValueKind.Number
            ? element.GetDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture)
            : element.ValueKind == JsonValueKind.Array
                ? "[" + string.Join(",", element.EnumerateArray().Select(Canon)) + "]"
                : element.GetRawText();

    private static HostBindings Bindings()
    {
        var bindings = new HostBindings();
        var one = JsonSerializer.SerializeToElement(1);
        bindings.AddFunction("boom", (HostFunction)(_ => throw new InvalidOperationException("boom")));
        bindings.AddFunction("prefixed", (HostFunction)(_ => throw new InvalidOperationException("prefixed(): already")));
        bindings.AddFunction("gated", (HostFunction)(_ => one));
        bindings.AddFunction("takesFn", (HostFunction)(_ => one));
        bindings.AddFunction("deep", (HostFunction)(_ => one));
        bindings.AddNamespace("nested", new Dictionary<string, HostFunction>
        {
            ["inner"] = _ => throw new InvalidOperationException("inner fail"),
        });
        return bindings;
    }
}
