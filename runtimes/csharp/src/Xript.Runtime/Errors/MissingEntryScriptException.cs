namespace Xript.Runtime;

/// <summary>
/// A mod's <c>entry</c> names a script the host did not supply. Loading such a mod used to
/// succeed and run nothing, so a typo in a script name looked exactly like a healthy mod with
/// an empty body.
/// </summary>
public class MissingEntryScriptException : ModEntryException
{
    public string Script { get; }

    public MissingEntryScriptException(string modName, string script)
        : base(modName, $"mod \"{modName}\" names entry script \"{script}\", which was not supplied in fragmentSources")
    {
        Script = script;
    }
}
