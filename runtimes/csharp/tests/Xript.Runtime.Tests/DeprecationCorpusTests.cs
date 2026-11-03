using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared deprecation corpus, so the channel's notice shape, once-per-runtime delivery, and
/// its codes cannot drift from the other three runtimes.
/// </summary>
public class DeprecationCorpusTests
{
    private static JsonElement Corpus
    {
        get
        {
            var path = Path.Combine(
                AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", "deprecation-tests.json");
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

    internal static HostBindings Provide(JsonElement paths)
    {
        var bindings = new HostBindings();
        var namespaces = new Dictionary<string, Dictionary<string, HostNamespaceMember>>();
        foreach (var path in paths.EnumerateArray().Select(p => p.GetString()!))
        {
            var parts = path.Split('.');
            HostFunction fn = _ => JsonSerializer.SerializeToElement("host");
            if (parts.Length == 1)
            {
                bindings.AddFunction(parts[0], fn);
                continue;
            }
            if (!namespaces.TryGetValue(parts[0], out var members))
                namespaces[parts[0]] = members = new Dictionary<string, HostNamespaceMember>();
            members[parts[1]] = HostNamespaceMember.Fn(fn);
        }
        foreach (var (name, members) in namespaces)
            bindings.AddNestedNamespace(name, members);
        return bindings;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Raises_The_Corpus_Notices(string name)
    {
        var entry = Corpus.GetProperty("cases").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);
        var manifest = entry.GetProperty("manifest").GetRawText();
        var expected = entry.GetProperty("expect").EnumerateArray()
            .Select(n => new Deprecation(
                n.GetProperty("code").GetString()!,
                n.GetProperty("message").GetString()!,
                n.GetProperty("replacement").GetString()!))
            .ToList();
        var runtimes = entry.TryGetProperty("runtimes", out var count) ? count.GetInt32() : 1;

        for (var i = 0; i < runtimes; i++)
        {
            var notices = new List<Deprecation>();
            using var rt = XriptRuntime.Create(manifest, new RuntimeOptions
            {
                HostBindings = Provide(entry.GetProperty("provided")),
                OnDeprecation = notices.Add,
            });
            Assert.Equal(expected, notices);
        }
    }

    [Fact]
    public void A_Throwing_Handler_Changes_Nothing()
    {
        var manifest = """{ "xript": "0.10", "name": "shadow-probe", "bindings": { "hooks": { "description": "Shadowed." } } }""";
        var bindings = new HostBindings();
        bindings.AddFunction("hooks", _ => JsonSerializer.SerializeToElement("host"));
        using var rt = XriptRuntime.Create(manifest, new RuntimeOptions
        {
            HostBindings = bindings,
            OnDeprecation = _ => throw new InvalidOperationException("handler failed"),
        });
        Assert.Equal("object", rt.Execute("typeof hooks").Value.GetString());
    }
}

/// <summary>Swaps <see cref="Console.Error"/>, so it runs alone.</summary>
[CollectionDefinition("console-error", DisableParallelization = true)]
public class ConsoleErrorCollection;

[Collection("console-error")]
public class DeprecationDefaultTests
{
    [Fact]
    public void Without_A_Handler_Each_Code_Warns_Once_Per_Runtime_On_Console_Error()
    {
        var manifest = """{ "xript": "0.10", "name": "shadow-probe", "bindings": { "hooks": { "description": "Shadowed." } } }""";
        var original = Console.Error;
        var captured = new StringWriter();
        Console.SetError(captured);
        try
        {
            for (var i = 0; i < 2; i++)
            {
                var bindings = new HostBindings();
                bindings.AddFunction("hooks", _ => JsonSerializer.SerializeToElement("host"));
                using var rt = XriptRuntime.Create(manifest, new RuntimeOptions { HostBindings = bindings });
                rt.Execute("1");
            }
        }
        finally
        {
            Console.SetError(original);
        }

        var lines = captured.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        var expected = "xript: host bindings replaced by a built-in global of the same name, which mods see instead: hooks (binding-shadows-builtin). Rename the binding or move it under a namespace.";
        Assert.Equal([expected, expected], lines);
    }
}
