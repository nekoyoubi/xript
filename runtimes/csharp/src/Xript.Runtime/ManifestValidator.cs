namespace Xript.Runtime;

internal static class ManifestValidator
{
    internal static void Validate(Manifest manifest)
    {
        var issues = new List<ValidationIssue>();

        if (string.IsNullOrEmpty(manifest.Xript))
            issues.Add(new("/xript", "required field 'xript' must be a non-empty string"));

        if (string.IsNullOrEmpty(manifest.Name))
            issues.Add(new("/name", "required field 'name' must be a non-empty string"));

        if (manifest.Limits is { } limits)
        {
            if (limits.TimeoutMs is <= 0)
                issues.Add(new("/limits/timeout_ms", "'timeout_ms' must be a positive number"));

            if (limits.MemoryMb is <= 0)
                issues.Add(new("/limits/memory_mb", "'memory_mb' must be a positive number"));

            if (limits.MaxStackDepth is <= 0)
                issues.Add(new("/limits/max_stack_depth", "'max_stack_depth' must be a positive number"));
        }

        if (issues.Count > 0)
            throw new ManifestValidationException(issues);
    }
}
