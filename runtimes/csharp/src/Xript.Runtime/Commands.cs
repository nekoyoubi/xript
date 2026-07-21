using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Xript.Runtime;

/// <summary>
/// A normalized fill of a slot accepting <c>application/x-xript-command</c>: a named,
/// invocable action backed by one of the declaring mod's exports. <see cref="Mod"/> is the
/// first half of export identity, so a command always addresses its own mod's namespace.
/// </summary>
/// <remarks>
/// A command fill carries no <c>capability</c> of its own. Authority is the slot's
/// contribution gate plus the export gate on <c>entry.exports[handler].capability</c>.
/// </remarks>
public record CommandFill(string Mod, string Slot, string Id, string Handler)
{
    /// <summary>The address a host invokes: <c>${mod}:${id}</c>.</summary>
    public string QualifiedId => $"{Mod}:{Id}";

    /// <summary>Human label, defaulting to <see cref="Id"/>.</summary>
    public string Title { get; init; } = "";

    public string? Description { get; init; }

    public string? Icon { get; init; }

    public string? Group { get; init; }

    public IReadOnlyList<string> Keywords { get; init; } = [];

    /// <summary>Bound arguments, merged under the caller's at invoke time.</summary>
    public JsonObject Args { get; init; } = new();

    /// <summary>JSON Schema over the effective argument object. Absent means open.</summary>
    public JsonNode? Input { get; init; }

    /// <summary>JSON Schema over the return value. Absent means open.</summary>
    public JsonNode? Output { get; init; }

    public int Priority { get; init; }

    /// <summary>Discoverability hint. Never an authority gate — a hidden command still runs.</summary>
    public bool Exposed { get; init; } = true;
}

/// <summary>
/// A <see cref="CommandFill"/> placed in its slot's resolved order, carrying the two facts
/// only resolution knows: whether its bare id is ambiguous within the slot, and the
/// capability a host should surface before offering it.
/// </summary>
public sealed record ResolvedCommand : CommandFill
{
    public ResolvedCommand(CommandFill fill) : base(fill)
    {
    }

    /// <summary>
    /// Informational only: the handler's export gate when it declares one, otherwise the
    /// slot's contribution gate. Never consulted at invoke — <c>InvokeModExport</c> re-checks
    /// the export gate against the live grant set.
    /// </summary>
    public string? Capability { get; init; }

    /// <summary>Every gate the command sits behind, slot gate first and export gate second.</summary>
    public IReadOnlyList<string> Capabilities { get; init; } = [];

    /// <summary>Whether another mod contributes the same bare <see cref="CommandFill.Id"/> to this slot.</summary>
    public bool Collides { get; init; }
}

/// <summary>
/// Command-fill normalization, argument merging, and the resolution order shared with the
/// fragment slot resolver: priority descending, fill id ascending, owning mod ascending.
/// </summary>
public static class Commands
{
    public const string SlotAccept = Slot.CommandAccept;

    internal static readonly Regex IdPattern =
        new("^[a-z][a-z0-9.-]*$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Merges bound arguments under call-time arguments. Shallow and top-level only:
    /// a key present in both is taken from the caller, and that is never an error.
    /// </summary>
    public static JsonObject MergeArgs(JsonObject? bound, JsonObject? callArgs)
    {
        var merged = new JsonObject();
        if (bound is not null)
            foreach (var (key, value) in bound)
                merged[key] = value?.DeepClone();
        if (callArgs is not null)
            foreach (var (key, value) in callArgs)
                merged[key] = value?.DeepClone();
        return merged;
    }

    internal static IOrderedEnumerable<T> Order<T>(IEnumerable<T> commands) where T : CommandFill =>
        commands
            .OrderByDescending(command => command.Priority)
            .ThenBy(command => command.Id, StringComparer.Ordinal)
            .ThenBy(command => command.Mod, StringComparer.Ordinal);

    /// <summary>
    /// Reads one command fill, appending a coded <see cref="ValidationIssue"/> and returning
    /// null when the fill is malformed.
    /// </summary>
    internal static CommandFill? Parse(
        JsonObject fill,
        string modName,
        string slotId,
        string prefix,
        HashSet<string> seenIds,
        List<ValidationIssue> issues)
    {
        var id = ReadString(fill, "id");
        var handler = ReadString(fill, "handler");

        if (fill.ContainsKey("capability"))
        {
            var target = handler is null ? "the export it names" : $"entry.exports.{handler}.capability";
            issues.Add(new ValidationIssue(
                $"{prefix}/capability",
                $"command '{id ?? slotId}' declares a 'capability'; per-action authority lives on the export it names — move it to {target}",
                "command-fill-capability"));
            return null;
        }

        if (string.IsNullOrEmpty(handler))
        {
            issues.Add(new ValidationIssue(
                $"{prefix}/handler",
                "a command fill must name a 'handler' export",
                "command-missing-handler"));
            return null;
        }

        if (id is null || !IdPattern.IsMatch(id))
        {
            issues.Add(new ValidationIssue(
                $"{prefix}/id",
                "a command fill must carry an 'id' matching ^[a-z][a-z0-9.-]*$",
                "command-invalid-id"));
            return null;
        }

        if (!seenIds.Add(id))
        {
            issues.Add(new ValidationIssue(
                $"{prefix}/id",
                $"command id '{id}' is declared twice in slot '{slotId}'",
                "command-duplicate-id"));
            return null;
        }

        var args = new JsonObject();
        if (fill.ContainsKey("args"))
        {
            if (fill["args"] is not JsonObject bound)
            {
                issues.Add(new ValidationIssue(
                    $"{prefix}/args",
                    "bound 'args' must be an object of argument values",
                    "command-args-not-object"));
                return null;
            }
            foreach (var (key, value) in bound)
                args[key] = value?.DeepClone();
        }

        var input = fill["input"];
        var unbound = UnboundArgs(args, input);
        if (unbound.Count > 0)
        {
            foreach (var key in unbound)
                issues.Add(new ValidationIssue(
                    $"{prefix}/args/{key}",
                    $"bound argument '{key}' is not declared in this command's 'input'",
                    "command-unbound-arg"));
            return null;
        }

        return new CommandFill(modName, slotId, id, handler)
        {
            Title = ReadString(fill, "title") ?? id,
            Description = ReadString(fill, "description"),
            Icon = ReadString(fill, "icon"),
            Group = ReadString(fill, "group"),
            Keywords = ReadKeywords(fill),
            Args = args,
            Input = input?.DeepClone(),
            Output = fill["output"]?.DeepClone(),
            Priority = ReadInt(fill, "priority") ?? 0,
            Exposed = ReadBool(fill, "exposed") ?? true,
        };
    }

    /// <summary>
    /// The bound keys a closed <c>input</c> does not declare. An <c>input</c> that omits
    /// <c>additionalProperties: false</c> is open, so nothing is unbound against it.
    /// </summary>
    private static List<string> UnboundArgs(JsonObject args, JsonNode? input)
    {
        if (args.Count == 0 || input is not JsonObject schema) return [];
        if (ReadBool(schema, "additionalProperties") is not false) return [];
        var declared = schema["properties"] as JsonObject;
        return [.. args.Select(pair => pair.Key).Where(key => declared is null || !declared.ContainsKey(key))];
    }

    private static string? ReadString(JsonObject fill, string key) =>
        fill[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static int? ReadInt(JsonObject fill, string key)
    {
        if (fill[key] is not JsonValue value) return null;
        if (value.TryGetValue<int>(out var whole)) return whole;
        return value.TryGetValue<double>(out var number) ? (int)number : null;
    }

    private static bool? ReadBool(JsonObject fill, string key) =>
        fill[key] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;

    private static IReadOnlyList<string> ReadKeywords(JsonObject fill)
    {
        if (fill["keywords"] is not JsonArray keywords) return [];
        return [.. keywords
            .OfType<JsonValue>()
            .Select(value => value.TryGetValue<string>(out var text) ? text : null)
            .OfType<string>()];
    }
}
