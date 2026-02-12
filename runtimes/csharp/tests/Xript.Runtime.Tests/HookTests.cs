using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class HookTests
{
    [Fact]
    public void Registers_And_Fires_Simple_Hook()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);
        rt.Execute("hooks.onInit(function() { return 42; })");

        var results = rt.FireHook("onInit");
        Assert.Single(results);
        Assert.Equal(42, results[0].GetInt64());
    }

    [Fact]
    public void Fires_Multiple_Handlers()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);
        rt.Execute("hooks.onInit(function() { return 'a'; }); hooks.onInit(function() { return 'b'; });");

        var results = rt.FireHook("onInit");
        Assert.Equal(2, results.Length);
        Assert.Equal("a", results[0].GetString());
        Assert.Equal("b", results[1].GetString());
    }

    [Fact]
    public void Returns_Empty_For_Unknown_Hook()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);

        var results = rt.FireHook("nonexistent");
        Assert.Empty(results);
    }

    [Fact]
    public void Returns_Empty_For_Unregistered_Hook()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);

        var results = rt.FireHook("onInit");
        Assert.Empty(results);
    }

    [Fact]
    public void Phased_Hook_Fires_Correct_Phase()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithPhasedHooks);
        rt.Execute("""
            hooks.onTurn.before(function() { return 'before-result'; });
            hooks.onTurn.after(function() { return 'after-result'; });
            """);

        var before = rt.FireHook("onTurn", new FireHookOptions { Phase = "before" });
        Assert.Single(before);
        Assert.Equal("before-result", before[0].GetString());

        var after = rt.FireHook("onTurn", new FireHookOptions { Phase = "after" });
        Assert.Single(after);
        Assert.Equal("after-result", after[0].GetString());
    }

    [Fact]
    public void Returns_Empty_For_Invalid_Phase()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithPhasedHooks);

        var results = rt.FireHook("onTurn", new FireHookOptions { Phase = "invalid" });
        Assert.Empty(results);
    }

    [Fact]
    public void Hook_Receives_Data()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);
        rt.Execute("hooks.onInit(function(x) { return x * 2; })");

        var data = JsonDocument.Parse("5").RootElement;
        var results = rt.FireHook("onInit", new FireHookOptions { Data = data });
        Assert.Single(results);
        Assert.Equal(10, results[0].GetInt64());
    }

    [Fact]
    public void Hook_Receives_Object_Data_As_Spread_Args()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);
        rt.Execute("hooks.onInit(function(a, b) { return a + b; })");

        var data = JsonDocument.Parse("""{"x": 3, "y": 4}""").RootElement;
        var results = rt.FireHook("onInit", new FireHookOptions { Data = data });
        Assert.Single(results);
        Assert.Equal(7, results[0].GetInt64());
    }

    [Fact]
    public void Hooks_Object_Is_Frozen()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);

        var result = rt.Execute("Object.isFrozen(hooks)");
        Assert.True(result.Value.GetBoolean());
    }

    [Fact]
    public void Capability_Gated_Hook_Denied()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithCapabilityGatedHook);

        var result = rt.Execute("try { hooks.onSave(function(){}); 'registered' } catch(e) { 'denied' }");
        Assert.Equal("denied", result.Value.GetString());
    }

    [Fact]
    public void Capability_Gated_Hook_Granted()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithCapabilityGatedHook, new RuntimeOptions
        {
            Capabilities = ["save-access"]
        });

        rt.Execute("hooks.onSave(function() { return 'saved'; })");
        var results = rt.FireHook("onSave");
        Assert.Single(results);
        Assert.Equal("saved", results[0].GetString());
    }

    [Fact]
    public void Handler_Error_Returns_Null_In_Results()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithHooks);
        rt.Execute("""
            hooks.onInit(function() { throw new Error('boom'); });
            hooks.onInit(function() { return 'ok'; });
            """);

        var results = rt.FireHook("onInit");
        Assert.Equal(2, results.Length);
        Assert.Equal(JsonValueKind.Null, results[0].ValueKind);
        Assert.Equal("ok", results[1].GetString());
    }
}
