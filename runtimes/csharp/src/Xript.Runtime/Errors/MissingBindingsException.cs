namespace Xript.Runtime;

/// <summary>
/// Raised at runtime construction under <c>StrictBindings</c> when the manifest declares
/// bindings the host did not supply. The manifest is the contract a mod author reads; a
/// binding that is documented and absent is a promise the host has not kept, and this is
/// the host finding out rather than a user hitting it.
/// </summary>
public class MissingBindingsException : Exception
{
    public IReadOnlyList<string> Missing { get; }

    public MissingBindingsException(IReadOnlyList<string> missing)
        : base(
            $"the manifest declares {missing.Count} binding(s) the host did not supply: " +
            $"{string.Join(", ", missing)}. Supply them, remove them from the manifest, or " +
            "construct the runtime without StrictBindings to install them as stubs that throw when called.")
    {
        Missing = missing;
    }
}
