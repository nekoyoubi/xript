using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime.Fragments;

namespace Xript.Runtime;

public sealed class XriptRuntime : IDisposable
{
    private readonly Sandbox _sandbox;
    private readonly List<LoadedMod> _mods = [];
    private readonly List<HookFillDecl> _hookFills = [];
    private readonly List<CommandFill> _commandFills = [];
    private readonly Dictionary<string, Dictionary<string, string>> _exportCapabilities = new();
    private readonly Dictionary<string, List<string>> _exportOwners = new();
    private readonly IReadOnlyDictionary<string, string> _rolePreferences;
    private readonly IReadOnlyDictionary<string, string> _commandPreferences;
    private readonly bool _strictHtmlVocabulary;
    private readonly Action<FragmentDiagnosticEvent>? _onFragmentDiagnostic;
    private readonly Action<AuditEvent>? _audit;
    private readonly HashSet<(string Mod, string Handler, string Hook)> _reportedHookFillDenials = [];
    private readonly long? _hardTimeoutMs;

    public Manifest Manifest { get; }

    public DebugSession? DebugSession => _sandbox.DebugSession;

    /// <summary>
    /// Bindings the manifest declares that the host did not supply, fully qualified and sorted.
    /// Each installs as a stub that throws when called, so this is the drift between the
    /// contract a mod author reads and the surface the host actually wired.
    /// </summary>
    public IReadOnlyList<string> MissingBindings => _sandbox.MissingBindings;

    private XriptRuntime(Manifest manifest, Sandbox sandbox, RuntimeOptions options)
    {
        Manifest = manifest;
        _sandbox = sandbox;
        _rolePreferences = options.RolePreferences;
        _commandPreferences = options.CommandPreferences;
        _strictHtmlVocabulary = options.StrictHtmlVocabulary;
        _onFragmentDiagnostic = options.OnFragmentDiagnostic;
        _audit = options.Audit;
        _hardTimeoutMs = options.HardLimits?.TimeoutMs;
    }

    public static XriptRuntime Create(string manifestJson, RuntimeOptions? options = null)
    {
        var manifest = JsonSerializer.Deserialize<Manifest>(manifestJson)
            ?? throw new ManifestValidationException([new("/", "manifest deserialized to null")]);
        return Build(manifest, options ?? new());
    }

    public static XriptRuntime CreateFromFile(string path, RuntimeOptions? options = null)
    {
        var json = File.ReadAllText(path);
        var baseDir = Path.GetDirectoryName(Path.GetFullPath(path)) ?? ".";
        var resolved = ManifestResolver.Resolve(json, baseDir);
        return Create(resolved, options);
    }

    public static XriptRuntime CreateFromValue(JsonDocument doc, RuntimeOptions? options = null)
    {
        var manifest = doc.RootElement.Deserialize<Manifest>()
            ?? throw new ManifestValidationException([new("/", "manifest deserialized to null")]);
        return Build(manifest, options ?? new());
    }

    public ExecutionResult Execute(string code) =>
        _sandbox.Execute(code);

    public ExecutionResult Execute(string code, string source) =>
        _sandbox.Execute(code, source);

    public JsonElement[] FireHook(string hookName, FireHookOptions? options = null)
    {
        var results = _sandbox.FireHook(hookName, options).ToList();
        if (options?.Phase is null)
        {
            foreach (var fill in _hookFills.Where(fill => fill.Hook == hookName))
            {
                if (DeniedCapability(fill.Mod, fill.Handler) is { } denied)
                {
                    AuditHookFillDenial(fill.Mod, fill.Handler, hookName, denied);
                    results.Add(JsonDocument.Parse("null").RootElement);
                    continue;
                }
                try
                {
                    results.Add(InvokeModExport(fill.Mod, fill.Handler, HookFillArgs(options?.Data)));
                }
                catch
                {
                    results.Add(JsonDocument.Parse("null").RootElement);
                }
            }
        }
        return [.. results];
    }

    private static JsonElement[] HookFillArgs(JsonElement? data)
    {
        if (data is not { } element) return [];
        if (element.ValueKind == JsonValueKind.Object)
            return [.. element.EnumerateObject().Select(property => property.Value)];
        return [element];
    }

    public JsonElement[] Emit(string eventId, FireHookOptions? options = null) =>
        _sandbox.Emit(eventId, options);

    public FragmentOp[] FireFragmentHook(string fragmentId, string lifecycle, Dictionary<string, object?>? bindings = null)
    {
        var raw = _sandbox.FireFragmentHook(fragmentId, lifecycle, bindings);
        var profile = ProfileForFragment(fragmentId);
        var listener = _onFragmentDiagnostic is null
            ? (Action<FragmentDiagnostic>?)null
            : diagnostic => _onFragmentDiagnostic(new FragmentDiagnosticEvent(fragmentId, diagnostic));
        return [.. FragmentOps.Finalize(raw, profile, listener)];
    }

    private FormatProfile ProfileForFragment(string fragmentId)
    {
        foreach (var loaded in _mods)
        {
            foreach (var fragment in loaded.Instance.Fragments)
                if (fragment.Id == fragmentId) return fragment.Profile;
        }
        return FormatProfiles.Builtins["text/html"];
    }

    public JsonElement InvokeExport(string name, JsonElement[] args)
    {
        var owner = DeclaredOwner(name);
        if (owner is not null) GateModExport(owner, name);
        return _sandbox.InvokeExport(name, args, owner);
    }

    /// <summary>
    /// Invokes an export inside one named mod's own namespace. Gated by that mod's own
    /// declaration, so a second mod declaring the same name can neither weaken the gate
    /// nor shadow the function.
    /// </summary>
    public JsonElement InvokeModExport(string mod, string name, JsonElement[] args)
    {
        GateModExport(mod, name);
        return _sandbox.InvokeExport(name, args, mod);
    }

    /// <summary>
    /// <see cref="InvokeModExport"/> bounded by a slot's own <c>limits.timeout_ms</c>
    /// instead of the manifest-wide budget. <c>null</c> keeps the manifest budget.
    /// </summary>
    internal JsonElement InvokeModExportWithin(string mod, string name, JsonElement[] args, long? timeoutOverrideMs)
    {
        GateModExport(mod, name);
        return _sandbox.InvokeExport(name, args, mod, timeoutOverrideMs);
    }

    /// <summary>
    /// The timeout governing calls into a slot's fills: the slot's own
    /// <c>limits.timeout_ms</c> where it declares one, otherwise <c>null</c> to mean
    /// "use the manifest-wide budget".
    /// </summary>
    private long? SlotTimeoutMs(string slotId) =>
        Manifest.Slots?.FirstOrDefault(slot => slot.Id == slotId)?.Limits?.TimeoutMs;

    /// <summary>
    /// The deadline that governs a call into a fill of this slot, after the slot's own
    /// <c>limits</c>, the manifest's, and the embedder's ceiling have been applied. A host
    /// routing long work needs to know the budget it is routing under. Held to
    /// <c>spec/slot-limit-tests.json</c> by every runtime.
    /// </summary>
    public long EffectiveSlotTimeoutMs(string slotId)
    {
        var self = Manifest.Limits?.TimeoutMs ?? DefaultTimeoutMs;
        var requested = SlotTimeoutMs(slotId) ?? self;
        return _hardTimeoutMs is { } hard && requested > hard ? hard : requested;
    }

    /// <summary>
    /// The schema default deadline, applied where neither a slot nor the manifest declares
    /// one. Pinned by <c>spec/slot-limit-tests.json</c>.
    /// </summary>
    public const long DefaultTimeoutMs = 5000;

    private string? DeclaredOwner(string name)
    {
        if (!_exportOwners.TryGetValue(name, out var owners) || owners.Count == 0)
            return null;
        if (owners.Count > 1)
            throw new AmbiguousExportException(name, owners);
        return owners[0];
    }

    private void GateModExport(string mod, string name)
    {
        if (DeniedCapability(mod, name) is { } capability)
            throw new CapabilityDeniedException(name, capability);
    }

    /// <summary>
    /// The capability an export declares when the granted set does not satisfy it, otherwise null.
    /// </summary>
    private string? DeniedCapability(string mod, string name)
    {
        if (_exportCapabilities.TryGetValue(mod, out var own)
            && own.TryGetValue(name, out var capability)
            && !Capabilities.GrantedSatisfies(_sandbox.GrantedCapabilities, capability))
            return capability;
        return null;
    }

    /// <summary>
    /// Reports a hook fill refused on capability grounds to the audit sink, once per
    /// (mod, handler, hook) for the lifetime of the runtime so a hot hook cannot flood the channel.
    /// </summary>
    private void AuditHookFillDenial(string mod, string handler, string hook, string capability)
    {
        if (_audit is null) return;
        if (!_reportedHookFillDenials.Add((mod, handler, hook))) return;
        try
        {
            _audit(new AuditEvent(
                handler,
                capability,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                AuditDecision.Denied,
                mod,
                hook));
        }
        catch
        {
            // fire-and-forget: a throwing audit sink never breaks hook dispatch
        }
    }

    public ModInstance LoadMod(string modManifestJson, Dictionary<string, string>? fragmentSources = null)
    {
        var grantedForFills = new HashSet<string>(_sandbox.GrantedCapabilities);
        var (normalizedJson, hookFills, commandFills) = FillsNormalizer.Normalize(
            modManifestJson, Manifest.Slots ?? [], grantedForFills);
        modManifestJson = normalizedJson;

        var mod = FragmentProcessor.ValidateModManifest(modManifestJson);

        var grantedCapabilities = new HashSet<string>(_sandbox.GrantedCapabilities);
        var crossIssues = FragmentProcessor.CrossValidate(mod, Manifest, grantedCapabilities);
        if (crossIssues.Count > 0)
            throw new ModManifestValidationException(
                crossIssues.Select(msg => new ValidationIssue("/fragments", msg)).ToList());

        RegisterExportCapabilities(mod);
        RunEntryScripts(mod, fragmentSources);

        var instance = new ModInstance(
            mod, fragmentSources, Manifest.Formats, Manifest.Vocabularies, _strictHtmlVocabulary,
            _onFragmentDiagnostic);
        instance.CommandFills = commandFills;
        _hookFills.AddRange(hookFills);
        _commandFills.AddRange(commandFills);
        _mods.Add(new LoadedMod(instance, grantedCapabilities, mod));
        return instance;
    }

    /// <summary>
    /// Every command contributed to one slot, in resolution order: priority descending,
    /// then command id ascending, then owning mod ascending. Independent of mod load order.
    /// </summary>
    public IReadOnlyList<ResolvedCommand> ResolveCommandsAll(string slotId)
    {
        var slot = Manifest.Slots?.FirstOrDefault(s => s.Id == slotId);
        var fills = _commandFills.Where(fill => fill.Slot == slotId).ToList();
        var ambiguous = fills
            .GroupBy(fill => fill.Id, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToHashSet(StringComparer.Ordinal);

        return
        [
            .. Commands.Order(fills).Select(fill => new ResolvedCommand(fill)
            {
                Capability = ExportCapability(fill.Mod, fill.Handler) ?? slot?.Capability,
                Capabilities = Gates(slot, fill),
                Collides = ambiguous.Contains(fill.Id),
            })
        ];
    }

    /// <summary>
    /// <see cref="ResolveCommandsAll"/> narrowed by the slot's cardinality. A slot without
    /// <c>multiple: true</c> resolves to exactly one command across all mods, the same way
    /// every other slot kind does.
    /// </summary>
    public IReadOnlyList<ResolvedCommand> ResolveCommands(string slotId)
    {
        var commands = ResolveCommandsAll(slotId);
        var allowMultiple = Manifest.Slots?.FirstOrDefault(s => s.Id == slotId)?.Multiple ?? false;
        if (!allowMultiple && commands.Count > 1)
            return [commands[0]];
        return commands;
    }

    /// <summary>
    /// Looks a command up by bare id or by qualified <c>mod:id</c> address across every
    /// command slot. A bare id takes the configured preference when one matches, otherwise
    /// the resolution winner; a qualified id is total and ignores preferences.
    /// </summary>
    public ResolvedCommand? ResolveCommand(string reference)
    {
        var candidates = (Manifest.Slots ?? [])
            .Where(slot => slot.IsCommandSlot())
            .SelectMany(slot => ResolveCommands(slot.Id))
            .ToList();

        var separator = reference.IndexOf(':');
        if (separator > 0)
        {
            var mod = reference[..separator];
            var id = reference[(separator + 1)..];
            return candidates.FirstOrDefault(c => c.Mod == mod && c.Id == id);
        }

        var matches = candidates.Where(c => c.Id == reference).ToList();
        if (matches.Count == 0)
            return null;

        if (Preferred(reference, matches) is { } preferred)
            return preferred;

        return matches[0];
    }

    private ResolvedCommand? Preferred(string commandId, IReadOnlyList<ResolvedCommand> matches)
    {
        foreach (var key in new[] { commandId, matches[0].Slot })
            if (_commandPreferences.TryGetValue(key, out var mod)
                && matches.FirstOrDefault(c => c.Mod == mod) is { } match)
                return match;
        return null;
    }

    /// <summary>
    /// Invokes a resolved command in its declaring mod's own export namespace, with the
    /// caller's arguments merged over the fill's bound ones. Routed through
    /// <see cref="InvokeModExport"/>, so the export's capability gate is re-checked against
    /// the live grant set and no other mod's same-named export can be reached. A throwing
    /// handler propagates: unlike a hook, a command the user triggered must report failure.
    /// </summary>
    public JsonElement InvokeCommand(ResolvedCommand command, JsonObject? args = null)
    {
        var effective = Commands.MergeArgs(command.Args, args);
        var element = JsonDocument.Parse(effective.ToJsonString()).RootElement.Clone();
        return InvokeModExportWithin(command.Mod, command.Handler, [element], SlotTimeoutMs(command.Slot));
    }

    /// <summary>
    /// Resolves a bare or qualified command reference and invokes it.
    /// </summary>
    /// <exception cref="InvokeException">when the reference resolves to no command</exception>
    public JsonElement InvokeCommand(string reference, JsonObject? args = null)
    {
        var command = ResolveCommand(reference)
            ?? throw new InvokeException(reference, $"no command resolves for '{reference}'");
        return InvokeCommand(command, args);
    }

    private List<string> Gates(Slot? slot, CommandFill fill)
    {
        var gates = new List<string>();
        if (slot?.Capability is { } contribution)
            gates.Add(contribution);
        if (ExportCapability(fill.Mod, fill.Handler) is { } invocation && !gates.Contains(invocation))
            gates.Add(invocation);
        return gates;
    }

    private string? ExportCapability(string mod, string name) =>
        _exportCapabilities.TryGetValue(mod, out var own) && own.TryGetValue(name, out var capability)
            ? capability
            : null;

    public RoleResolution? ResolveRole(string role)
    {
        var candidates = ResolveRoleAll(role);
        if (candidates.Count == 0)
            return null;

        if (_rolePreferences.TryGetValue(role, out var preferred))
        {
            var match = candidates.FirstOrDefault(c => c.Addon == preferred);
            if (match is not null)
                return match;
        }

        return candidates[0];
    }

    /// <summary>
    /// Every provider of one role, ordered by owning mod name so the answer does not depend
    /// on the order the host happened to load its mods in. The same tiebreak the command and
    /// slot resolvers use.
    /// </summary>
    public IReadOnlyList<RoleResolution> ResolveRoleAll(string role)
    {
        var results = new List<RoleResolution>();

        foreach (var loaded in _mods)
        {
            var provides = loaded.Manifest.Contributions?.Provides;
            if (provides is null) continue;

            foreach (var entry in provides)
            {
                if (entry.Role != role) continue;
                results.Add(new RoleResolution(
                    loaded.Manifest.Name,
                    entry.Role,
                    new Dictionary<string, string>(entry.Fns)));
            }
        }

        return [.. results.OrderBy(resolution => resolution.Addon, StringComparer.Ordinal)];
    }

    public SlotContribution[] ResolveSlot(string slotId)
    {
        var slot = Manifest.Slots?.FirstOrDefault(s => s.Id == slotId);
        var allowMultiple = slot?.Multiple ?? false;

        var contributions = new List<SlotContribution>();
        foreach (var loaded in _mods)
        {
            foreach (var fragment in loaded.Instance.Fragments)
            {
                if (fragment.Slot != slotId) continue;
                contributions.Add(new SlotContribution(
                    loaded.Instance.Name, fragment.Id, fragment.Slot, fragment.Format, fragment.Priority)
                {
                    ContentType = fragment.ContentType,
                });
            }
        }

        var ordered = contributions
            .OrderByDescending(c => c.Priority)
            .ThenBy(c => c.FragmentId, StringComparer.Ordinal)
            .ToList();

        if (!allowMultiple && ordered.Count > 1)
            return [ordered[0]];

        return [.. ordered];
    }

    public SlotContribution? ResolveSlotSingle(string slotId)
    {
        var contributions = ResolveSlot(slotId);
        return contributions.Length > 0 ? contributions[0] : null;
    }

    public void Dispose() =>
        _sandbox.Dispose();

    private void RegisterExportCapabilities(ModManifest mod)
    {
        if (mod.Entry is not { } entry || entry.ValueKind != JsonValueKind.Object)
            return;

        if (!entry.TryGetProperty("exports", out var exports) || exports.ValueKind != JsonValueKind.Object)
            return;

        foreach (var export in exports.EnumerateObject())
        {
            if (!_exportCapabilities.TryGetValue(mod.Name, out var own))
            {
                own = new Dictionary<string, string>();
                _exportCapabilities[mod.Name] = own;
            }

            if (export.Value.ValueKind == JsonValueKind.Object
                && export.Value.TryGetProperty("capability", out var cap)
                && cap.ValueKind == JsonValueKind.String)
            {
                own[export.Name] = cap.GetString()!;
            }

            if (!_exportOwners.TryGetValue(export.Name, out var owners))
            {
                owners = new List<string>();
                _exportOwners[export.Name] = owners;
            }
            if (!owners.Contains(mod.Name))
                owners.Add(mod.Name);
        }
    }

    private void RunEntryScripts(ModManifest mod, Dictionary<string, string>? fragmentSources)
    {
        if (mod.Entry is not { } entry)
            return;

        var isModule = IsModuleFormat(entry);
        var scriptPaths = ExtractEntryScripts(entry);
        if (scriptPaths.Count == 0)
            return;

        _sandbox.SetExportOwner(mod.Name);
        try
        {
            foreach (var path in scriptPaths)
            {
                if (fragmentSources?.TryGetValue(path, out var source) != true || source is null)
                    continue;

                if (CommonJsDetector.Detect(source) is { } artifact)
                    throw new CommonJsDetectedException(artifact);

                if (isModule)
                    _sandbox.EvaluateModule(source, mod.Name);
                else
                    _sandbox.Execute(source);
            }
        }
        finally
        {
            _sandbox.SetExportOwner(null);
        }
    }

    private static bool IsModuleFormat(JsonElement entry)
    {
        if (entry.ValueKind != JsonValueKind.Object)
            return false;

        if (!entry.TryGetProperty("format", out var format) || format.ValueKind != JsonValueKind.String)
            return false;

        return format.GetString() == "module";
    }

    private static List<string> ExtractEntryScripts(JsonElement entry)
    {
        var paths = new List<string>();

        switch (entry.ValueKind)
        {
            case JsonValueKind.String:
                paths.Add(entry.GetString()!);
                break;
            case JsonValueKind.Array:
                foreach (var item in entry.EnumerateArray())
                    if (item.ValueKind == JsonValueKind.String)
                        paths.Add(item.GetString()!);
                break;
            case JsonValueKind.Object:
                if (entry.TryGetProperty("script", out var script) && script.ValueKind == JsonValueKind.String)
                    paths.Add(script.GetString()!);
                break;
        }

        return paths;
    }

    private static XriptRuntime Build(Manifest manifest, RuntimeOptions options)
    {
        ManifestValidator.Validate(manifest);
        var sandbox = new Sandbox(manifest, options);
        return new XriptRuntime(manifest, sandbox, options);
    }

    private sealed record LoadedMod(ModInstance Instance, HashSet<string> GrantedCapabilities, ModManifest Manifest);
}
