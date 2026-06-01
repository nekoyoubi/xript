namespace Xript.Runtime;

public class ModEntryException : Exception
{
    public string ModName { get; }

    public ModEntryException(string modName, string message)
        : base(message)
    {
        ModName = modName;
    }
}
