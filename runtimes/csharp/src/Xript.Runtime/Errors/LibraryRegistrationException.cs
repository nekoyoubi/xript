namespace Xript.Runtime;

public class LibraryRegistrationException : Exception
{
    public string Specifier { get; }

    public LibraryRegistrationException(string specifier, string reason)
        : base($"library \"{specifier}\" failed registration: {reason}")
    {
        Specifier = specifier;
    }
}
