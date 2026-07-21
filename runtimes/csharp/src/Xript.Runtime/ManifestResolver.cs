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
            else if (key == "formats" && childValue is JsonObject childFormats)
            {
                result[key] = MergeFormats(result[key] as JsonObject, childFormats);
            }
            else if (key == "vocabularies" && childValue is JsonObject childVocabularies)
            {
                result[key] = MergeVocabularies(result[key] as JsonObject, childVocabularies);
            }
            else
            {
                result[key] = childValue?.DeepClone();
            }
        }

        if (!childObj.ContainsKey("formats") && result["formats"] is JsonObject baseFormats)
            result["formats"] = MergeFormats(baseFormats, null);

        if (!childObj.ContainsKey("vocabularies") && result["vocabularies"] is JsonObject baseVocabularies)
            result["vocabularies"] = MergeVocabularies(baseVocabularies, null);

        return result;
    }

    /// <summary>
    /// Merges the <c>formats</c> block across an <c>extends</c> chain. Three levels, each
    /// collision-as-error unless the child marks itself <c>refines</c>: a format id, a node inside
    /// a refining format, and a prop inside a refining node. Without this arm a child's
    /// <c>formats</c> would fall into the catch-all and silently replace the base's vocabulary.
    /// </summary>
    private static JsonObject MergeFormats(JsonObject? baseFormats, JsonObject? childFormats)
    {
        var merged = new JsonObject();

        foreach (var (id, format) in baseFormats ?? [])
            merged[id] = format is JsonObject obj ? MergeFormat(new JsonObject(), obj, id) : format?.DeepClone();

        foreach (var (id, format) in childFormats ?? [])
        {
            if (baseFormats?[id] is not JsonObject baseFormat)
            {
                merged[id] = format is JsonObject added ? MergeFormat(new JsonObject(), added, id) : format?.DeepClone();
                continue;
            }
            if (format is not JsonObject childFormat || !Refines(childFormat))
                throw new ManifestValidationException(
                    [new($"/formats/{id}", $"format {id} conflicts with extended base")]);

            merged[id] = MergeFormat(baseFormat, childFormat, id);
        }

        return merged;
    }

    /// <summary>
    /// Merges one format declaration onto its base. <c>vocabularies</c> is absent-inherits,
    /// present-replaces-wholesale: the array is ordered and the order is semantic, so there is
    /// no defensible union order, and a silent union could re-inject <c>html</c> into a scope a
    /// child deliberately closed. The asymmetry with <c>nodes</c>, which key-merges, is intentional.
    ///
    /// <c>schemes</c> follows the same rule for the same reason. A union would make narrowing
    /// impossible -- a child could only ever widen its base's URI surface, and <c>[]</c> would
    /// stop meaning deliberate closure.
    /// </summary>
    private static JsonObject MergeFormat(JsonObject baseFormat, JsonObject childFormat, string formatId)
    {
        var merged = new JsonObject();
        foreach (var (key, value) in baseFormat)
        {
            if (key is "refines" or "nodes") continue;
            merged[key] = value?.DeepClone();
        }
        foreach (var (key, value) in childFormat)
        {
            if (key is "refines" or "nodes") continue;
            if (key == "vocabularies")
            {
                merged["vocabularies"] = value?.DeepClone();
                continue;
            }
            if (key == "schemes")
            {
                merged["schemes"] = value?.DeepClone();
                continue;
            }
            merged[key] = value?.DeepClone();
        }

        if (baseFormat.ContainsKey("nodes") || childFormat.ContainsKey("nodes"))
        {
            merged["nodes"] = MergeNodes(
                baseFormat["nodes"] as JsonObject,
                childFormat["nodes"] as JsonObject,
                "format",
                $"/formats/{formatId}");
        }

        return merged;
    }

    /// <summary>
    /// Merges the <c>vocabularies</c> block across an <c>extends</c> chain. Three levels of
    /// collision-as-error-unless-<c>refines</c>, identical to <c>formats</c>: a vocabulary id, a
    /// node inside a refining vocabulary, and a prop inside a refining node.
    /// </summary>
    private static JsonObject MergeVocabularies(
        JsonObject? baseVocabularies, JsonObject? childVocabularies)
    {
        var merged = new JsonObject();

        foreach (var (id, vocabulary) in baseVocabularies ?? [])
            merged[id] = vocabulary is JsonObject obj
                ? MergeVocabulary(new JsonObject(), obj, id)
                : vocabulary?.DeepClone();

        foreach (var (id, vocabulary) in childVocabularies ?? [])
        {
            if (baseVocabularies?[id] is not JsonObject baseVocabulary)
            {
                merged[id] = vocabulary is JsonObject added
                    ? MergeVocabulary(new JsonObject(), added, id)
                    : vocabulary?.DeepClone();
                continue;
            }
            if (vocabulary is not JsonObject childVocabulary || !Refines(childVocabulary))
                throw new ManifestValidationException(
                    [new($"/vocabularies/{id}", $"vocabulary {id} conflicts with extended base")]);

            merged[id] = MergeVocabulary(baseVocabulary, childVocabulary, id);
        }

        return merged;
    }

    private static JsonObject MergeVocabulary(
        JsonObject baseVocabulary, JsonObject childVocabulary, string vocabularyId)
    {
        var merged = new JsonObject();
        foreach (var (key, value) in baseVocabulary)
        {
            if (key is "refines" or "nodes") continue;
            merged[key] = value?.DeepClone();
        }
        foreach (var (key, value) in childVocabulary)
        {
            if (key is "refines" or "nodes") continue;
            merged[key] = value?.DeepClone();
        }

        if (baseVocabulary.ContainsKey("nodes") || childVocabulary.ContainsKey("nodes"))
        {
            merged["nodes"] = MergeNodes(
                baseVocabulary["nodes"] as JsonObject,
                childVocabulary["nodes"] as JsonObject,
                "vocabulary",
                $"/vocabularies/{vocabularyId}");
        }

        return merged;
    }

    /// <summary>
    /// Merges a <c>nodes</c> map, whether it hangs off a format's inline vocabulary or a named
    /// one. <paramref name="owner"/> is the JSON pointer of the declaration the nodes belong to,
    /// so a collision is reported against the surface the author actually wrote.
    /// </summary>
    private static JsonObject MergeNodes(
        JsonObject? baseNodes, JsonObject? childNodes, string ownerLabel, string owner)
    {
        var merged = new JsonObject();

        foreach (var (name, node) in baseNodes ?? [])
            merged[name] = WithoutRefines(node);

        foreach (var (name, node) in childNodes ?? [])
        {
            if (baseNodes?[name] is not JsonObject baseNode)
            {
                merged[name] = WithoutRefines(node);
                continue;
            }
            if (node is not JsonObject childNode || !Refines(childNode))
                throw new ManifestValidationException(
                    [new($"{owner}/nodes/{name}", $"{ownerLabel} node {name} conflicts with extended base")]);

            merged[name] = MergeNode(baseNode, childNode);
        }

        return merged;
    }

    /// <summary>
    /// Merges a child node's props onto a base node's. A same-named prop is REPLACED wholesale
    /// rather than deep-merged: a child widening a prop's type would otherwise silently inherit the
    /// base's <c>sink</c> onto a value the sink can no longer handle.
    /// </summary>
    private static JsonObject MergeNode(JsonObject baseNode, JsonObject childNode)
    {
        var merged = new JsonObject();
        foreach (var (key, value) in baseNode)
        {
            if (key is "refines" or "props") continue;
            merged[key] = value?.DeepClone();
        }
        foreach (var (key, value) in childNode)
        {
            if (key is "refines" or "props") continue;
            merged[key] = value?.DeepClone();
        }

        if (baseNode.ContainsKey("props") || childNode.ContainsKey("props"))
        {
            var props = new JsonObject();
            foreach (var (name, prop) in baseNode["props"] as JsonObject ?? [])
                props[name] = prop?.DeepClone();
            foreach (var (name, prop) in childNode["props"] as JsonObject ?? [])
                props[name] = prop?.DeepClone();
            merged["props"] = props;
        }

        return merged;
    }

    private static JsonNode? WithoutRefines(JsonNode? node)
    {
        if (node is not JsonObject obj) return node?.DeepClone();
        var copy = new JsonObject();
        foreach (var (key, value) in obj)
        {
            if (key == "refines") continue;
            copy[key] = value?.DeepClone();
        }
        return copy;
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
