using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

/// <summary>
/// A hook fire or an emit reports a failure of the dispatch itself instead of answering an
/// empty result; a handler that throws is still swallowed to null. Budgets run on a
/// <see cref="TestClock"/>, and a runaway handler spends time through <c>elapse</c>.
/// </summary>
public class FireErrorTests
{
    private static readonly string Manifest = $$"""
        { "xript": "0.10", "name": "fire-probe", "limits": { "timeout_ms": 100 },
          "bindings": { {{TestClock.ElapseDeclaration}} },
          "hooks": { "spin": { "description": "Runs its handlers." } },
          "events": [{ "id": "spin", "description": "Runs its handlers." }] }
        """;

    private static XriptRuntime Create()
    {
        var clock = new TestClock();
        var bindings = new HostBindings();
        bindings.AddFunction("elapse", clock.ElapseBinding);
        return XriptRuntime.Create(Manifest, clock.Drive(new RuntimeOptions { HostBindings = bindings }));
    }

    [Fact]
    public void A_Runaway_Hook_Handler_Surfaces_The_Execution_Limit()
    {
        using var rt = Create();
        rt.Execute("hooks.spin(function () { while (true) { elapse(10); } });");
        var error = Assert.Throws<ExecutionLimitException>(() => rt.FireHook("spin"));
        Assert.Equal("timeout_ms", error.Limit);
        Assert.Equal(2, rt.Execute("1 + 1").Value.GetInt32());
    }

    [Fact]
    public void A_Runaway_Event_Handler_Surfaces_The_Execution_Limit()
    {
        using var rt = Create();
        rt.Execute("events.on('spin', function () { while (true) { elapse(10); } });");
        var error = Assert.Throws<ExecutionLimitException>(() => rt.Emit("spin"));
        Assert.Equal("timeout_ms", error.Limit);
        Assert.Equal(2, rt.Execute("1 + 1").Value.GetInt32());
    }

    [Fact]
    public void A_Throwing_Handler_Is_Still_Swallowed()
    {
        using var rt = Create();
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
