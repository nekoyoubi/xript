using System.Text.RegularExpressions;

namespace Xript.Runtime;

internal static partial class CommonJsDetector
{
    [GeneratedRegex(@"\brequire\s*\(")]
    private static partial Regex RequireCall();

    [GeneratedRegex(@"\bmodule\s*\.\s*exports\b")]
    private static partial Regex ModuleExports();

    [GeneratedRegex(@"(?<![.\w$])exports\s*(\.\s*[A-Za-z_$][\w$]*|\[)\s*")]
    private static partial Regex ExportsAssignment();

    internal static string? Detect(string source)
    {
        if (RequireCall().IsMatch(source))
            return "require()";
        if (ModuleExports().IsMatch(source))
            return "module.exports";
        if (ExportsAssignment().IsMatch(source))
            return "exports.x";
        return null;
    }
}
