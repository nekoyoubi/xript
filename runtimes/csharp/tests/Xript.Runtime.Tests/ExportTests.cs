using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class ExportTests
{
    private static JsonElement Str(string s) =>
        JsonDocument.Parse(JsonSerializer.Serialize(s)).RootElement.Clone();

    private const string ModWithExport = """
        {
            "xript": "0.3",
            "name": "transcriber",
            "version": "1.0.0",
            "entry": {
                "script": "main.js",
                "format": "script",
                "exports": {
                    "shout": { "description": "uppercases input" }
                }
            }
        }
        """;

    [Fact]
    public void Invoke_Registered_Export_Returns_Value()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(ModWithExport, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('shout', function(s) { return s.toUpperCase(); });"
        });

        var result = rt.InvokeExport("shout", [Str("hello")]);
        Assert.Equal("HELLO", result.GetString());
    }

    [Fact]
    public void Invoke_Unknown_Export_Throws()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<InvokeException>(() => rt.InvokeExport("nope", []));
        Assert.Equal("nope", ex.Export);
        Assert.Contains("not found", ex.Message);
    }

    [Fact]
    public void Throwing_Export_Surfaces_As_Invoke_Error()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod("""
            {
                "xript": "0.3",
                "name": "bad",
                "version": "1.0.0",
                "entry": { "script": "main.js", "exports": { "boom": { "description": "throws" } } }
            }
            """, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('boom', function() { throw new Error('kaboom'); });"
        });

        var ex = Assert.Throws<InvokeException>(() => rt.InvokeExport("boom", []));
        Assert.Equal("boom", ex.Export);
        Assert.Contains("kaboom", ex.Message);
    }

    [Fact]
    public void Capability_Gated_Export_Denied_Without_Grant()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "secure",
                "version": "1.0.0",
                "entry": {
                    "script": "main.js",
                    "exports": { "secret": { "description": "needs cap", "capability": "audio-read" } }
                }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('secret', function() { return 42; });"
        });

        Assert.Throws<CapabilityDeniedException>(() => rt.InvokeExport("secret", []));
    }

    [Fact]
    public void Capability_Gated_Export_Allowed_With_Grant()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "secure",
                "version": "1.0.0",
                "entry": {
                    "script": "main.js",
                    "exports": { "secret": { "description": "needs cap", "capability": "audio-read" } }
                }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Capabilities = ["audio-read"]
        });
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('secret', function() { return 42; });"
        });

        var result = rt.InvokeExport("secret", []);
        Assert.Equal(42, result.GetInt64());
    }

    [Fact]
    public void Bare_String_Entry_Still_Works()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod("""
            { "xript": "0.3", "name": "classic", "version": "1.0.0", "entry": "main.js" }
            """, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('ping', function() { return 'pong'; });"
        });

        Assert.Equal("pong", rt.InvokeExport("ping", []).GetString());
    }

    [Fact]
    public void Export_Receives_Multiple_Json_Args()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod("""
            {
                "xript": "0.3",
                "name": "math",
                "version": "1.0.0",
                "entry": { "script": "main.js", "exports": { "sum": { "description": "adds" } } }
            }
            """, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('sum', function(a, b) { return a + b; });"
        });

        var result = rt.InvokeExport("sum", [
            JsonDocument.Parse("3").RootElement.Clone(),
            JsonDocument.Parse("4").RootElement.Clone()
        ]);
        Assert.Equal(7, result.GetInt64());
    }
}
