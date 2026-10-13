using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared corpus, so the load-time shape checks cannot drift from the other three runtimes.
/// </summary>
public class ManifestShapeCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "manifest-shape-tests.json");
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
        var entry = Corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);
        var manifest = entry.GetProperty("manifest").GetRawText();

        if (entry.TryGetProperty("valid", out var valid) && valid.GetBoolean())
        {
            using var rt = XriptRuntime.Create(manifest, new RuntimeOptions());
            using var doc = JsonDocument.Parse(manifest);
            using var fromValue = XriptRuntime.CreateFromValue(doc, new RuntimeOptions());
            return;
        }

        var expected = entry.GetProperty("issues").EnumerateArray()
            .Select(i => (i.GetProperty("path").GetString(), i.GetProperty("message").GetString()))
            .ToList();

        var error = Assert.Throws<ManifestValidationException>(() => XriptRuntime.Create(manifest, new RuntimeOptions()));
        Assert.Equal(expected, error.Issues.Select(i => ((string?)i.Path, (string?)i.Message)).ToList());

        using var parsed = JsonDocument.Parse(manifest);
        var fromValueError = Assert.Throws<ManifestValidationException>(() => XriptRuntime.CreateFromValue(parsed, new RuntimeOptions()));
        Assert.Equal(expected, fromValueError.Issues.Select(i => ((string?)i.Path, (string?)i.Message)).ToList());
    }

    [Fact]
    public void Passes_Every_Argument_Through_To_A_Variadic_Binding()
    {
        var received = new List<string[]>();
        var bindings = new HostBindings();
        bindings.AddFunction("log", args =>
        {
            received.Add(args.Select(a => a.GetString()!).ToArray());
            return JsonDocument.Parse("null").RootElement.Clone();
        });

        const string manifest = """
            {
                "xript": "0.9",
                "name": "probe",
                "bindings": {
                    "log": {
                        "description": "Logs.",
                        "params": [
                            { "name": "level", "type": "string" },
                            { "name": "parts", "type": "string", "variadic": true }
                        ]
                    }
                }
            }
            """;

        using var rt = XriptRuntime.Create(manifest, new RuntimeOptions { HostBindings = bindings });
        rt.Execute("log(\"info\", \"a\", \"b\", \"c\")");

        var call = Assert.Single(received);
        Assert.Equal(["info", "a", "b", "c"], call);
    }
}
