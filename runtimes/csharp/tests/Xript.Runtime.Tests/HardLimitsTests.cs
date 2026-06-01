using Xript.Runtime;

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

    [Fact]
    public void Hard_Timeout_Clamps_Manifest_Request()
    {
        using var rt = XriptRuntime.Create(ManifestWithLongTimeout, new RuntimeOptions
        {
            HardLimits = new ExecutionLimits { TimeoutMs = 150 }
        });

        var ex = Assert.Throws<ExecutionLimitException>(() => rt.Execute("while (true) {}"));
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
        using var rt = XriptRuntime.Create("""
            { "xript": "0.1", "name": "test" }
            """, new RuntimeOptions
        {
            HardLimits = new ExecutionLimits { TimeoutMs = 150 }
        });

        var ex = Assert.Throws<ExecutionLimitException>(() => rt.Execute("while (true) {}"));
        Assert.Equal("timeout_ms", ex.Limit);
    }
}
