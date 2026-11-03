using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// A hook or event slot that declares its own <c>limits.timeout_ms</c> fires under that budget,
/// fresh per fire and shared by the fire's handlers, clamped by the embedder's hard limit.
/// </summary>
public class HookLimitsTests
{
    private static string HostManifest(long manifestMs, long hookMs) => $$"""
        {
            "xript": "0.10",
            "name": "hook-limits-host",
            "limits": { "timeout_ms": {{manifestMs}} },
            "hooks": {
                "bounded": { "description": "fires under its own budget", "limits": { "timeout_ms": {{hookMs}} } },
                "inherited": { "description": "fires under the manifest budget" }
            },
            "slots": [
                { "id": "on-bounded", "accepts": ["application/x-xript-hook"], "description": "an event slot with its own budget", "limits": { "timeout_ms": {{hookMs}} } },
                { "id": "wide.commands", "accepts": ["application/x-xript-command"], "description": "a slot granting far more time than any hook", "limits": { "timeout_ms": 60000 } }
            ]
        }
        """;

    private static string Spinner(int spinMs) =>
        $"function spin() {{ var end = Date.now() + {spinMs}; while (Date.now() < end) {{}} return 'finished'; }} " +
        "hooks.bounded(spin); hooks.inherited(spin); hooks['on-bounded'](spin);";

    private static XriptRuntime MakeRuntime(long manifestMs, long hookMs, long? hardMs = null)
    {
        var options = new RuntimeOptions { Capabilities = [] };
        if (hardMs is { } hard)
            options.HardLimits = new ExecutionLimits { TimeoutMs = hard };
        return XriptRuntime.Create(HostManifest(manifestMs, hookMs), options);
    }

    [Fact]
    public void A_Hook_Tightens_Its_Fire_Below_The_Manifest_Budget()
    {
        using var rt = MakeRuntime(10_000, 50);
        rt.Execute(Spinner(3000));
        var error = Assert.Throws<ExecutionLimitException>(() => rt.FireHook("bounded"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void A_Hook_Widens_Its_Fire_Past_The_Manifest_Budget()
    {
        using var rt = MakeRuntime(50, 10_000);
        rt.Execute(Spinner(300));
        var results = rt.FireHook("bounded");
        Assert.Equal("finished", Assert.Single(results).GetString());
    }

    [Fact]
    public void A_Hook_Without_Limits_Fires_Under_The_Manifest_Budget_Not_The_Widest_Slot()
    {
        using var rt = MakeRuntime(50, 10_000);
        rt.Execute(Spinner(300));
        var error = Assert.Throws<ExecutionLimitException>(() => rt.FireHook("inherited"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void An_Event_Slot_Fires_Under_Its_Own_Budget()
    {
        using (var wide = MakeRuntime(50, 10_000))
        {
            wide.Execute(Spinner(300));
            Assert.Equal("finished", Assert.Single(wide.FireHook("on-bounded")).GetString());
        }

        using var tight = MakeRuntime(10_000, 50);
        tight.Execute(Spinner(3000));
        var error = Assert.Throws<ExecutionLimitException>(() => tight.FireHook("on-bounded"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void The_Hard_Limit_Clamps_A_Widening_Hook()
    {
        using var rt = MakeRuntime(50, 10_000, hardMs: 100);
        rt.Execute(Spinner(3000));
        var error = Assert.Throws<ExecutionLimitException>(() => rt.FireHook("bounded"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void The_Budget_Is_Fresh_Per_Fire()
    {
        using var rt = MakeRuntime(10_000, 400);
        rt.Execute(Spinner(250));
        for (var i = 0; i < 3; i++)
            Assert.Equal("finished", Assert.Single(rt.FireHook("bounded")).GetString());
    }

    [Fact]
    public void An_Emit_Fires_Under_The_Manifest_Budget_Not_The_Widest_Slot()
    {
        const string manifest = """
            {
                "xript": "0.10",
                "name": "emit-limits-host",
                "limits": { "timeout_ms": 50 },
                "events": [{ "id": "spun", "description": "a host event" }],
                "slots": [{ "id": "wide.commands", "accepts": ["application/x-xript-command"], "description": "far more time", "limits": { "timeout_ms": 60000 } }]
            }
            """;
        using var rt = XriptRuntime.Create(manifest, new RuntimeOptions { Capabilities = [] });
        rt.Execute("events.on('spun', function () { var end = Date.now() + 300; while (Date.now() < end) {} return 'finished'; })");
        var error = Assert.Throws<ExecutionLimitException>(() => rt.Emit("spun"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void A_Fire_Nested_In_A_Script_Leaves_The_Outer_Budget_In_Force()
    {
        var bindings = new HostBindings();
        XriptRuntime? runtime = null;
        bindings.AddFunction("fireBounded", _ =>
        {
            runtime!.FireHook("bounded");
            return JsonDocument.Parse("null").RootElement;
        });
        using var rt = XriptRuntime.Create(
            """
            {
                "xript": "0.10", "name": "nested-host",
                "limits": { "timeout_ms": 100 },
                "bindings": { "fireBounded": { "description": "fires the hook from inside a call" } },
                "hooks": { "bounded": { "description": "a wide hook", "limits": { "timeout_ms": 10000 } } }
            }
            """,
            new RuntimeOptions { Capabilities = [], HostBindings = bindings });
        runtime = rt;
        rt.Execute("hooks.bounded(function () { return 'quick'; })");
        var error = Assert.Throws<ExecutionLimitException>(() =>
            rt.Execute("fireBounded(); var end = Date.now() + 3000; while (Date.now() < end) {}"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void An_Event_Slots_Fills_Run_Under_Its_Budget()
    {
        const string filler = """
            {
                "xript": "0.10", "name": "filler", "version": "1.0.0",
                "entry": { "script": "mod.js", "exports": { "spin": { "description": "spins" } } },
                "fills": { "on-bounded": [{ "handler": "spin" }] }
            }
            """;
        using var rt = MakeRuntime(50, 10_000);
        rt.LoadMod(filler, new Dictionary<string, string>
        {
            ["mod.js"] = "xript.exports.register('spin', function () { var end = Date.now() + 300; while (Date.now() < end) {} return 'filled'; });",
        });
        Assert.Equal("filled", Assert.Single(rt.FireHook("on-bounded")).GetString());
    }
}
