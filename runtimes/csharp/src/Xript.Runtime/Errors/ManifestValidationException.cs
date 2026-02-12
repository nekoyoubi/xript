namespace Xript.Runtime;

public record ValidationIssue(string Path, string Message);

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
