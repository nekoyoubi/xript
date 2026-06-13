using System.Text.RegularExpressions;

namespace Xript.Runtime;

/// <summary>
/// Conservative regex scan for static and dynamic import specifiers in module
/// source, mirroring the detector posture of <see cref="CommonJsDetector"/>:
/// false positives inside strings or comments are accepted, because the module
/// loader's default-deny backstops every miss.
/// </summary>
internal static partial class ImportScanner
{
    [GeneratedRegex(@"(?:^|[\n;])\s*import\b[^;'""`]*?from\s*[""']([^""']+)[""']")]
    private static partial Regex StaticImport();

    [GeneratedRegex(@"(?:^|[\n;])\s*import\s*[""']([^""']+)[""']")]
    private static partial Regex BareSideEffectImport();

    [GeneratedRegex(@"(?:^|[\n;])\s*export\b[^;'""`]*?from\s*[""']([^""']+)[""']")]
    private static partial Regex ExportFrom();

    [GeneratedRegex(@"\bimport\s*\(\s*[""']([^""']+)[""']")]
    private static partial Regex DynamicImport();

    internal readonly record struct FoundImport(string Specifier, bool Dynamic);

    internal static List<FoundImport> FindAll(string source)
    {
        var found = new List<FoundImport>();
        foreach (Match match in StaticImport().Matches(source))
            found.Add(new FoundImport(match.Groups[1].Value, false));
        foreach (Match match in BareSideEffectImport().Matches(source))
            found.Add(new FoundImport(match.Groups[1].Value, false));
        foreach (Match match in ExportFrom().Matches(source))
            found.Add(new FoundImport(match.Groups[1].Value, false));
        foreach (Match match in DynamicImport().Matches(source))
            found.Add(new FoundImport(match.Groups[1].Value, true));
        return found;
    }

    internal static string? FirstSpecifier(string source)
    {
        var found = FindAll(source);
        return found.Count > 0 ? found[0].Specifier : null;
    }
}
