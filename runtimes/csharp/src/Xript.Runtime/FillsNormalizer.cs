using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xript.Runtime;

/// <summary>
/// An event/hook-slot fill resolved from a mod's <c>fills</c>: when the host
/// fires the named hook, the runtime also invokes the mod export the fill names.
/// </summary>
public sealed record HookFillDecl(string Hook, string Handler);

/// <summary>
/// Resolves a mod's canonical <c>fills</c> surface into the runtime's internal
/// contribution model, typed by each target slot's <c>accepts</c>: a
/// fragment-format fill becomes a fragment declaration, a role fill becomes a
/// provider role, an event/hook fill becomes an export-backed hook handler. A
/// mod that mixes <c>fills</c> with the deprecated
/// <c>fragments</c>/<c>contributions</c> surfaces is rejected rather than
/// silently double-contributing.
/// </summary>
internal static class FillsNormalizer
{
    private const string RoleSlotAccept = "application/x-xript-role";

    internal static (string NormalizedJson, List<HookFillDecl> HookFills) Normalize(
        string modManifestJson,
        IReadOnlyList<Slot> slots,
        HashSet<string> granted)
    {
        var root = JsonNode.Parse(modManifestJson);
        if (root is not JsonObject obj || !obj.ContainsKey("fills"))
            return (modManifestJson, []);

        if (obj.ContainsKey("fragments") || obj.ContainsKey("contributions"))
            throw new ModManifestValidationException([
                new ValidationIssue("/fills", "a mod contributes through 'fills' alone — remove the deprecated 'fragments'/'contributions' surfaces instead of mixing the two"),
            ]);

        var fillsNode = obj["fills"];
        obj.Remove("fills");
        if (fillsNode is not JsonObject fillMap)
            throw new ModManifestValidationException([
                new ValidationIssue("/fills", "'fills' must be an object keyed by host slot id"),
            ]);

        var issues = new List<ValidationIssue>();
        var fragments = new JsonArray();
        var provides = new JsonArray();
        var hookFills = new List<HookFillDecl>();

        foreach (var (slotId, entriesNode) in fillMap.ToList())
        {
            if (entriesNode is not JsonArray entries)
            {
                issues.Add(new ValidationIssue($"/fills/{slotId}", "fill entries must be an array"));
                continue;
            }
            var slot = slots.FirstOrDefault(s => s.Id == slotId);
            if (slot is null)
            {
                issues.Add(new ValidationIssue($"/fills/{slotId}", $"slot '{slotId}' does not exist in the app manifest"));
                continue;
            }
            for (var index = 0; index < entries.Count; index++)
            {
                var prefix = $"/fills/{slotId}/{index}";
                if (entries[index] is not JsonObject fill)
                {
                    issues.Add(new ValidationIssue(prefix, "a fill must be an object"));
                    continue;
                }
                var gateDenied = slot.Capability is { } cap && !Capabilities.GrantedSatisfies(granted, cap);
                if (slot.Accepts.Contains(RoleSlotAccept))
                {
                    if (fill["fns"] is not JsonObject fns)
                    {
                        issues.Add(new ValidationIssue($"{prefix}/fns", "a role fill must map logical fn names to exports via 'fns'"));
                        continue;
                    }
                    if (gateDenied)
                    {
                        issues.Add(new ValidationIssue(prefix, $"slot '{slotId}' requires capability '{slot.Capability}'"));
                        continue;
                    }
                    provides.Add(new JsonObject
                    {
                        ["role"] = slotId,
                        ["fns"] = fns.DeepClone(),
                    });
                }
                else if (slot.IsHookSlot())
                {
                    var handler = fill["handler"]?.GetValue<string>();
                    if (string.IsNullOrEmpty(handler))
                    {
                        issues.Add(new ValidationIssue($"{prefix}/handler", "an event/hook fill must name a 'handler' export"));
                        continue;
                    }
                    if (gateDenied)
                    {
                        issues.Add(new ValidationIssue(prefix, $"slot '{slotId}' requires capability '{slot.Capability}'"));
                        continue;
                    }
                    hookFills.Add(new HookFillDecl(slotId, handler));
                }
                else
                {
                    var fragment = new JsonObject { ["id"] = $"{slotId}-fill-{index}" };
                    foreach (var (key, val) in fill.ToList())
                        fragment[key] = val?.DeepClone();
                    fragment["slot"] = slotId;
                    fragments.Add(fragment);
                }
            }
        }

        if (issues.Count > 0)
            throw new ModManifestValidationException(issues);

        if (fragments.Count > 0)
            obj["fragments"] = fragments;
        if (provides.Count > 0)
            obj["contributions"] = new JsonObject { ["provides"] = provides };

        return (obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false }), hookFills);
    }
}
