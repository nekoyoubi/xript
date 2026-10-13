using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared escape corpus: every constructor chain a script can walk ends at a
/// <c>Function</c> that refuses to compile a string.
/// </summary>
public class EscapeCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "escape-tests.json");
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

    private static HostBindings Probe()
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("probe", new Dictionary<string, HostFunction>
        {
            ["data"] = _ => JsonSerializer.SerializeToElement(new { list = new object[] { 1, new { k = "v" } } }),
            ["fail"] = _ => throw new InvalidOperationException("host failure"),
            ["call"] = args =>
            {
                var path = args[0].EnumerateArray().ToList();
                var target = args[2 + path[0].GetInt32()];
                foreach (var step in path.Skip(1))
                    target = step.ValueKind == JsonValueKind.String ? target.GetProperty(step.GetString()!) : target[step.GetInt32()];
                var callback = XriptCallback.From(target) ?? throw new InvalidOperationException("not a callback");
                return callback.Invoke(args[1].EnumerateArray().ToArray());
            },
        });
        return bindings;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Blocks_The_Constructor_Chain(string name)
    {
        var entry = Corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);
        var script = Corpus.GetProperty("template").GetString()!.Replace("EXPR", entry.GetProperty("expr").GetString()!);

        using var rt = XriptRuntime.Create(Corpus.GetProperty("manifest").GetRawText(), new RuntimeOptions { HostBindings = Probe() });

        Assert.Equal("blocked", rt.Execute(script).Value.GetString());
    }

    [Fact]
    public void The_Corpus_Carries_Cases()
    {
        Assert.NotEmpty(Corpus.GetProperty("cases").EnumerateArray());
    }
}
