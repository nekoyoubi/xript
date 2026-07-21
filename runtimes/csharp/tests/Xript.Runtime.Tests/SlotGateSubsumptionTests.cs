using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The fragment/slot gate is where a mod's contribution is admitted, and it is the gate the
/// capability hierarchy has to reach for a dotted scope to mean anything on a fill.
/// </summary>
public class SlotGateSubsumptionTests
{
    private const string HostManifest = """
        {
            "xript": "0.8",
            "name": "slot-gate-app",
            "capabilities": {
                "ui": { "description": "UI surface." },
                "ui.sidebar": { "description": "The sidebar." }
            },
            "slots": [
                { "id": "sidebar", "accepts": ["text/html"], "description": "Sidebar.", "capability": "write:ui.sidebar" }
            ]
        }
        """;

    private const string ModManifest = """
        {
            "xript": "0.8", "name": "panel-mod", "version": "1.0.0",
            "capabilities": ["write:ui.sidebar"],
            "fills": { "sidebar": [{ "id": "panel", "format": "text/html", "source": "panel.html" }] }
        }
        """;

    private static bool Admits(params string[] granted)
    {
        using var rt = XriptRuntime.Create(
            HostManifest, new RuntimeOptions { Capabilities = granted.ToList() });
        try
        {
            rt.LoadMod(ModManifest, new Dictionary<string, string> { ["panel.html"] = "<p>hi</p>" });
            return true;
        }
        catch
        {
            return false;
        }
    }

    [Fact]
    public void A_Parent_Scope_Grant_Subsumes_The_Slots_Gate() => Assert.True(Admits("write:ui"));

    [Fact]
    public void An_Exact_Scope_Grant_Is_Admitted() => Assert.True(Admits("write:ui.sidebar"));

    [Fact]
    public void A_Read_Grant_Is_Refused_Against_A_Write_Gate() => Assert.False(Admits("read:ui"));

    [Fact]
    public void A_Scope_Sharing_Only_A_Character_Prefix_Is_Refused() => Assert.False(Admits("write:uiother"));
}
