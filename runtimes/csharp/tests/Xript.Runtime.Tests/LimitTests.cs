using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class LimitTests
{
    [Fact]
    public void Enforces_Timeout()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithShortTimeout);

        var ex = Assert.Throws<ExecutionLimitException>(() => rt.Execute("while(true) {}"));
        Assert.Equal("timeout_ms", ex.Limit);
    }

    [Fact]
    public void Enforces_Recursion_Depth()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithLowRecursion);

        var ex = Assert.Throws<ExecutionLimitException>(() =>
            rt.Execute("function recurse(n) { return recurse(n + 1); } recurse(0)"));
        Assert.Equal("max_stack_depth", ex.Limit);
    }

    [Fact]
    public void Enforces_Memory_Limit()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithLowMemory);

        var ex = Assert.Throws<ExecutionLimitException>(() =>
            rt.Execute("var arr = []; while(true) { arr.push(new Array(10000)); }"));
        Assert.Equal("memory_mb", ex.Limit);
    }

    [Fact]
    public void Default_Timeout_Applies()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("1 + 1");
        Assert.Equal(2, result.Value.GetInt64());
    }

    [Fact]
    public void Timeout_Exception_Has_Correct_Message()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithShortTimeout);

        var ex = Assert.Throws<ExecutionLimitException>(() => rt.Execute("while(true) {}"));
        Assert.Contains("execution limit exceeded", ex.Message);
        Assert.Contains("timeout_ms", ex.Message);
    }

    [Fact]
    public void Normal_Script_Within_Limits_Succeeds()
    {
        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.1",
                "name": "test",
                "limits": {
                    "timeout_ms": 5000,
                    "memory_mb": 64,
                    "max_stack_depth": 256
                }
            }
            """);

        var result = rt.Execute("var sum = 0; for(var i = 0; i < 1000; i++) sum += i; sum");
        Assert.Equal(499500, result.Value.GetInt64());
    }
}
