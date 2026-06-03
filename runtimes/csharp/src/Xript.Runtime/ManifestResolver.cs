using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xript.Runtime;

public static class ManifestResolver
{
    private static readonly string[] MergeMaps = ["bindings", "capabilities", "hooks", "types"];

    public static string Resolve(string manifestJson, string baseDir)
    {
        var node = JsonNode.Parse(manifestJson)
            ?? throw new ManifestValidationException([new("/", "manifest parsed to null")]);

        var resolved = ResolveNode(node.AsObject(), baseDir, new HashSet<string>());
        return resolved.ToJsonString();
    }

    private static JsonObject ResolveNode(JsonObject manifest, string baseDir, HashSet<string> visiting)
    {
        if (!manifest.TryGetPropertyValue("extends", out var extendsNode) || extendsNode is null)
            return manifest;

        var basePaths = ExtractPaths(extendsNode);
        manifest.Remove("extends");

        JsonObject accumulated = new();
        foreach (var relPath in basePaths)
        {
            var resolvedPath = Path.GetFullPath(Path.Combine(baseDir, relPath));

            if (visiting.Contains(resolvedPath))
                throw new ManifestValidationException(
                    [new("/extends", $"circular extends detected at '{relPath}'")]);

            if (!File.Exists(resolvedPath))
                throw new ManifestValidationException(
                    [new("/extends", $"base manifest not found: '{relPath}'")]);

            var baseJson = File.ReadAllText(resolvedPath);
            var baseNode = JsonNode.Parse(baseJson)?.AsObject()
                ?? throw new ManifestValidationException(
                    [new("/extends", $"base manifest '{relPath}' parsed to null")]);

            visiting.Add(resolvedPath);
            var resolvedBase = ResolveNode(baseNode, Path.GetDirectoryName(resolvedPath)!, visiting);
            visiting.Remove(resolvedPath);

            accumulated = Merge(accumulated, resolvedBase);
        }

        return Merge(accumulated, manifest);
    }

    private static List<string> ExtractPaths(JsonNode extendsNode)
    {
        if (extendsNode is JsonArray arr)
        {
            var paths = new List<string>();
            foreach (var item in arr)
            {
                if (item is JsonValue v && v.TryGetValue<string>(out var s))
                    paths.Add(s);
            }
            if (paths.Count == 0)
                throw new ManifestValidationException([new("/extends", "extends array is empty")]);
            return paths;
        }

        if (extendsNode is JsonValue val && val.TryGetValue<string>(out var single))
            return [single];

        throw new ManifestValidationException(
            [new("/extends", "extends must be a string or array of strings")]);
    }

    private static JsonObject Merge(JsonObject baseObj, JsonObject childObj)
    {
        var result = new JsonObject();

        foreach (var (key, value) in baseObj)
            result[key] = value?.DeepClone();

        foreach (var (key, childValue) in childObj)
        {
            if (MergeMaps.Contains(key) && result[key] is JsonObject baseMap && childValue is JsonObject childMap)
            {
                result[key] = MergeMap(key, baseMap, childMap);
            }
            else if (key == "slots" && result[key] is JsonArray baseSlots && childValue is JsonArray childSlots)
            {
                result[key] = MergeSlots(baseSlots, childSlots);
            }
            else
            {
                result[key] = childValue?.DeepClone();
            }
        }

        return result;
    }

    private static JsonObject MergeMap(string mapName, JsonObject baseMap, JsonObject childMap)
    {
        var merged = new JsonObject();
        foreach (var (key, value) in baseMap)
            merged[key] = value?.DeepClone();

        foreach (var (key, value) in childMap)
        {
            if (merged.ContainsKey(key))
            {
                if (mapName == "types")
                {
                    var baseType = baseMap[key];
                    if (IsAbstractType(baseType) && value is JsonObject)
                    {
                        merged[key] = value.DeepClone();
                        continue;
                    }
                    if (baseType is JsonObject baseTypeObj && value is JsonObject childTypeObj && Refines(childTypeObj))
                    {
                        merged[key] = DeepMerge(baseTypeObj, childTypeObj);
                        continue;
                    }
                }
                throw new ManifestValidationException(
                    [new($"/{mapName}/{key}", $"{Singular(mapName)} id {key} conflicts with extended base")]);
            }
            merged[key] = value?.DeepClone();
        }

        return merged;
    }

    private static bool IsAbstractType(JsonNode? value) =>
        value is JsonObject obj && obj.TryGetPropertyValue("abstract", out var flag)
        && flag is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static bool Refines(JsonObject obj) =>
        obj.TryGetPropertyValue("refines", out var flag)
        && flag is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    /// <summary>
    /// Recursively merges a child object onto a base, key-by-key. Where both sides hold a plain
    /// object under the same key, the merge recurses; otherwise the child value replaces the base
    /// value (arrays and scalars replace wholesale). Keys present only in the base are retained.
    /// The <c>refines</c> marker is consumed here so it never reaches the resolved manifest.
    /// </summary>
    private static JsonObject DeepMerge(JsonObject baseObj, JsonObject childObj)
    {
        var result = new JsonObject();
        foreach (var (key, value) in baseObj)
            result[key] = value?.DeepClone();

        foreach (var (key, value) in childObj)
        {
            if (key == "refines") continue;
            if (baseObj[key] is JsonObject existing && value is JsonObject childChild)
                result[key] = DeepMerge(existing, childChild);
            else
                result[key] = value?.DeepClone();
        }

        return result;
    }

    private static JsonArray MergeSlots(JsonArray baseSlots, JsonArray childSlots)
    {
        var merged = new JsonArray();
        var seen = new HashSet<string>();

        foreach (var slot in baseSlots)
        {
            var id = SlotId(slot);
            if (id is not null) seen.Add(id);
            merged.Add(slot?.DeepClone());
        }

        foreach (var slot in childSlots)
        {
            var id = SlotId(slot);
            if (id is not null && seen.Contains(id))
            {
                if (slot is JsonObject childSlot && Refines(childSlot))
                {
                    var idx = IndexOfSlot(merged, id);
                    if (idx >= 0)
                    {
                        merged[idx] = DeepMerge((JsonObject)merged[idx]!, childSlot);
                        continue;
                    }
                }
                throw new ManifestValidationException(
                    [new($"/slots/{id}", $"slot id {id} conflicts with extended base")]);
            }
            if (id is not null) seen.Add(id);
            merged.Add(slot?.DeepClone());
        }

        return merged;
    }

    private static string? SlotId(JsonNode? slot)
    {
        if (slot is JsonObject obj && obj.TryGetPropertyValue("id", out var idNode)
            && idNode is JsonValue v && v.TryGetValue<string>(out var id))
            return id;
        return null;
    }

    private static int IndexOfSlot(JsonArray slots, string id)
    {
        for (var i = 0; i < slots.Count; i++)
        {
            if (SlotId(slots[i]) == id) return i;
        }
        return -1;
    }

    private static string Singular(string mapName) => mapName switch
    {
        "bindings" => "binding",
        "capabilities" => "capability",
        "hooks" => "hook",
        "types" => "type",
        _ => mapName,
    };
}
