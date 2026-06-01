namespace Xript.Runtime;

public class ImportDeniedException : Exception
{
    public string Specifier { get; }

    public ImportDeniedException(string specifier)
        : base($"import of \"{specifier}\" is not permitted; xript mods cannot import external modules (see security guarantee: no sandbox escape)")
    {
        Specifier = specifier;
    }
}
