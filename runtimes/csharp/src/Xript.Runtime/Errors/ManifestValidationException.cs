namespace Xript.Runtime;

/// <summary>
/// A single manifest defect. <paramref name="Code"/> is a stable machine-readable id for
/// defects the shared conformance corpora match on; it stays null for issues carrying no
/// corpus identity.
/// </summary>
public record ValidationIssue(string Path, string Message, string? Code = null);

public class ManifestValidationException : Exception
{
    public IReadOnlyList<ValidationIssue> Issues { get; }

    public ManifestValidationException(IReadOnlyList<ValidationIssue> issues)
        : base(FormatMessage(issues))
    {
        Issues = issues;
    }

    private static string FormatMessage(IReadOnlyList<ValidationIssue> issues)
    {
        var lines = issues.Select(i => $"  {i.Path}: {i.Message}");
        return $"invalid xript manifest:\n{string.Join("\n", lines)}";
    }
}
