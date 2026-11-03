using System.Diagnostics;
using Jint;

namespace Xript.Runtime;

/// <summary>
/// Enforces the current call's deadline inline, on the engine's own constraint checks, by
/// reading the clock. A <see cref="CancellationTokenSource.CancelAfter(TimeSpan)"/> timer needs
/// a free thread-pool thread to fire, so on a busy pool a runaway script could outlive its
/// budget by seconds; this check needs no other thread. When the deadline passes it cancels the
/// call's budget source, and the engine's cancellation constraint stops the script.
/// </summary>
internal sealed class CallDeadlineConstraint : Constraint
{
    private long _deadline = long.MaxValue;
    private CancellationTokenSource? _source;

    /// <summary>
    /// Installs a deadline <paramref name="timeoutMs"/> from now for <paramref name="source"/>,
    /// never later than the deadline already in force, and returns the previous one so the
    /// caller can restore it.
    /// </summary>
    internal (long Deadline, CancellationTokenSource? Source) Enter(long timeoutMs, CancellationTokenSource source)
    {
        var previous = (_deadline, _source);
        var ticks = timeoutMs >= long.MaxValue / Stopwatch.Frequency
            ? long.MaxValue
            : Stopwatch.GetTimestamp() + timeoutMs * Stopwatch.Frequency / 1000;
        _deadline = Math.Min(previous._deadline, ticks);
        _source = source;
        return previous;
    }

    internal void Restore((long Deadline, CancellationTokenSource? Source) previous)
    {
        _deadline = previous.Deadline;
        _source = previous.Source;
    }

    public override void Check()
    {
        var source = _source;
        if (source is null || Stopwatch.GetTimestamp() < _deadline || source.IsCancellationRequested)
            return;
        try
        {
            source.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
    }

    public override void Reset()
    {
    }
}
