namespace Xript.Runtime;

/// <summary>
/// Thrown when a bare export name is invoked but more than one loaded mod owns
/// that name. Mods each get their own export namespace, so the runtime refuses
/// to guess: call <c>InvokeModExport(mod, name, args)</c> to name the owner.
/// </summary>
public class AmbiguousExportException : Exception
{
    public string Export { get; }

    public IReadOnlyList<string> Mods { get; }

    public AmbiguousExportException(string export, IReadOnlyList<string> mods)
        : base($"export '{export}' is provided by more than one mod ({string.Join(", ", mods.Select(m => $"'{m}'"))}); "
            + $"call InvokeModExport(mod, \"{export}\", args) to name the owner")
    {
        Export = export;
        Mods = mods;
    }
}
