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
