using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class EventTests
{
    [Fact]
    public void Subscribes_And_Emits_Simple_Event()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);
        rt.Execute("events.on('player.spawned', function() { return 42; })");

        var results = rt.Emit("player.spawned");
        Assert.Single(results);
        Assert.Equal(42, results[0].GetInt64());
    }

    [Fact]
    public void Subscribe_Alias_Works()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);
        rt.Execute("events.subscribe('player.spawned', function() { return 'ok'; })");

        var results = rt.Emit("player.spawned");
        Assert.Single(results);
        Assert.Equal("ok", results[0].GetString());
    }

    [Fact]
    public void Emits_To_Multiple_Handlers_In_Registration_Order()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);
        rt.Execute("""
            events.on('player.spawned', function() { return 'a'; });
            events.on('player.spawned', function() { return 'b'; });
            """);

        var results = rt.Emit("player.spawned");
        Assert.Equal(2, results.Length);
        Assert.Equal("a", results[0].GetString());
        Assert.Equal("b", results[1].GetString());
    }

    [Fact]
    public void Emit_Spreads_Object_Payload_As_Positional_Args()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);
        rt.Execute("events.on('player.spawned', function(a, b) { return a + b; })");

        var data = JsonDocument.Parse("""{"x": 3, "y": 4}""").RootElement;
        var results = rt.Emit("player.spawned", new FireHookOptions { Data = data });
        Assert.Single(results);
        Assert.Equal(7, results[0].GetInt64());
    }

    [Fact]
    public void Emit_Passes_Scalar_Payload_As_Single_Arg()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);
        rt.Execute("events.on('player.spawned', function(x) { return x * 2; })");

        var data = JsonDocument.Parse("5").RootElement;
        var results = rt.Emit("player.spawned", new FireHookOptions { Data = data });
        Assert.Single(results);
        Assert.Equal(10, results[0].GetInt64());
    }

    [Fact]
    public void Returns_Empty_For_Undeclared_Event()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);

        var results = rt.Emit("nonexistent");
        Assert.Empty(results);
    }

    [Fact]
    public void Returns_Empty_When_No_Subscribers()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);

        var results = rt.Emit("player.spawned");
        Assert.Empty(results);
    }

    [Fact]
    public void Subscribing_To_Undeclared_Event_Throws()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);

        var result = rt.Execute(
            "try { events.on('ghost', function(){}); 'registered' } catch(e) { 'denied' }");
        Assert.Equal("denied", result.Value.GetString());
    }

    [Fact]
    public void Handler_Error_Yields_Null_In_Results()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);
        rt.Execute("""
            events.on('player.spawned', function() { throw new Error('boom'); });
            events.on('player.spawned', function() { return 'ok'; });
            """);

        var results = rt.Emit("player.spawned");
        Assert.Equal(2, results.Length);
        Assert.Equal(JsonValueKind.Null, results[0].ValueKind);
        Assert.Equal("ok", results[1].GetString());
    }

    [Fact]
    public void Events_Object_Is_Frozen()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithEvents);

        var result = rt.Execute("Object.isFrozen(events)");
        Assert.True(result.Value.GetBoolean());
    }

    [Fact]
    public void Capability_Gated_Subscription_Denied_Without_Grant()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithCapabilityGatedEvent);

        var result = rt.Execute(
            "try { events.on('world.changed', function(){}); 'registered' } catch(e) { 'denied' }");
        Assert.Equal("denied", result.Value.GetString());
    }

    [Fact]
    public void Capability_Gated_Subscription_Allowed_With_Read_Grant()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithCapabilityGatedEvent, new RuntimeOptions
        {
            Capabilities = ["read:world"]
        });

        rt.Execute("events.on('world.changed', function() { return 'observed'; })");
        var results = rt.Emit("world.changed");
        Assert.Single(results);
        Assert.Equal("observed", results[0].GetString());
    }

    [Fact]
    public void Capability_Gated_Subscription_Allowed_With_Write_Grant_Subsuming_Read()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithCapabilityGatedEvent, new RuntimeOptions
        {
            Capabilities = ["write:world"]
        });

        rt.Execute("events.on('world.changed', function() { return 'observed'; })");
        var results = rt.Emit("world.changed");
        Assert.Single(results);
        Assert.Equal("observed", results[0].GetString());
    }
}
