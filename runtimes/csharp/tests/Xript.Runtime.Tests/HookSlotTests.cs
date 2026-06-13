using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class HookSlotTests
{
    private const string SlotHookManifest = """
        {
            "xript": "0.7",
            "name": "slot-hook-app",
            "capabilities": { "persistence": { "description": "save access" } },
            "slots": [
                { "id": "playerDamage", "accepts": ["application/x-xript-hook"], "description": "took damage" },
                { "id": "save", "accepts": ["application/x-xript-hook"], "description": "save", "capability": "persistence.disk" }
            ]
        }
        """;

    [Fact]
    public void Injects_Registration_Verb_For_Event_Typed_Slot()
    {
        using var rt = XriptRuntime.Create(SlotHookManifest);
        rt.Execute("globalThis.__hit = 0; hooks.playerDamage(function(amount) { globalThis.__hit = amount; });");

        var data = JsonDocument.Parse("""{"amount": 25}""").RootElement;
        var results = rt.FireHook("playerDamage", new FireHookOptions { Data = data });
        Assert.Single(results);
        Assert.Equal(25, rt.Execute("globalThis.__hit").Value.GetInt64());
    }

    [Fact]
    public void Fires_Multiple_Slot_Hook_Handlers_In_Registration_Order()
    {
        using var rt = XriptRuntime.Create(SlotHookManifest);
        rt.Execute("""
            hooks.playerDamage(function() { return 'a'; });
            hooks.playerDamage(function() { return 'b'; });
            """);

        var results = rt.FireHook("playerDamage");
        Assert.Equal(2, results.Length);
        Assert.Equal("a", results[0].GetString());
        Assert.Equal("b", results[1].GetString());
    }

    [Fact]
    public void Slot_Hook_Registration_Denied_Without_Grant()
    {
        using var rt = XriptRuntime.Create(SlotHookManifest);
        var result = rt.Execute(
            "try { hooks.save(function(){}); 'registered' } catch(e) { 'denied' }");
        Assert.Equal("denied", result.Value.GetString());
    }

    [Fact]
    public void Slot_Hook_Registration_Allowed_With_Subsuming_Grant()
    {
        using var rt = XriptRuntime.Create(SlotHookManifest, new RuntimeOptions
        {
            Capabilities = ["persistence"]
        });
        rt.Execute("globalThis.__hit = 0; hooks.save(function() { globalThis.__hit += 1; });");
        rt.FireHook("save");
        Assert.Equal(1, rt.Execute("globalThis.__hit").Value.GetInt64());
    }

    [Fact]
    public void Explicit_Hook_Wins_Over_Same_Id_Slot()
    {
        const string manifest = """
            {
                "xript": "0.7",
                "name": "slot-hook-app",
                "hooks": { "save": { "description": "explicit", "phases": ["pre", "post"] } },
                "slots": [
                    { "id": "save", "accepts": ["application/x-xript-hook"], "description": "slot" }
                ]
            }
            """;
        using var rt = XriptRuntime.Create(manifest);
        var result = rt.Execute("typeof hooks.save === 'object' && typeof hooks.save.pre === 'function'");
        Assert.True(result.Value.GetBoolean());
    }
}
