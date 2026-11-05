using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class HardLimitsTests
{
    private const string ManifestWithLongTimeout = """
        {
            "xript": "0.1",
            "name": "test",
            "limits": { "timeout_ms": 60000 }
        }
        """;

    private const string ManifestWithDeepStack = """
        {
            "xript": "0.1",
            "name": "test",
            "limits": { "max_stack_depth": 10000 }
        }
        """;

    /// <summary>A runtime whose budgets run on a <see cref="TestClock"/> that a script advances through <c>elapse</c>.</summary>
    private static XriptRuntime OnTestClock(string manifestLimits, long hardTimeoutMs)
    {
        var clock = new TestClock();
        var bindings = new HostBindings();
        bindings.AddFunction("elapse", clock.ElapseBinding);
        return XriptRuntime.Create(
            $$"""{ "xript": "0.10", "name": "test", {{manifestLimits}} "bindings": { {{TestClock.ElapseDeclaration}} } }""",
            clock.Drive(new RuntimeOptions { HostBindings = bindings, HardLimits = new ExecutionLimits { TimeoutMs = hardTimeoutMs } }));
    }

    [Fact]
    public void Hard_Timeout_Clamps_Manifest_Request()
    {
        using var rt = OnTestClock("\"limits\": { \"timeout_ms\": 60000 },", hardTimeoutMs: 150);

        Assert.Equal("fits", rt.Execute("elapse(100); 'fits'").Value.GetString());
        var ex = Assert.Throws<ExecutionLimitException>(() => rt.Execute("elapse(200); 'outlived'"));
        Assert.Equal("timeout_ms", ex.Limit);
    }

    [Fact]
    public void Hard_Stack_Depth_Clamps_Manifest_Request()
    {
        using var rt = XriptRuntime.Create(ManifestWithDeepStack, new RuntimeOptions
        {
            HardLimits = new ExecutionLimits { MaxStackDepth = 10 }
        });

        var ex = Assert.Throws<ExecutionLimitException>(() =>
            rt.Execute("function recurse(n) { return recurse(n + 1); } recurse(0)"));
        Assert.Equal("max_stack_depth", ex.Limit);
    }

    [Fact]
    public void Manifest_Under_Hard_Cap_Is_Honored()
    {
        using var rt = XriptRuntime.Create(ManifestWithLongTimeout, new RuntimeOptions
        {
            HardLimits = new ExecutionLimits { TimeoutMs = 60000 }
        });

        var result = rt.Execute("1 + 1");
        Assert.Equal(2, result.Value.GetInt64());
    }

    [Fact]
    public void Hard_Cap_Applies_When_Manifest_Has_No_Limit()
    {
        using var rt = OnTestClock("", hardTimeoutMs: 150);

        Assert.Equal("fits", rt.Execute("elapse(100); 'fits'").Value.GetString());
        var ex = Assert.Throws<ExecutionLimitException>(() => rt.Execute("elapse(200); 'outlived'"));
        Assert.Equal("timeout_ms", ex.Limit);
    }
}
