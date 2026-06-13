namespace Xript.Runtime;

public class LibraryUnavailableException : Exception
{
    public string Specifier { get; }

    public LibraryUnavailableException(string specifier)
        : base($"library \"{specifier}\" is declared in the host manifest but no source was registered with the runtime; the host must supply it via the runtime's libraries option")
    {
        Specifier = specifier;
    }
}
