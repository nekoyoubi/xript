using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class CancellationTests
{
    [Fact]
    public void Cancel_Before_Execute_Errors_Immediately()
    {
        using var cts = new CancellationTokenSource();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Cancellation = cts.Token
        });

        cts.Cancel();

        Assert.Throws<ExecutionCancelledException>(() => rt.Execute("1 + 1"));
    }

    [Fact]
    public void Cancellation_Is_Sticky()
    {
        using var cts = new CancellationTokenSource();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Cancellation = cts.Token
        });

        var first = rt.Execute("2 + 2");
        Assert.Equal(4, first.Value.GetInt64());

        cts.Cancel();

        Assert.Throws<ExecutionCancelledException>(() => rt.Execute("2 + 2"));
        Assert.Throws<ExecutionCancelledException>(() => rt.Execute("2 + 2"));
    }

    [Fact]
    public void No_Cancellation_Token_Runs_Normally()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("3 + 3");
        Assert.Equal(6, result.Value.GetInt64());
    }

    [Fact]
    public void Cancel_Interrupts_Long_Running_Execution()
    {
        using var cts = new CancellationTokenSource();
        using var rt = XriptRuntime.Create(
            """{ "xript": "0.1", "name": "test", "limits": { "timeout_ms": 600000 } }""",
            new RuntimeOptions { Cancellation = cts.Token });

        // A real host timer is the point of this test, so the budget sits far past any delay a
        // starved thread pool could put on it: only the cancellation can end the loop.
        cts.CancelAfter(TimeSpan.FromMilliseconds(100));

        Assert.Throws<ExecutionCancelledException>(() => rt.Execute("while (true) {}"));
    }
}
