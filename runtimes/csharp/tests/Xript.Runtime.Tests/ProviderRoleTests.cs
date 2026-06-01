using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class ProviderRoleTests
{
    private const string App = """
        { "xript": "0.3", "name": "host" }
        """;

    private static string Mod(string name, string role, string queryFn) => $$"""
        {
            "xript": "0.3",
            "name": "{{name}}",
            "version": "1.0.0",
            "contributions": {
                "provides": [
                    {
                        "role": "{{role}}",
                        "fns": {
                            "query": "{{queryFn}}",
                            "restore": "{{name}}_restore"
                        }
                    }
                ]
            }
        }
        """;

    [Fact]
    public void Resolve_Role_Returns_Winner_With_Fns_Map()
    {
        using var rt = XriptRuntime.Create(App);
        rt.LoadMod(Mod("addon-a", "clipboard-history", "a_query"));

        var resolved = rt.ResolveRole("clipboard-history");

        Assert.NotNull(resolved);
        Assert.Equal("addon-a", resolved!.Addon);
        Assert.Equal("clipboard-history", resolved.Role);
        Assert.Equal("a_query", resolved.Fns["query"]);
        Assert.Equal("addon-a_restore", resolved.Fns["restore"]);
    }

    [Fact]
    public void Resolve_Role_First_Installed_Wins()
    {
        using var rt = XriptRuntime.Create(App);
        rt.LoadMod(Mod("first", "clipboard-history", "first_query"));
        rt.LoadMod(Mod("second", "clipboard-history", "second_query"));

        var resolved = rt.ResolveRole("clipboard-history");

        Assert.Equal("first", resolved!.Addon);
        Assert.Equal("first_query", resolved.Fns["query"]);
    }

    [Fact]
    public void Resolve_Role_Honors_Preference_Override()
    {
        var options = new RuntimeOptions
        {
            RolePreferences = new Dictionary<string, string> { ["clipboard-history"] = "second" },
        };
        using var rt = XriptRuntime.Create(App, options);
        rt.LoadMod(Mod("first", "clipboard-history", "first_query"));
        rt.LoadMod(Mod("second", "clipboard-history", "second_query"));

        var resolved = rt.ResolveRole("clipboard-history");

        Assert.Equal("second", resolved!.Addon);
        Assert.Equal("second_query", resolved.Fns["query"]);
    }

    [Fact]
    public void Unknown_Preference_Falls_Through_To_First()
    {
        var options = new RuntimeOptions
        {
            RolePreferences = new Dictionary<string, string> { ["clipboard-history"] = "ghost" },
        };
        using var rt = XriptRuntime.Create(App, options);
        rt.LoadMod(Mod("first", "clipboard-history", "first_query"));
        rt.LoadMod(Mod("second", "clipboard-history", "second_query"));

        var resolved = rt.ResolveRole("clipboard-history");

        Assert.Equal("first", resolved!.Addon);
    }

    [Fact]
    public void Resolve_Role_All_Returns_Every_Provider_In_Load_Order()
    {
        using var rt = XriptRuntime.Create(App);
        rt.LoadMod(Mod("alpha", "clipboard-history", "alpha_query"));
        rt.LoadMod(Mod("beta", "clipboard-history", "beta_query"));
        rt.LoadMod(Mod("gamma", "other-role", "gamma_query"));

        var all = rt.ResolveRoleAll("clipboard-history");

        Assert.Equal(2, all.Count);
        Assert.Equal("alpha", all[0].Addon);
        Assert.Equal("beta", all[1].Addon);
    }

    [Fact]
    public void Role_With_No_Provider_Resolves_Null()
    {
        using var rt = XriptRuntime.Create(App);
        rt.LoadMod(Mod("addon", "clipboard-history", "q"));

        Assert.Null(rt.ResolveRole("nonexistent"));
        Assert.Empty(rt.ResolveRoleAll("nonexistent"));
    }

    [Fact]
    public void Declaring_Provides_Grants_No_Capability()
    {
        using var rt = XriptRuntime.Create(App);
        var instance = rt.LoadMod(Mod("addon", "clipboard-history", "q"));

        Assert.NotNull(instance);
        Assert.NotNull(rt.ResolveRole("clipboard-history"));
    }
}
