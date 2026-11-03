using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// A hook fire or an emit reports a failure of the dispatch itself instead of answering an
/// empty result; a handler that throws is still swallowed to null.
/// </summary>
public class FireErrorTests
{
    private const string Manifest = """
        { "xript": "0.10", "name": "fire-probe", "limits": { "timeout_ms": 100 },
          "hooks": { "spin": { "description": "Runs its handlers." } },
          "events": [{ "id": "spin", "description": "Runs its handlers." }] }
        """;

    [Fact]
    public void A_Runaway_Hook_Handler_Surfaces_The_Execution_Limit()
    {
        using var rt = XriptRuntime.Create(Manifest, new RuntimeOptions());
        rt.Execute("hooks.spin(function () { while (true) {} });");
        var error = Assert.Throws<ExecutionLimitException>(() => rt.FireHook("spin"));
        Assert.Equal("timeout_ms", error.Limit);
        Assert.Equal(2, rt.Execute("1 + 1").Value.GetInt32());
    }

    [Fact]
    public void A_Runaway_Event_Handler_Surfaces_The_Execution_Limit()
    {
        using var rt = XriptRuntime.Create(Manifest, new RuntimeOptions());
        rt.Execute("events.on('spin', function () { while (true) {} });");
        var error = Assert.Throws<ExecutionLimitException>(() => rt.Emit("spin"));
        Assert.Equal("timeout_ms", error.Limit);
        Assert.Equal(2, rt.Execute("1 + 1").Value.GetInt32());
    }

    [Fact]
    public void A_Throwing_Handler_Is_Still_Swallowed()
    {
        using var rt = XriptRuntime.Create(Manifest, new RuntimeOptions());
        rt.Execute("""
            hooks.spin(function () { throw new Error('boom'); });
            hooks.spin(function () { return 'ok'; });
            events.on('spin', function () { throw new Error('boom'); });
            events.on('spin', function () { return 'ok'; });
            """);
        Assert.Equal(["null", "\"ok\""], rt.FireHook("spin").Select(r => r.GetRawText()));
        Assert.Equal(["null", "\"ok\""], rt.Emit("spin").Select(r => r.GetRawText()));
    }
}
