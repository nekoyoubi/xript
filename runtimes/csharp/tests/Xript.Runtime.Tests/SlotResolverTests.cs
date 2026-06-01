using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class SlotResolverTests
{
    private const string AppWithSlots = """
        {
            "xript": "0.3",
            "name": "host",
            "slots": [
                { "id": "sidebar", "accepts": ["text/html"], "multiple": true },
                { "id": "header", "accepts": ["text/html"] }
            ]
        }
        """;

    private static string Mod(string name, string fragmentId, string slot, int priority) => $$"""
        {
            "xript": "0.3",
            "name": "{{name}}",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "{{fragmentId}}",
                    "slot": "{{slot}}",
                    "format": "text/html",
                    "source": "<div>x</div>",
                    "inline": true,
                    "priority": {{priority}}
                }
            ]
        }
        """;

    [Fact]
    public void Resolves_Multiple_Contributions_By_Priority()
    {
        using var rt = XriptRuntime.Create(AppWithSlots);
        rt.LoadMod(Mod("low", "frag-low", "sidebar", 1));
        rt.LoadMod(Mod("high", "frag-high", "sidebar", 10));
        rt.LoadMod(Mod("mid", "frag-mid", "sidebar", 5));

        var resolved = rt.ResolveSlot("sidebar");

        Assert.Equal(3, resolved.Length);
        Assert.Equal("frag-high", resolved[0].FragmentId);
        Assert.Equal("frag-mid", resolved[1].FragmentId);
        Assert.Equal("frag-low", resolved[2].FragmentId);
    }

    [Fact]
    public void Ties_Break_By_Fragment_Id_Ascending()
    {
        using var rt = XriptRuntime.Create(AppWithSlots);
        rt.LoadMod(Mod("z", "zeta", "sidebar", 5));
        rt.LoadMod(Mod("a", "alpha", "sidebar", 5));

        var resolved = rt.ResolveSlot("sidebar");

        Assert.Equal("alpha", resolved[0].FragmentId);
        Assert.Equal("zeta", resolved[1].FragmentId);
    }

    [Fact]
    public void Single_Cardinality_Returns_Winner_Only()
    {
        using var rt = XriptRuntime.Create(AppWithSlots);
        rt.LoadMod(Mod("low", "frag-low", "header", 1));
        rt.LoadMod(Mod("high", "frag-high", "header", 10));

        var resolved = rt.ResolveSlot("header");

        Assert.Single(resolved);
        Assert.Equal("frag-high", resolved[0].FragmentId);
    }

    [Fact]
    public void Resolve_Single_Returns_Nullable()
    {
        using var rt = XriptRuntime.Create(AppWithSlots);
        rt.LoadMod(Mod("a", "frag-a", "header", 3));

        var winner = rt.ResolveSlotSingle("header");
        Assert.NotNull(winner);
        Assert.Equal("frag-a", winner!.FragmentId);

        Assert.Null(rt.ResolveSlotSingle("undeclared-slot"));
    }

    [Fact]
    public void Undeclared_Slot_Returns_Empty()
    {
        using var rt = XriptRuntime.Create(AppWithSlots);
        var resolved = rt.ResolveSlot("nope");
        Assert.Empty(resolved);
    }

    [Fact]
    public void Contribution_Carries_Mod_Name_And_Format()
    {
        using var rt = XriptRuntime.Create(AppWithSlots);
        rt.LoadMod(Mod("addon", "frag-x", "header", 0));

        var contribution = rt.ResolveSlot("header")[0];
        Assert.Equal("frag-x", contribution.FragmentId);
        Assert.Equal("header", contribution.Slot);
        Assert.Equal("text/html", contribution.Format);
        Assert.Contains("addon", contribution.ModName);
    }
}
