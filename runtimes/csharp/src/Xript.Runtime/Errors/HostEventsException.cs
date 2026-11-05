namespace Xript.Runtime;

/// <summary>
/// Raised under <see cref="RuntimeOptions.HostEvents"/> when the runtime cannot honour host
/// events mode: at construction when the manifest declares no top-level <c>events</c> binding,
/// and on a host call into the built-in bus's API, which serves no script once the host's own
/// binding is <c>events</c>.
/// </summary>
public class HostEventsException : Exception
{
    public HostEventsException(string message) : base(message) { }

    internal static HostEventsException Refused(string api) =>
        new($"`{api}` is not available in host events mode: the host's own `events` binding is the bus mods see, so the built-in bus has no subscribers to reach");
}
