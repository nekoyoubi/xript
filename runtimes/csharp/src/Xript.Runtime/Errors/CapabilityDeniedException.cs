namespace Xript.Runtime;

public class CapabilityDeniedException : Exception
{
    public string Binding { get; }
    public string Capability { get; }

    public CapabilityDeniedException(string binding, string capability)
        : base($"`{binding}()` requires the \"{capability}\" capability, which hasn't been granted to this script")
    {
        Binding = binding;
        Capability = capability;
    }
}
