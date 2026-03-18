using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xript.Runtime;

public record Manifest
{
    [JsonPropertyName("xript")]
    public string Xript { get; init; } = "";

    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("version")]
    public string? Version { get; init; }

    [JsonPropertyName("title")]
    public string? Title { get; init; }

    [JsonPropertyName("description")]
    public string? Description { get; init; }

    [JsonPropertyName("bindings")]
    public Dictionary<string, JsonElement>? Bindings { get; init; }

    [JsonPropertyName("hooks")]
    public Dictionary<string, HookDef>? Hooks { get; init; }

    [JsonPropertyName("capabilities")]
    public Dictionary<string, CapabilityDef>? Capabilities { get; init; }

    [JsonPropertyName("limits")]
    public ExecutionLimits? Limits { get; init; }

    [JsonPropertyName("slots")]
    public List<Slot>? Slots { get; init; }
}

public record Slot
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("accepts")]
    public List<string> Accepts { get; init; } = new();

    [JsonPropertyName("capability")]
    public string? Capability { get; init; }

    [JsonPropertyName("multiple")]
    public bool? Multiple { get; init; }

    [JsonPropertyName("style")]
    public string? Style { get; init; }
}

public record ModManifest
{
    [JsonPropertyName("xript")]
    public string Xript { get; init; } = "";

    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("version")]
    public string Version { get; init; } = "";

    [JsonPropertyName("title")]
    public string? Title { get; init; }

    [JsonPropertyName("description")]
    public string? Description { get; init; }

    [JsonPropertyName("author")]
    public string? Author { get; init; }

    [JsonPropertyName("capabilities")]
    public List<string>? Capabilities { get; init; }

    [JsonPropertyName("entry")]
    public JsonElement? Entry { get; init; }

    [JsonPropertyName("fragments")]
    public List<FragmentDeclaration>? Fragments { get; init; }
}

public record FragmentDeclaration
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("slot")]
    public string Slot { get; init; } = "";

    [JsonPropertyName("format")]
    public string Format { get; init; } = "";

    [JsonPropertyName("source")]
    public string Source { get; init; } = "";

    [JsonPropertyName("inline")]
    public bool? Inline { get; init; }

    [JsonPropertyName("bindings")]
    public List<FragmentBinding>? Bindings { get; init; }

    [JsonPropertyName("events")]
    public List<FragmentEventDeclaration>? Events { get; init; }

    [JsonPropertyName("priority")]
    public int? Priority { get; init; }
}

public record FragmentBinding
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("path")]
    public string Path { get; init; } = "";
}

public record FragmentEventDeclaration
{
    [JsonPropertyName("selector")]
    public string Selector { get; init; } = "";

    [JsonPropertyName("on")]
    public string On { get; init; } = "";

    [JsonPropertyName("handler")]
    public string Handler { get; init; } = "";
}

public record HookDef
{
    [JsonPropertyName("description")]
    public string Description { get; init; } = "";

    [JsonPropertyName("phases")]
    public List<string>? Phases { get; init; }

    [JsonPropertyName("params")]
    public List<ParameterDef>? Params { get; init; }

    [JsonPropertyName("capability")]
    public string? Capability { get; init; }

    [JsonPropertyName("async")]
    public bool? Async { get; init; }

    [JsonPropertyName("deprecated")]
    public string? Deprecated { get; init; }
}

public record CapabilityDef
{
    [JsonPropertyName("description")]
    public string Description { get; init; } = "";

    [JsonPropertyName("risk")]
    public string? Risk { get; init; }
}

public record ParameterDef
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("type")]
    public JsonElement Type { get; init; }

    [JsonPropertyName("description")]
    public string? Description { get; init; }

    [JsonPropertyName("default")]
    public JsonElement? Default { get; init; }

    [JsonPropertyName("required")]
    public bool? Required { get; init; }
}

public record ExecutionLimits
{
    [JsonPropertyName("timeout_ms")]
    public long? TimeoutMs { get; init; }

    [JsonPropertyName("memory_mb")]
    public long? MemoryMb { get; init; }

    [JsonPropertyName("max_stack_depth")]
    public int? MaxStackDepth { get; init; }
}
