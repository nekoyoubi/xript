using System.Runtime.CompilerServices;

namespace Xript.Runtime.Tests;

/// <summary>
/// xUnit runs test classes in parallel on the thread pool, and several tests spin a script
/// until its budget stops it. On a machine with few cores those spins can hold every pool
/// thread, which delays the <see cref="CancellationTokenSource.CancelAfter(TimeSpan)"/> timers
/// the cancellation tests rely on. Raising the pool's minimum keeps those timers on time.
/// </summary>
internal static class ThreadPoolWarmup
{
    [ModuleInitializer]
    internal static void RaiseMinimumThreads()
    {
        ThreadPool.GetMinThreads(out var worker, out var io);
        ThreadPool.SetMinThreads(Math.Max(worker, 32), Math.Max(io, 32));
    }
}
