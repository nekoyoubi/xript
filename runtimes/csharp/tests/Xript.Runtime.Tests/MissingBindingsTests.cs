using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class MissingBindingsTests
{
    private const string HostManifest = """
        {
            "xript": "0.8",
            "name": "drift-host",
            "bindings": {
                "solo": { "description": "Standalone." },
                "fs": { "description": "Filesystem.", "members": {
                    "read": { "description": "Reads." },
                    "write": { "description": "Writes." }
                }}
            }
        }
        """;

    private static JsonElement Str(string value) =>
        JsonDocument.Parse(JsonSerializer.Serialize(value)).RootElement.Clone();

    private static HostBindings Partial()
    {
        var bindings = new HostBindings();
        bindings.AddNestedNamespace("fs", new Dictionary<string, HostNamespaceMember>
        {
            ["read"] = HostNamespaceMember.Fn(_ => Str("data")),
        });
        return bindings;
    }

    private static HostBindings Complete()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("solo", _ => Str("ok"));
        bindings.AddNestedNamespace("fs", new Dictionary<string, HostNamespaceMember>
        {
            ["read"] = HostNamespaceMember.Fn(_ => Str("data")),
            ["write"] = HostNamespaceMember.Fn(_ => Str("done")),
        });
        return bindings;
    }

    [Fact]
    public void Reports_Every_Declared_Binding_The_Host_Did_Not_Supply()
    {
        using var rt = XriptRuntime.Create(HostManifest, new RuntimeOptions { HostBindings = Partial() });

        Assert.Equal(new[] { "fs.write", "solo" }, rt.MissingBindings);
    }

    [Fact]
    public void Strict_Bindings_Refuses_To_Construct()
    {
        var error = Assert.Throws<MissingBindingsException>(() =>
            XriptRuntime.Create(HostManifest, new RuntimeOptions { HostBindings = Partial(), StrictBindings = true }));

        Assert.Equal(new[] { "fs.write", "solo" }, error.Missing);
    }

    [Fact]
    public void A_Fully_Supplied_Host_Is_Clean_Under_Strict()
    {
        using var rt = XriptRuntime.Create(
            HostManifest, new RuntimeOptions { HostBindings = Complete(), StrictBindings = true });

        Assert.Empty(rt.MissingBindings);
    }
}
