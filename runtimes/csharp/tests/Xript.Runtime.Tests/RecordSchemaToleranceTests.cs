using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class RecordSchemaToleranceTests
{
    [Fact]
    public void Manifest_Tolerates_Field_Default_And_Enum_Metadata()
    {
        var manifest = """
            {
                "xript": "0.3",
                "name": "host",
                "types": {
                    "BrickFiles": {
                        "fields": [
                            { "name": "path", "type": "string", "optional": true },
                            { "name": "pathStyle", "type": "string", "enum": ["posix", "hybrid", "native"], "default": "posix" },
                            { "name": "viewingEnabled", "type": "boolean", "default": true }
                        ]
                    }
                }
            }
            """;

        using var rt = XriptRuntime.Create(manifest);
        Assert.Equal("host", rt.Manifest.Name);
    }

    [Fact]
    public void Mod_Manifest_Tolerates_Contributions_Block()
    {
        var app = """{ "xript": "0.3", "name": "host" }""";
        var mod = """
            {
                "xript": "0.3",
                "name": "addon",
                "version": "1.0.0",
                "contributions": {
                    "provides": [
                        { "role": "clipboard-history", "fns": { "query": "clip_query" } }
                    ]
                }
            }
            """;

        using var rt = XriptRuntime.Create(app);
        var instance = rt.LoadMod(mod);
        Assert.Equal("addon", instance.Name);
    }

    [Fact]
    public void Runtime_Ignores_Unknown_Top_Level_Manifest_Keys()
    {
        var manifest = """
            {
                "xript": "0.3",
                "name": "host",
                "futureField": { "nested": [1, 2, 3] }
            }
            """;

        using var rt = XriptRuntime.Create(manifest);
        Assert.Equal("host", rt.Manifest.Name);
    }
}
