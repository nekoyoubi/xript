using System.Text.Json;

namespace Xript.Runtime;

public sealed class XriptRuntime : IDisposable
{
    private readonly Sandbox _sandbox;
    private readonly List<LoadedMod> _mods = [];
    private readonly List<HookFillDecl> _hookFills = [];
    private readonly Dictionary<string, string> _exportCapabilities = new();
    private readonly IReadOnlyDictionary<string, string> _rolePreferences;

    public Manifest Manifest { get; }

    public DebugSession? DebugSession => _sandbox.DebugSession;

    private XriptRuntime(Manifest manifest, Sandbox sandbox, IReadOnlyDictionary<string, string> rolePreferences)
    {
        Manifest = manifest;
        _sandbox = sandbox;
        _rolePreferences = rolePreferences;
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
                try
                {
                    results.Add(_sandbox.InvokeExport(fill.Handler, HookFillArgs(options?.Data)));
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

    public FragmentOp[] FireFragmentHook(string fragmentId, string lifecycle, Dictionary<string, object?>? bindings = null) =>
        _sandbox.FireFragmentHook(fragmentId, lifecycle, bindings);

    public JsonElement InvokeExport(string name, JsonElement[] args)
    {
        if (_exportCapabilities.TryGetValue(name, out var capability)
            && !Capabilities.GrantedSatisfies(_sandbox.GrantedCapabilities, capability))
            throw new CapabilityDeniedException(name, capability);

        return _sandbox.InvokeExport(name, args);
    }

    public ModInstance LoadMod(string modManifestJson, Dictionary<string, string>? fragmentSources = null)
    {
        var grantedForFills = new HashSet<string>(_sandbox.GrantedCapabilities);
        var (normalizedJson, hookFills) = FillsNormalizer.Normalize(
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

        var instance = new ModInstance(mod, fragmentSources);
        _hookFills.AddRange(hookFills);
        _mods.Add(new LoadedMod(instance, grantedCapabilities, mod));
        return instance;
    }

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

        return results;
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
                    loaded.Instance.Name, fragment.Id, fragment.Slot, fragment.Format, fragment.Priority));
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
            if (export.Value.ValueKind == JsonValueKind.Object
                && export.Value.TryGetProperty("capability", out var cap)
                && cap.ValueKind == JsonValueKind.String)
            {
                _exportCapabilities[export.Name] = cap.GetString()!;
            }
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
        return new XriptRuntime(manifest, sandbox, options.RolePreferences);
    }

    private sealed record LoadedMod(ModInstance Instance, HashSet<string> GrantedCapabilities, ModManifest Manifest);
}
