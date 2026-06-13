using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class FillsTests
{
    private const string HostManifest = """
        {
            "xript": "0.7",
            "name": "fills-host",
            "capabilities": {
                "ui": { "description": "UI access" }
            },
            "slots": [
                { "id": "sidebar.left", "accepts": ["text/html"], "multiple": true, "description": "left panel" },
                { "id": "gated.panel", "accepts": ["text/html"], "capability": "ui", "description": "gated panel" },
                { "id": "transcriber", "accepts": ["application/x-xript-role"], "description": "transcription provider" },
                { "id": "on-save", "accepts": ["application/x-xript-hook"], "description": "save event" }
            ]
        }
        """;

    private const string Panel = """<div><p data-bind="status">…</p></div>""";

    private static JsonElement Str(string s) =>
        JsonDocument.Parse(JsonSerializer.Serialize(s)).RootElement.Clone();

    private static XriptRuntime MakeRuntime(List<string>? capabilities = null) =>
        XriptRuntime.Create(HostManifest, new RuntimeOptions { Capabilities = capabilities ?? [] });

    [Fact]
    public void Loads_A_Fragment_Format_Fill_And_Resolves_The_Slot()
    {
        using var rt = MakeRuntime();
        var mod = rt.LoadMod("""
            {
                "xript": "0.7", "name": "panel-mod", "version": "1.0.0",
                "fills": { "sidebar.left": [ { "id": "info-panel", "format": "text/html", "source": "fragments/panel.html", "bindings": [{ "name": "status", "path": "app.status" }] } ] }
            }
            """, new Dictionary<string, string> { ["fragments/panel.html"] = Panel });
        Assert.Single(mod.Fragments);
        Assert.Equal("info-panel", mod.Fragments[0].Id);
        var contributions = rt.ResolveSlot("sidebar.left");
        Assert.Single(contributions);
        Assert.Equal("info-panel", contributions[0].FragmentId);
    }

    [Fact]
    public void Synthesizes_A_Stable_Id_For_An_Idless_Fill()
    {
        using var rt = MakeRuntime();
        var mod = rt.LoadMod("""
            {
                "xript": "0.7", "name": "anon-mod", "version": "1.0.0",
                "fills": { "sidebar.left": [ { "format": "text/html", "source": "p.html" } ] }
            }
            """, new Dictionary<string, string> { ["p.html"] = Panel });
        Assert.Equal("sidebar.left-fill-0", mod.Fragments[0].Id);
    }

    [Fact]
    public void Loads_A_Role_Fill_And_Resolves_The_Provider()
    {
        using var rt = MakeRuntime();
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "whisper-mod", "version": "1.0.0",
                "fills": { "transcriber": [ { "fns": { "transcribe": "doTranscribe" } } ] }
            }
            """);
        var resolution = rt.ResolveRole("transcriber");
        Assert.NotNull(resolution);
        Assert.Equal("whisper-mod", resolution!.Addon);
        Assert.Equal("doTranscribe", resolution.Fns["transcribe"]);
    }

    [Fact]
    public void Fires_An_Event_Hook_Fills_Handler_Export()
    {
        using var rt = MakeRuntime();
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "hook-mod", "version": "1.0.0",
                "entry": { "script": "mod.js", "exports": { "onSave": { "description": "save handler" } } },
                "fills": { "on-save": [ { "handler": "onSave" } ] }
            }
            """, new Dictionary<string, string>
        {
            ["mod.js"] = """xript.exports.register("onSave", function(path) { return "saved " + path; });""",
        });
        var results = rt.FireHook("on-save", new FireHookOptions { Data = Str("/tmp/x") });
        Assert.Single(results);
        Assert.Equal("saved /tmp/x", results[0].GetString());
    }

    [Fact]
    public void Rejects_A_Fill_Targeting_An_Undeclared_Slot()
    {
        using var rt = MakeRuntime();
        var ex = Assert.Throws<ModManifestValidationException>(() => rt.LoadMod("""
            { "xript": "0.7", "name": "m", "version": "1.0.0", "fills": { "ghost": [ { "format": "text/html", "source": "p.html" } ] } }
            """));
        Assert.Contains("does not exist", ex.Message);
    }

    [Fact]
    public void Gates_A_Fill_On_The_Slots_Capability()
    {
        using var denied = MakeRuntime();
        var ex = Assert.Throws<ModManifestValidationException>(() => denied.LoadMod("""
            { "xript": "0.7", "name": "m", "version": "1.0.0", "fills": { "gated.panel": [ { "format": "text/html", "source": "p.html" } ] } }
            """, new Dictionary<string, string> { ["p.html"] = Panel }));
        Assert.Contains("requires capability 'ui'", ex.Message);

        using var granted = MakeRuntime(["ui"]);
        var mod = granted.LoadMod("""
            { "xript": "0.7", "name": "m", "version": "1.0.0", "fills": { "gated.panel": [ { "format": "text/html", "source": "p.html" } ] } }
            """, new Dictionary<string, string> { ["p.html"] = Panel });
        Assert.Single(mod.Fragments);
    }

    [Fact]
    public void Rejects_Mixing_Fills_With_The_Deprecated_Surfaces()
    {
        using var rt = MakeRuntime();
        var ex = Assert.Throws<ModManifestValidationException>(() => rt.LoadMod("""
            {
                "xript": "0.7", "name": "m", "version": "1.0.0",
                "fills": { "sidebar.left": [ { "format": "text/html", "source": "p.html" } ] },
                "fragments": [ { "id": "x", "slot": "sidebar.left", "format": "text/html", "source": "p.html" } ]
            }
            """));
        Assert.Contains("'fills' alone", ex.Message);
    }
}
