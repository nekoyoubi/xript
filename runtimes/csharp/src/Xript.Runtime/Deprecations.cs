namespace Xript.Runtime;

/// <summary>
/// One deprecation notice: a stable <see cref="Code"/>, a <see cref="Message"/> saying what
/// happened, and a <see cref="Replacement"/> saying what to do instead. The codes are listed
/// in <c>spec/deprecations.md</c>.
/// </summary>
public sealed record Deprecation(string Code, string Message, string Replacement);

/// <summary>
/// Raises each deprecation code at most once per runtime: to the host's
/// <see cref="RuntimeOptions.OnDeprecation"/> when one is set, otherwise as a single line on
/// <see cref="Console.Error"/>. A throwing handler is contained, so a notice never changes
/// what the runtime does.
/// </summary>
internal sealed class DeprecationChannel
{
    private readonly Action<Deprecation>? _handler;
    private readonly HashSet<string> _raised = [];
    private readonly object _gate = new();

    internal DeprecationChannel(Action<Deprecation>? handler) => _handler = handler;

    internal void Raise(string code, string message, string replacement)
    {
        lock (_gate)
        {
            if (!_raised.Add(code)) return;
        }

        var notice = new Deprecation(code, message, replacement);
        if (_handler is null)
        {
            Console.Error.WriteLine($"xript: {message} ({code}). {replacement}");
            return;
        }

        try
        {
            _handler(notice);
        }
        catch
        {
            // a throwing handler never changes whether or how the runtime runs
        }
    }
}
