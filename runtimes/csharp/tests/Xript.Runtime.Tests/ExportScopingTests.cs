using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class ExportScopingTests
{
    private const string HostManifest = """
        {
            "xript": "0.7",
            "name": "export-scoping-host",
            "capabilities": {
                "fs.write": { "description": "write files" }
            },
            "slots": [
                { "id": "on-tick", "accepts": ["application/x-xript-hook"], "description": "tick event" },
                { "id": "transcriber", "accepts": ["application/x-xript-role"], "description": "transcription provider" }
            ]
        }
        """;

    private const string GatedMod = """
        {
            "xript": "0.7", "name": "mod-a", "version": "1.0.0",
            "entry": { "script": "a.js", "format": "script", "exports": {
                "doThing": { "description": "does a gated thing", "capability": "fs.write" }
            }}
        }
        """;

    private const string GatedSource = "xript.exports.register('doThing', function() { return 'A-SECRET-RAN'; });";

    private static XriptRuntime MakeRuntime(List<string>? capabilities = null) =>
        XriptRuntime.Create(HostManifest, new RuntimeOptions { Capabilities = capabilities ?? [] });

    [Fact]
    public void A_Capability_Less_Redeclaration_Does_Not_Strip_The_Gate()
    {
        using var rt = MakeRuntime();
        rt.LoadMod(GatedMod, new Dictionary<string, string> { ["a.js"] = GatedSource });

        Assert.Throws<CapabilityDeniedException>(() => rt.InvokeExport("doThing", []));

        rt.LoadMod("""
            {
                "xript": "0.7", "name": "mod-b", "version": "1.0.0",
                "entry": { "script": "b.js", "format": "script", "exports": {
                    "doThing": { "description": "no capability at all" }
                }}
            }
            """, new Dictionary<string, string> { ["b.js"] = "" });

        var error = Record.Exception(() => rt.InvokeExport("doThing", []));
        Assert.True(
            error is AmbiguousExportException or CapabilityDeniedException,
            $"the gate did not hold: {error?.GetType().Name ?? "no throw"}");
    }

    [Fact]
    public void A_Later_Mod_Cannot_Hijack_An_Earlier_Mod_Export()
    {
        using var rt = MakeRuntime(["fs.write"]);
        rt.LoadMod(GatedMod, new Dictionary<string, string> { ["a.js"] = GatedSource });
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "mod-c", "version": "1.0.0",
                "entry": { "script": "c.js", "format": "script", "exports": {
                    "doThing": { "description": "hijack" }
                }}
            }
            """,
            new Dictionary<string, string>
            {
                ["c.js"] = "xript.exports.register('doThing', function() { return 'C-HIJACKED'; });",
            });

        Assert.Equal("A-SECRET-RAN", rt.InvokeModExport("mod-a", "doThing", []).GetString());
        Assert.Equal("C-HIJACKED", rt.InvokeModExport("mod-c", "doThing", []).GetString());

        var error = Assert.Throws<AmbiguousExportException>(() => rt.InvokeExport("doThing", []));
        Assert.Equal("doThing", error.Export);
        Assert.Equal(["mod-a", "mod-c"], error.Mods);
    }

    [Fact]
    public void A_Hook_Fill_Cannot_Reach_Another_Mods_Gated_Export()
    {
        using var rt = MakeRuntime();
        rt.LoadMod(GatedMod, new Dictionary<string, string> { ["a.js"] = GatedSource });

        rt.LoadMod("""
            {
                "xript": "0.7", "name": "mod-parasite", "version": "1.0.0",
                "fills": { "on-tick": [{ "handler": "doThing" }] }
            }
            """);

        var results = rt.FireHook("on-tick");
        Assert.DoesNotContain(results, r => r.ValueKind == JsonValueKind.String && r.GetString() == "A-SECRET-RAN");
    }

    [Fact]
    public void A_Mods_Own_Hook_Fill_Still_Fires_Under_Its_Own_Grant()
    {
        const string OwningMod = """
            {
                "xript": "0.7", "name": "mod-a", "version": "1.0.0",
                "entry": { "script": "a.js", "format": "script", "exports": {
                    "doThing": { "description": "does a gated thing", "capability": "fs.write" }
                }},
                "fills": { "on-tick": [{ "handler": "doThing" }] }
            }
            """;

        using (var granted = MakeRuntime(["fs.write"]))
        {
            granted.LoadMod(OwningMod, new Dictionary<string, string> { ["a.js"] = GatedSource });
            var results = granted.FireHook("on-tick");
            Assert.Single(results);
            Assert.Equal("A-SECRET-RAN", results[0].GetString());
        }

        using var denied = MakeRuntime();
        denied.LoadMod(OwningMod, new Dictionary<string, string> { ["a.js"] = GatedSource });
        var deniedResults = denied.FireHook("on-tick");
        Assert.Single(deniedResults);
        Assert.Equal(JsonValueKind.Null, deniedResults[0].ValueKind);
    }

    [Fact]
    public void Two_Role_Providers_Coexist_On_One_Export_Name()
    {
        using var rt = MakeRuntime();
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "fast-transcriber", "version": "1.0.0",
                "entry": { "script": "fast.js", "format": "script", "exports": { "transcribe": { "description": "fast" } } },
                "fills": { "transcriber": [{ "fns": { "transcribe": "transcribe" } }] }
            }
            """,
            new Dictionary<string, string>
            {
                ["fast.js"] = "xript.exports.register('transcribe', function() { return 'fast'; });",
            });
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "good-transcriber", "version": "1.0.0",
                "entry": { "script": "good.js", "format": "script", "exports": { "transcribe": { "description": "good" } } },
                "fills": { "transcriber": [{ "fns": { "transcribe": "transcribe" } }] }
            }
            """,
            new Dictionary<string, string>
            {
                ["good.js"] = "xript.exports.register('transcribe', function() { return 'good'; });",
            });

        var providers = rt.ResolveRoleAll("transcriber");
        Assert.Equal(2, providers.Count);
        var results = providers
            .Select(p => rt.InvokeModExport(p.Addon, p.Fns["transcribe"], []).GetString())
            .ToArray();
        Assert.Equal(["fast", "good"], results);
    }

    [Fact]
    public void A_Lone_Mod_Export_Stays_Invokable_By_Bare_Name()
    {
        using var rt = MakeRuntime(["fs.write"]);
        rt.LoadMod(GatedMod, new Dictionary<string, string> { ["a.js"] = GatedSource });
        Assert.Equal("A-SECRET-RAN", rt.InvokeExport("doThing", []).GetString());
    }

    [Fact]
    public void A_Host_Level_Registration_Stays_Invokable_By_Bare_Name()
    {
        using var rt = MakeRuntime();
        rt.Execute("xript.exports.register('hostSide', function(n) { return n * 2; });");
        var arg = JsonDocument.Parse("21").RootElement.Clone();
        Assert.Equal(42, rt.InvokeExport("hostSide", [arg]).GetInt32());
    }
}
