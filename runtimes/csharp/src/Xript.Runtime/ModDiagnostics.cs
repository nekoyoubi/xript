using System.Text.Json;

namespace Xript.Runtime;

/// <summary>
/// What <see cref="XriptRuntime.LoadMod"/> does when a mod's entry cannot run: a script the
/// host did not supply, or one that throws while evaluating.
/// </summary>
public enum EntryErrorPolicy
{
    /// <summary><c>LoadMod</c> throws and the mod is not registered. The default.</summary>
    Throw,

    /// <summary>
    /// The failure is recorded on <see cref="ModInstance.Diagnostics"/> and sent to
    /// <see cref="RuntimeOptions.OnModDiagnostic"/>, and the mod is registered without whatever
    /// its entry did not run. For a host that would rather boot with one broken mod than not
    /// boot at all.
    /// </summary>
    Report,
}

/// <summary>The codes a load-time mod diagnostic carries. Held to <c>spec/mod-load-tests.json</c>.</summary>
public static class ModDiagnosticCodes
{
    /// <summary><c>entry</c> names a script the host did not supply.</summary>
    public const string MissingEntryScript = "missing-entry-script";

    /// <summary>Evaluating the entry failed.</summary>
    public const string EntryFailed = "entry-failed";

    /// <summary>
    /// A fragment's <c>source</c> is markup but <c>inline</c> is not true, so it was looked up as
    /// a file name and found nothing.
    /// </summary>
    public const string MarkupSourceNotInline = "markup-source-not-inline";

    /// <summary>A fragment's <c>source</c> names a file the host did not supply.</summary>
    public const string MissingFragmentSource = "missing-fragment-source";

    /// <summary>A fragment declares handlers under the deprecated <c>events</c> key. Reported once per mod.</summary>
    public const string DeprecatedEventsAlias = "deprecated-events-alias";
}

public enum ModDiagnosticSeverity
{
    /// <summary>An entry that did not run.</summary>
    Error,

    /// <summary>A mod that loaded, but likely not as its author meant.</summary>
    Warning,
}

/// <summary>A finding about a mod raised while loading it.</summary>
public sealed record ModDiagnostic(string Code, ModDiagnosticSeverity Severity, string Mod, string Message)
{
    /// <summary>The entry script, for entry diagnostics.</summary>
    public string? Script { get; init; }

    /// <summary>The fragment fill, for fragment diagnostics.</summary>
    public string? FragmentId { get; init; }

    /// <summary>The fill field the finding is about, e.g. <c>source</c> or <c>events</c>.</summary>
    public string? Field { get; init; }
}

public static class ModDiagnostics
{
    /// <summary>
    /// True when a fragment <c>source</c> reads as content rather than a file name: markup that
    /// opens with a tag, or a JSON document (a JSML tree is a JSON array).
    /// </summary>
    public static bool LooksLikeMarkup(string source)
    {
        var trimmed = source.Trim();
        if (trimmed.StartsWith('<')) return true;
        if (!trimmed.StartsWith('[') && !trimmed.StartsWith('{')) return false;
        try
        {
            using var _ = JsonDocument.Parse(trimmed);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// The load-time findings a mod's fragment declarations raise against the sources the host
    /// supplied, in declaration order: a non-inline <c>source</c> that resolves to nothing, and
    /// the deprecated <c>events</c> alias, once per mod.
    /// </summary>
    public static List<ModDiagnostic> ForFragments(
        string modName,
        IReadOnlyList<FragmentDeclaration> fragments,
        IReadOnlyDictionary<string, string>? sources)
    {
        var diagnostics = new List<ModDiagnostic>();
        var reportedEventsAlias = false;

        foreach (var fragment in fragments)
        {
            if (fragment.Inline != true && sources?.ContainsKey(fragment.Source) != true)
            {
                diagnostics.Add(LooksLikeMarkup(fragment.Source)
                    ? new ModDiagnostic(
                        ModDiagnosticCodes.MarkupSourceNotInline,
                        ModDiagnosticSeverity.Warning,
                        modName,
                        $"fragment \"{fragment.Id}\" of mod \"{modName}\" carries markup in \"source\" without \"inline\": true, so it was looked up as a file name, found nothing, and mounts empty; set \"inline\": true")
                    { FragmentId = fragment.Id, Field = "source" }
                    : new ModDiagnostic(
                        ModDiagnosticCodes.MissingFragmentSource,
                        ModDiagnosticSeverity.Warning,
                        modName,
                        $"fragment \"{fragment.Id}\" of mod \"{modName}\" names source \"{fragment.Source}\", which was not supplied in fragmentSources, so it mounts empty")
                    { FragmentId = fragment.Id, Field = "source" });
            }

            if (!reportedEventsAlias && fragment.Events is not null)
            {
                reportedEventsAlias = true;
                diagnostics.Add(new ModDiagnostic(
                    ModDiagnosticCodes.DeprecatedEventsAlias,
                    ModDiagnosticSeverity.Warning,
                    modName,
                    $"mod \"{modName}\" declares fragment handlers under the deprecated \"events\" key (first on fragment \"{fragment.Id}\"); rename it to \"handlers\"")
                { FragmentId = fragment.Id, Field = "events" });
            }
        }

        return diagnostics;
    }
}

/// <summary>
/// What a mod's <c>entry</c> means. A bare string names one script; an array names several,
/// evaluated in order; the object form <c>{ script, format, exports }</c> names one and may
/// declare exports and the <c>module</c> format. Every named script is looked up in the
/// fragment sources passed to <see cref="XriptRuntime.LoadMod"/>; a name with no source there
/// is a <see cref="MissingEntryScriptException"/>.
/// </summary>
public static class ModEntry
{
    /// <summary>The script names the entry asks the host to supply, in evaluation order.</summary>
    public static List<string> Scripts(JsonElement? entry)
    {
        var paths = new List<string>();
        if (entry is not { } value) return paths;

        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                paths.Add(value.GetString()!);
                break;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray())
                    if (item.ValueKind == JsonValueKind.String)
                        paths.Add(item.GetString()!);
                break;
            case JsonValueKind.Object:
                if (value.TryGetProperty("script", out var script) && script.ValueKind == JsonValueKind.String)
                    paths.Add(script.GetString()!);
                break;
        }

        return paths;
    }

    /// <summary>
    /// How the entry is evaluated: <c>"module"</c> only when the object form says
    /// <c>format: "module"</c>, <c>"script"</c> for every other form.
    /// </summary>
    public static string Format(JsonElement? entry) =>
        entry is { ValueKind: JsonValueKind.Object } value
            && value.TryGetProperty("format", out var format)
            && format.ValueKind == JsonValueKind.String
            && format.GetString() == "module"
            ? "module"
            : "script";

    /// <summary>
    /// The exports the entry declares, keyed by export name. Only the object form declares
    /// exports; a bare string or array declares none.
    /// </summary>
    public static Dictionary<string, JsonElement> Exports(JsonElement? entry)
    {
        var exports = new Dictionary<string, JsonElement>();
        if (entry is { ValueKind: JsonValueKind.Object } value
            && value.TryGetProperty("exports", out var declared)
            && declared.ValueKind == JsonValueKind.Object)
        {
            foreach (var export in declared.EnumerateObject())
                exports[export.Name] = export.Value;
        }
        return exports;
    }
}
