using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Host objects and arrays reach the sandbox as data, never as script text: template-literal
/// syntax, backticks and backslashes inside them arrive verbatim and run nothing.
/// </summary>
public class HostValueTextTests
{
    private const string Manifest = """
        {
            "xript": "0.10",
            "name": "test",
            "bindings": {
                "value": { "description": "returns a host object" },
                "ns": { "description": "a namespace", "members": { "label": { "description": "an eager property" } } }
            }
        }
        """;

    private const string Hostile = """{ "s": "`${globalThis.pwned = 1}` \\ $ ` ${", "list": ["${pwned = 2}"] }""";

    private static XriptRuntime Runtime(bool fidelity)
    {
        var bindings = new HostBindings();
        bindings.AddFunction("value", _ => JsonDocument.Parse(Hostile).RootElement.Clone());
        bindings.AddNestedNamespace("ns", new Dictionary<string, HostNamespaceMember>
        {
            ["label"] = HostNamespaceMember.Value(JsonDocument.Parse(Hostile).RootElement.Clone()),
        });
        return XriptRuntime.Create(Manifest, new RuntimeOptions { HostBindings = bindings, ValueFidelity = fidelity });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Binding_Return_Arrives_Verbatim(bool fidelity)
    {
        using var rt = Runtime(fidelity);
        var result = rt.Execute("const v = value(); JSON.stringify([v.s, v.list[0], typeof pwned])");
        Assert.Equal("""["`${globalThis.pwned = 1}` \\ $ ` ${","${pwned = 2}","undefined"]""", result.Value.GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Namespace_Property_Arrives_Verbatim(bool fidelity)
    {
        using var rt = Runtime(fidelity);
        var result = rt.Execute("JSON.stringify([ns.label.s, typeof pwned])");
        Assert.Equal("""["`${globalThis.pwned = 1}` \\ $ ` ${","undefined"]""", result.Value.GetString());
    }
}
