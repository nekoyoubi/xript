using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared optional-binding corpus: omitted optional bindings read as <c>undefined</c> and
/// <c>xript.has</c> answers presence the same here as in the other three runtimes.
/// </summary>
public class OptionalBindingCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "optional-binding-tests.json");
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

    private static HostBindings Host(JsonElement corpus)
    {
        var bindings = new HostBindings();
        var namespaces = new Dictionary<string, Dictionary<string, HostNamespaceMember>>();
        foreach (var provided in corpus.GetProperty("provided").EnumerateObject())
        {
            var returns = provided.Value.GetProperty("returns").Clone();
            var dot = provided.Name.IndexOf('.');
            if (dot >= 0)
            {
                var ns = provided.Name[..dot];
                if (!namespaces.TryGetValue(ns, out var members))
                    namespaces[ns] = members = new Dictionary<string, HostNamespaceMember>();
                members[provided.Name[(dot + 1)..]] = HostNamespaceMember.Fn(_ => returns);
            }
            else if (provided.Name == "echo")
            {
                bindings.AddFunction("echo", args => args.Length > 0 ? args[0] : JsonSerializer.SerializeToElement<object?>(null));
            }
            else
            {
                bindings.AddFunction(provided.Name, _ => returns);
            }
        }
        foreach (var (name, members) in namespaces)
            bindings.AddNestedNamespace(name, members);
        return bindings;
    }

    private static List<string> Capabilities(JsonElement corpus) =>
        corpus.GetProperty("capabilities").EnumerateArray().Select(c => c.GetString()!).ToList();

    private static string[] ExpectedMissing(JsonElement corpus) =>
        corpus.GetProperty("missingBindings").EnumerateArray().Select(c => c.GetString()!).ToArray();

    private static bool JsonEquals(JsonElement a, JsonElement b) =>
        JsonNode.DeepEquals(JsonNode.Parse(a.GetRawText()), JsonNode.Parse(b.GetRawText()));

    [Fact]
    public void Carries_Cases()
    {
        Assert.NotEmpty(Corpus.GetProperty("cases").EnumerateArray());
    }

    [Fact]
    public void Reports_Only_The_Non_Optional_Omission_As_Missing()
    {
        var corpus = Corpus;
        using var rt = XriptRuntime.Create(
            corpus.GetProperty("manifest").GetRawText(),
            new RuntimeOptions { HostBindings = Host(corpus), Capabilities = Capabilities(corpus) });
        Assert.Equal(ExpectedMissing(corpus), rt.MissingBindings);
    }

    [Fact]
    public void Strict_Construction_Names_Exactly_The_Non_Optional_Omission()
    {
        var corpus = Corpus;
        var error = Assert.Throws<MissingBindingsException>(() => XriptRuntime.Create(
            corpus.GetProperty("manifest").GetRawText(),
            new RuntimeOptions { HostBindings = Host(corpus), Capabilities = Capabilities(corpus), StrictBindings = true }));
        Assert.Equal(ExpectedMissing(corpus), error.Missing);
    }

    [Fact]
    public void Strict_Construction_Succeeds_Once_Only_Optional_Bindings_Are_Omitted()
    {
        var corpus = Corpus;
        var host = Host(corpus);
        host.AddFunction("legacy", _ => JsonSerializer.SerializeToElement("late"));
        using var rt = XriptRuntime.Create(
            corpus.GetProperty("manifest").GetRawText(),
            new RuntimeOptions { HostBindings = host, Capabilities = Capabilities(corpus), StrictBindings = true });
        Assert.Empty(rt.MissingBindings);
    }

    [Fact]
    public void An_Eager_Value_For_A_Declared_Function_Is_Missing_And_Has_Agrees()
    {
        var eager = Corpus.GetProperty("eagerValue");
        var namespaces = new Dictionary<string, Dictionary<string, HostNamespaceMember>>();
        Dictionary<string, HostNamespaceMember> MembersOf(string path)
        {
            var ns = path[..path.IndexOf('.')];
            if (!namespaces.TryGetValue(ns, out var members))
                namespaces[ns] = members = new Dictionary<string, HostNamespaceMember>();
            return members;
        }
        foreach (var provided in eager.GetProperty("provided").EnumerateObject())
        {
            var returns = provided.Value.GetProperty("returns").Clone();
            MembersOf(provided.Name)[provided.Name[(provided.Name.IndexOf('.') + 1)..]] = HostNamespaceMember.Fn(_ => returns);
        }
        foreach (var eagerValue in eager.GetProperty("providedValues").EnumerateObject())
            MembersOf(eagerValue.Name)[eagerValue.Name[(eagerValue.Name.IndexOf('.') + 1)..]] = HostNamespaceMember.Value(eagerValue.Value.Clone());
        var host = new HostBindings();
        foreach (var (name, members) in namespaces)
            host.AddNestedNamespace(name, members);

        using var rt = XriptRuntime.Create(eager.GetProperty("manifest").GetRawText(), new RuntimeOptions { HostBindings = host });
        Assert.Equal(
            eager.GetProperty("missingBindings").EnumerateArray().Select(m => m.GetString()!).ToArray(),
            rt.MissingBindings);
        var value = rt.Execute(eager.GetProperty("script").GetString()!).Value;
        var expected = eager.GetProperty("expect").GetProperty("result");
        Assert.True(JsonEquals(value, expected), $"expected {expected.GetRawText()}, got {value.GetRawText()}");
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Case_Holds(string name)
    {
        var corpus = Corpus;
        var entry = corpus.GetProperty("cases").EnumerateArray().First(c => c.GetProperty("name").GetString() == name);
        var script = entry.GetProperty("script").GetString()!;
        var expect = entry.GetProperty("expect");

        using var rt = XriptRuntime.Create(
            corpus.GetProperty("manifest").GetRawText(),
            new RuntimeOptions { HostBindings = Host(corpus), Capabilities = Capabilities(corpus) });

        if (expect.TryGetProperty("error", out var parts))
        {
            var error = Assert.ThrowsAny<Exception>(() => rt.Execute(script));
            foreach (var part in parts.EnumerateArray())
                Assert.Contains(part.GetString()!, error.Message);
            return;
        }

        var value = rt.Execute(script).Value;
        Assert.True(
            JsonEquals(value, expect.GetProperty("result")),
            $"expected {expect.GetProperty("result").GetRawText()}, got {value.GetRawText()}");
    }
}
