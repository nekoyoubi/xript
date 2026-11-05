using System.Diagnostics;
using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests.Helpers;

/// <summary>
/// A budget clock a test drives, so a limit test passes or fails on the time it declares rather
/// than on how fast the machine runs. Time moves only through <see cref="Elapse"/> (the
/// <see cref="ElapseBinding"/> lets a script spend it) and, when <paramref name="stepMs"/> is set,
/// by that much on every read, which lets a runaway loop exhaust any budget without a binding.
/// </summary>
internal sealed class TestClock(double stepMs = 0)
{
    /// <summary>A manifest binding declaration for <see cref="ElapseBinding"/>.</summary>
    internal const string ElapseDeclaration =
        """ "elapse": { "description": "Advances the test clock by ms milliseconds.", "params": [{ "name": "ms", "type": "number" }] } """;

    private readonly long _step = Ticks(stepMs);
    private long _now;

    internal long Now() => _now += _step;

    internal void Elapse(double ms) => _now += Ticks(ms);

    internal HostFunction ElapseBinding => args =>
    {
        Elapse(args[0].GetDouble());
        return JsonDocument.Parse("null").RootElement.Clone();
    };

    /// <summary>Puts every budget of a runtime built with <paramref name="options"/> on this clock.</summary>
    internal RuntimeOptions Drive(RuntimeOptions options)
    {
        options.DeadlineClock = Now;
        return options;
    }

    private static long Ticks(double ms) => (long)(ms * Stopwatch.Frequency / 1000);
}
