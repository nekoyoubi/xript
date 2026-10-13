using System.Text.Json;

namespace Xript.Runtime;

internal static class ManifestValidator
{
    /// <summary>
    /// Structural checks that run on the raw JSON, before typed deserialization would turn a
    /// wrong shape into a generic <see cref="JsonException"/> that names neither the field nor
    /// the shape it wanted. <c>slots</c> must be an array of <c>{ id, accepts }</c> declarations;
    /// an object keyed by slot id is the likeliest wrong shape. Pinned by
    /// <c>spec/manifest-shape-tests.json</c>.
    /// </summary>
    internal static void CheckRawShape(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("slots", out var slots))
            return;

        var issues = new List<ValidationIssue>();
        if (slots.ValueKind != JsonValueKind.Array)
        {
            issues.Add(new("/slots", "'slots' must be an array of { id, accepts } slot declarations, not an object or other value"));
        }
        else
        {
            var index = 0;
            foreach (var slot in slots.EnumerateArray())
            {
                var wellFormed = slot.ValueKind == JsonValueKind.Object
                    && slot.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                    && slot.TryGetProperty("accepts", out var accepts) && accepts.ValueKind == JsonValueKind.Array
                    && accepts.EnumerateArray().All(entry => entry.ValueKind == JsonValueKind.String);
                if (!wellFormed)
                    issues.Add(new($"/slots/{index}", "each 'slots' entry must be an object { id, accepts } with a string 'id' and an array of strings 'accepts'"));
                index++;
            }
        }

        if (issues.Count > 0)
            throw new ManifestValidationException(issues);
    }

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
