namespace Xript.Runtime;

internal static class Capabilities
{
    internal static bool Satisfies(string grant, string require)
    {
        var (grantMode, grantScope) = SplitMode(grant);
        var (requireMode, requireScope) = SplitMode(require);

        var modeOk = grantMode == "write" || grantMode == requireMode;
        var scopeOk = grantScope == requireScope
            || requireScope.StartsWith(grantScope + ".", StringComparison.Ordinal);

        return modeOk && scopeOk;
    }

    internal static bool GrantedSatisfies(IEnumerable<string> granted, string require)
    {
        foreach (var grant in granted)
            if (Satisfies(grant, require))
                return true;
        return false;
    }

    private static (string Mode, string Scope) SplitMode(string capability)
    {
        var i = capability.IndexOf(':');
        if (i < 0)
            return ("write", capability);

        var prefix = capability[..i];
        return (prefix, capability[(i + 1)..]);
    }
}
