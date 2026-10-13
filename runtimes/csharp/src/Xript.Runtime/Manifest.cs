using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xript.Runtime;

public record Manifest
{
    [JsonPropertyName("xript")]
    public string Xript { get; init; } = "";

    [JsonPropertyName("extends")]
    public JsonElement? Extends { get; init; }

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

    [JsonPropertyName("events")]
    public List<EventDeclaration>? Events { get; init; }

    [JsonPropertyName("libraries")]
    public Dictionary<string, LibraryDef>? Libraries { get; init; }

    /// <summary>
    /// Fragment formats this host declares, keyed by media type. Each entry names a
    /// <c>syntax</c>, the <c>vocabularies</c> in scope, and an optional inline <c>nodes</c>
    /// block. The four built-in format ids always win and may not be redeclared.
    /// </summary>
    [JsonPropertyName("formats")]
    public Dictionary<string, JsonElement>? Formats { get; init; }

    /// <summary>
    /// Reusable node vocabularies this host declares, keyed by id. A vocabulary declares
    /// nodes and their props and nothing about how they are authored, so any number of
    /// formats may bring the same vocabulary into scope under different syntaxes.
    /// </summary>
    [JsonPropertyName("vocabularies")]
    public Dictionary<string, JsonElement>? Vocabularies { get; init; }

    /// <summary>
    /// The effective hook map the runtime dispatches: the explicit <c>hooks</c>
    /// section plus a synthesized phaseless <see cref="HookDef"/> for every
    /// event-typed slot (<c>accepts</c> contains <c>application/x-xript-hook</c>).
    /// An explicit hook wins over a same-id slot; slots never clobber a declared hook.
    /// </summary>
    public Dictionary<string, HookDef> EffectiveHooks()
    {
        var hooks = Hooks is null
            ? new Dictionary<string, HookDef>()
            : new Dictionary<string, HookDef>(Hooks);
        if (Slots is not null)
        {
            foreach (var slot in Slots)
            {
                if (!slot.IsHookSlot() || hooks.ContainsKey(slot.Id)) continue;
                hooks[slot.Id] = new HookDef
                {
                    Description = slot.Description ?? "",
                    Capability = slot.Capability,
                };
            }
        }
        return hooks;
    }
}

/// <summary>
/// An approved importable library: the host vouches that the registered
/// pre-bundled ES module is sandbox-safe shared code. <c>Capability</c> gates
/// which mods may import it; <c>Version</c> documents the contract mod authors
/// compile against.
/// </summary>
public record LibraryDef
{
    [JsonPropertyName("description")]
    public string? Description { get; init; }

    [JsonPropertyName("capability")]
    public string? Capability { get; init; }

    [JsonPropertyName("version")]
    public string? Version { get; init; }

    [JsonPropertyName("deprecated")]
    public string? Deprecated { get; init; }
}

public record EventDeclaration
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("description")]
    public string Description { get; init; } = "";

    [JsonPropertyName("payload")]
    public JsonElement? Payload { get; init; }

    [JsonPropertyName("capability")]
    public string? Capability { get; init; }
}

public record Slot
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("accepts")]
    public List<string> Accepts { get; init; } = new();

    [JsonPropertyName("description")]
    public string? Description { get; init; }

    [JsonPropertyName("capability")]
    public string? Capability { get; init; }

    [JsonPropertyName("multiple")]
    public bool? Multiple { get; init; }

    [JsonPropertyName("style")]
    public string? Style { get; init; }

    /// <summary>
    /// Enforced limits for calls into this slot's fills, overriding the manifest's
    /// <c>limits</c> field by field. The counterpart to <c>execution</c>: that one is
    /// advisory routing, this one is enforcement.
    /// </summary>
    [JsonPropertyName("limits")]
    public SlotLimits? Limits { get; init; }

    public const string RoleAccept = "application/x-xript-role";

    public const string HookAccept = "application/x-xript-hook";

    public const string CommandAccept = "application/x-xript-command";

    public bool IsRoleSlot() => Accepts.Contains(RoleAccept);

    public bool IsHookSlot() => Accepts.Contains(HookAccept);

    /// <summary>
    /// Whether fills of this slot are read as commands. The three reserved accepts are
    /// matched in a fixed order — role, then hook, then command — so a slot listing more
    /// than one resolves the same way in every runtime.
    /// </summary>
    public bool IsCommandSlot() =>
        Accepts.Contains(CommandAccept) && !IsRoleSlot() && !IsHookSlot();
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

    [JsonPropertyName("family")]
    public string? Family { get; init; }

    [JsonPropertyName("entry")]
    public JsonElement? Entry { get; init; }

    [JsonPropertyName("fragments")]
    public List<FragmentDeclaration>? Fragments { get; init; }

    [JsonPropertyName("contributions")]
    public Contributions? Contributions { get; init; }
}

public record Contributions
{
    [JsonPropertyName("provides")]
    public List<ProviderRole>? Provides { get; init; }
}

public record ProviderRole
{
    [JsonPropertyName("role")]
    public string Role { get; init; } = "";

    [JsonPropertyName("fns")]
    public Dictionary<string, string> Fns { get; init; } = new();
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

    [JsonPropertyName("handlers")]
    public List<FragmentHandlerDeclaration>? Handlers { get; init; }

    /// <summary>
    /// Deprecated alias for <see cref="Handlers"/>. A reader accepts either; when both are
    /// present, <c>handlers</c> wins. Retained for back-compat with manifests authored before
    /// the rename.
    /// </summary>
    [JsonPropertyName("events")]
    public List<FragmentHandlerDeclaration>? Events { get; init; }

    [JsonPropertyName("priority")]
    public int? Priority { get; init; }

    /// <summary>
    /// Turns on <c>{{ expr }}</c> interpolation for this fill's text nodes. Off by default:
    /// a fragment published before the mode existed may carry <c>{{</c> in prose or a code
    /// sample, and its meaning must not change.
    /// </summary>
    [JsonPropertyName("interpolate")]
    public bool? Interpolate { get; init; }

    public List<FragmentHandlerDeclaration> ResolveHandlers() => Handlers ?? Events ?? [];
}

/// <summary>
/// One entry of a fragment fill's <c>bindings</c>: a local name the fragment's expressions read,
/// resolved from a host data path.
/// </summary>
public record FragmentBinding
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("path")]
    public string Path { get; init; } = "";

    /// <summary>
    /// Optional value type, for tooling that type-checks the expressions reading this binding.
    /// Not consulted at runtime.
    /// </summary>
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    /// <summary>
    /// Host-defined extension fields (a value transform, a formatting hint), carried through
    /// untouched and never interpreted by the runtime. A mod that uses one only works on hosts
    /// that implement it.
    /// </summary>
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Extensions { get; init; }
}

public record FragmentHandlerDeclaration
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

/// <summary>
/// Per-slot execution limits. Carries <c>timeout_ms</c> alone on purpose: memory and
/// stack ceilings are fixed when an engine is created, so a per-slot value for either
/// could not be enforced without standing up a separate runtime. That path is
/// <c>execution.affinity</c> plus a pool worker with its own limits.
/// </summary>
public record SlotLimits
{
    [JsonPropertyName("timeout_ms")]
    public long? TimeoutMs { get; init; }
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
