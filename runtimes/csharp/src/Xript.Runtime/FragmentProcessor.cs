using System.Text.Json;
using System.Text.RegularExpressions;
using Jint;
using Jint.Native;
using Xript.Runtime.Expressions;
using Xript.Runtime.Fragments;

namespace Xript.Runtime;

/// <summary>
/// <c>Visibility</c> is keyed by <c>data-if</c> expression text, so two nodes carrying the
/// same condition collapse into one entry. Deprecated in favour of <see cref="Conditions"/>.
/// </summary>
public record FragmentResult(string FragmentId, string Html, Dictionary<string, bool> Visibility)
{
    /// <summary>Every <c>data-if</c> in the bound tree, keyed by tree position, not by text.</summary>
    public IReadOnlyList<FragmentCondition> Conditions { get; init; } = [];

    /// <summary>
    /// The bound fragment tree. Present for every format; for a host-declared vocabulary
    /// it is the only representation, since such a fragment has no HTML projection.
    /// </summary>
    public IReadOnlyList<FragmentNode> Tree { get; init; } = [];

    public string Format { get; init; } = "";

    public FragmentContentType ContentType { get; init; } = FragmentContentType.Html;

    public IReadOnlyList<FragmentDiagnostic> Diagnostics { get; init; } = [];
}

/// <summary>
/// A command from a mod's fragment handler, after the vocabulary has routed it.
/// <c>Selector</c> is the raw target string the mod passed; <c>Target</c> is that string
/// resolved to an id reference or a CSS selector.
/// </summary>
public record FragmentOp(
    string Op,
    string Selector,
    NodeRef Target,
    PropValue? Value = null,
    string? Prop = null,
    string? Attr = null);

/// <summary>Thrown when a fragment names a format no vocabulary resolves.</summary>
public sealed class FragmentFormatException : Exception
{
    public string FragmentId { get; }
    public string Format { get; }

    public FragmentFormatException(string fragmentId, string format, string? message = null)
        : base(message ?? $"unknown fragment format '{format}' — declare it in the host manifest's 'formats' block")
    {
        FragmentId = fragmentId;
        Format = format;
    }
}

/// <summary>Thrown when a fragment violates its format's vocabulary badly enough to refuse it.</summary>
public sealed class FragmentSanitizeException : Exception
{
    public string FragmentId { get; }
    public IReadOnlyList<FragmentDiagnostic> Diagnostics { get; }

    public FragmentSanitizeException(string fragmentId, IReadOnlyList<FragmentDiagnostic> diagnostics)
        : base(FormatMessage(fragmentId, diagnostics))
    {
        FragmentId = fragmentId;
        Diagnostics = diagnostics;
    }

    private static string FormatMessage(string fragmentId, IReadOnlyList<FragmentDiagnostic> diagnostics)
    {
        var lines = diagnostics.Select(d => $"  {d.Path} {d.Message}");
        return $"fragment '{fragmentId}' violates its format's vocabulary:\n{string.Join("\n", lines)}";
    }
}

public class ModManifestValidationException : Exception
{
    public IReadOnlyList<ValidationIssue> Issues { get; }

    public ModManifestValidationException(IReadOnlyList<ValidationIssue> issues)
        : base(FormatMessage(issues))
    {
        Issues = issues;
    }

    private static string FormatMessage(IReadOnlyList<ValidationIssue> issues)
    {
        var lines = issues.Select(i => $"  {i.Path}: {i.Message}");
        return $"invalid xript mod manifest:\n{string.Join("\n", lines)}";
    }
}

public sealed class FragmentProcessor
{
    public static ModManifest ValidateModManifest(string json)
    {
        ModManifest? mod;
        try
        {
            mod = JsonSerializer.Deserialize<ModManifest>(json);
        }
        catch (JsonException ex)
        {
            throw new ModManifestValidationException([new("/", $"invalid JSON: {ex.Message}")]);
        }

        if (mod is null)
            throw new ModManifestValidationException([new("/", "mod manifest deserialized to null")]);

        var issues = new List<ValidationIssue>();

        if (string.IsNullOrEmpty(mod.Xript))
            issues.Add(new("/xript", "required field 'xript' must be a non-empty string"));

        if (string.IsNullOrEmpty(mod.Name))
            issues.Add(new("/name", "required field 'name' must be a non-empty string"));

        if (string.IsNullOrEmpty(mod.Version))
            issues.Add(new("/version", "required field 'version' must be a non-empty string"));

        if (mod.Fragments is { } fragments)
        {
            for (var i = 0; i < fragments.Count; i++)
            {
                var frag = fragments[i];
                var prefix = $"/fragments/{i}";

                if (string.IsNullOrEmpty(frag.Id))
                    issues.Add(new($"{prefix}/id", "'id' must be a non-empty string"));

                if (string.IsNullOrEmpty(frag.Slot))
                    issues.Add(new($"{prefix}/slot", "'slot' must be a non-empty string"));

                if (string.IsNullOrEmpty(frag.Format))
                    issues.Add(new($"{prefix}/format", "'format' must be a non-empty string"));

                if (frag.Source is null)
                    issues.Add(new($"{prefix}/source", "'source' must be a string"));
            }
        }

        if (issues.Count > 0)
            throw new ModManifestValidationException(issues);

        return mod;
    }

    public static List<string> CrossValidate(ModManifest mod, Manifest app, HashSet<string> grantedCapabilities)
    {
        var issues = new List<string>();
        var slotMap = new Dictionary<string, Slot>();

        if (app.Slots is not null)
        {
            foreach (var slot in app.Slots)
                slotMap[slot.Id] = slot;
        }

        if (mod.Fragments is null) return issues;

        for (var i = 0; i < mod.Fragments.Count; i++)
        {
            var frag = mod.Fragments[i];

            if (!slotMap.TryGetValue(frag.Slot, out var slot))
            {
                issues.Add($"slot '{frag.Slot}' does not exist in the app manifest");
                continue;
            }

            if (!slot.Accepts.Contains(frag.Format))
            {
                issues.Add($"slot '{frag.Slot}' does not accept format '{frag.Format}'");
            }
            else
            {
                try
                {
                    if (FormatProfiles.Resolve(frag.Format, app.Formats, app.Vocabularies) is null)
                        issues.Add($"unknown fragment format '{frag.Format}' — declare it in the host manifest's 'formats' block");
                }
                catch (FormatProfileException ex)
                {
                    issues.Add(ex.Message);
                }
            }

            if (slot.Capability is not null && !Capabilities.GrantedSatisfies(grantedCapabilities, slot.Capability))
                issues.Add($"slot '{frag.Slot}' requires capability '{slot.Capability}'");
        }

        return issues;
    }

    /// <summary>
    /// Sanitizes an HTML fragment against the built-in HTML vocabulary: an allow-list of
    /// elements and attributes, with <c>href</c>/<c>src</c> and <c>style</c> values routed
    /// through their value sanitizers.
    /// </summary>
    public static string SanitizeHtml(string input) =>
        string.IsNullOrEmpty(input) ? input : HtmlReader.Sanitize(input);

    public static FragmentResult ProcessFragment(
        string fragmentId,
        string sanitizedSource,
        Dictionary<string, object?> bindings)
    {
        var html = ResolveDataBindAttributes(sanitizedSource, bindings);
        var visibility = EvaluateDataIfAttributes(html, bindings);

        return new FragmentResult(fragmentId, html, visibility);
    }

    public static object? ResolveBindingPath(Dictionary<string, object?> data, string path)
    {
        var parts = path.Split('.');
        object? current = data;

        foreach (var part in parts)
        {
            if (current is null)
                return null;

            if (current is Dictionary<string, object?> dict)
            {
                if (!dict.TryGetValue(part, out current))
                    return null;
            }
            else if (current is JsonElement jsonEl)
            {
                if (jsonEl.ValueKind == JsonValueKind.Object && jsonEl.TryGetProperty(part, out var prop))
                    current = (object)prop;
                else
                    return null;
            }
            else
            {
                return null;
            }
        }

        return current;
    }

    public static Dictionary<string, object?> ResolveBindings(
        List<FragmentBinding> declarations,
        Dictionary<string, object?> data)
    {
        var resolved = new Dictionary<string, object?>();
        foreach (var binding in declarations)
            resolved[binding.Name] = ResolveBindingPath(data, binding.Path);
        return resolved;
    }

    private static readonly Regex DataBindPattern =
        new(@"(<[^>]*\bdata-bind=""([^""]*?)""[^>]*>)([\s\S]*?)(</[^>]+>)", RegexOptions.Compiled);

    private static readonly Regex SelfClosingDataBindPattern =
        new(@"(<[^>]*\bdata-bind=""([^""]*?)""[^>]*?)\s*/>", RegexOptions.Compiled);

    private static readonly Regex DataIfPattern =
        new(@"<[^>]*\bdata-if=""([^""]*?)""[^>]*>", RegexOptions.Compiled);

    private static string ResolveDataBindAttributes(string html, Dictionary<string, object?> bindings)
    {
        var result = DataBindPattern.Replace(html, match =>
        {
            var openTag = match.Groups[1].Value;
            var bindName = match.Groups[2].Value;
            var closeTag = match.Groups[4].Value;

            if (!bindings.TryGetValue(bindName, out var value) || value is null)
                return match.Value;

            return $"{openTag}{value}{closeTag}";
        });

        result = SelfClosingDataBindPattern.Replace(result, match =>
        {
            var beforeClose = match.Groups[1].Value;
            var bindName = match.Groups[2].Value;

            if (!bindings.TryGetValue(bindName, out var value) || value is null)
                return match.Value;

            var valueAttr = $"value=\"{value}\"";
            if (beforeClose.Contains("value="))
            {
                beforeClose = Regex.Replace(beforeClose, @"value=""[^""]*""", valueAttr);
                return $"{beforeClose} />";
            }

            return $"{beforeClose} {valueAttr} />";
        });

        return result;
    }

    private static Dictionary<string, bool> EvaluateDataIfAttributes(
        string html, Dictionary<string, object?> bindings)
    {
        var visibility = new Dictionary<string, bool>();

        foreach (Match match in DataIfPattern.Matches(html))
        {
            var expression = HtmlTokenizer.DecodeTextEntities(match.Groups[1].Value);
            visibility[expression] = EvaluateCondition(expression, bindings);
        }

        return visibility;
    }

    /// <summary>
    /// Evaluates a <c>data-if</c> body.
    ///
    /// This replaced a per-evaluation <c>Jint.Engine</c>. That shape had the right instincts
    /// -- a bare engine, no CLR interop, a 100ms timeout -- and it still had to go: a second
    /// JavaScript engine is a second grammar with second semantics and a per-render
    /// allocation, and the point of the exercise is that one expression means one thing in
    /// every runtime. Nothing on this path compiles or evaluates JavaScript.
    /// </summary>
    public static bool EvaluateCondition(string expression, Dictionary<string, object?> bindings) =>
        Xeg.EvaluateCondition(expression, bindings);

    /// <summary>
    /// Classifies a <c>data-bind</c> body. A bare identifier is an lvalue and keeps two-way
    /// write-back; anything else computes a value with no inverse and is read-only.
    /// </summary>
    public static ExpressionKind? BindExpressionKind(string source) => Xeg.Kind(source);

}

public sealed class ModInstance
{
    private static int _idCounter;

    public string Id { get; }
    public string Name { get; }
    public string Version { get; }
    public List<FragmentInstance> Fragments { get; }

    /// <summary>
    /// Commands this mod contributed, in declaration order. Before v0.8.0 these arrived as
    /// opaque fills of a slot the runtime had no typed reading of.
    /// </summary>
    public IReadOnlyList<CommandFill> CommandFills { get; internal set; } = [];

    public ModInstance(ModManifest mod, Dictionary<string, string>? fragmentSources)
        : this(mod, fragmentSources, null, null, false, null)
    {
    }

    internal ModInstance(
        ModManifest mod,
        Dictionary<string, string>? fragmentSources,
        IReadOnlyDictionary<string, JsonElement>? formats,
        IReadOnlyDictionary<string, JsonElement>? vocabularies,
        bool strictHtmlVocabulary,
        Action<FragmentDiagnosticEvent>? onDiagnostic)
    {
        Id = $"mod-{Interlocked.Increment(ref _idCounter)}-{mod.Name}";
        Name = mod.Name;
        Version = mod.Version;
        Fragments = [];

        if (mod.Fragments is null) return;

        foreach (var decl in mod.Fragments)
        {
            var source = decl.Inline == true
                ? decl.Source
                : fragmentSources?.GetValueOrDefault(decl.Source) ?? "";

            Fragments.Add(FragmentInstance.Create(
                decl, source, formats, vocabularies, strictHtmlVocabulary, onDiagnostic));
        }
    }

    public List<FragmentResult> UpdateBindings(Dictionary<string, object?> data)
    {
        return Fragments.Select(f => f.GetContent(data)).ToList();
    }
}

public sealed class FragmentInstance
{
    private readonly FragmentDeclaration _declaration;
    private readonly SanitizedFragment _sanitized;

    public string Id => _declaration.Id;
    public string Slot => _declaration.Slot;
    public string Format => _declaration.Format;
    public int Priority => _declaration.Priority ?? 0;

    /// <summary>The vocabulary this fragment's format resolved to.</summary>
    public FormatProfile Profile { get; }

    /// <summary>The sanitized fragment tree, before bindings are applied.</summary>
    public IReadOnlyList<FragmentNode> SanitizedTree => _sanitized.Tree;

    public FragmentContentType ContentType => _sanitized.ContentType;

    public IReadOnlyList<FragmentDiagnostic> Diagnostics => _sanitized.Diagnostics;

    [Obsolete("Use SanitizedTree. The HTML projection is empty for host-declared vocabularies.")]
    public string SanitizedSource => _sanitized.Html;

    private FragmentInstance(
        FragmentDeclaration declaration, FormatProfile profile, SanitizedFragment sanitized)
    {
        _declaration = declaration;
        Profile = profile;
        _sanitized = sanitized;
    }

    /// <summary>
    /// Resolves the declaration's format to a vocabulary and sanitizes the source against it.
    /// </summary>
    /// <exception cref="FragmentFormatException">when the format resolves to no vocabulary</exception>
    /// <exception cref="FragmentSanitizeException">when sanitization produces an error-severity finding</exception>
    internal static FragmentInstance Create(
        FragmentDeclaration declaration,
        string source,
        IReadOnlyDictionary<string, JsonElement>? formats,
        IReadOnlyDictionary<string, JsonElement>? vocabularies,
        bool strictHtmlVocabulary,
        Action<FragmentDiagnosticEvent>? onDiagnostic)
    {
        FormatProfile? profile;
        try
        {
            profile = FormatProfiles.Resolve(declaration.Format, formats, vocabularies);
        }
        catch (FormatProfileException ex)
        {
            throw new FragmentFormatException(declaration.Id, declaration.Format, ex.Message);
        }

        if (profile is null)
            throw new FragmentFormatException(declaration.Id, declaration.Format);

        var sanitized = FragmentSanitizer.Sanitize(
            source, profile, strictHtmlVocabulary, declaration.Interpolate == true);

        if (onDiagnostic is not null)
        {
            foreach (var diagnostic in sanitized.Diagnostics)
                onDiagnostic(new FragmentDiagnosticEvent(declaration.Id, diagnostic));
        }

        var errors = sanitized.Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
        if (errors.Count > 0)
            throw new FragmentSanitizeException(declaration.Id, errors);

        return new FragmentInstance(declaration, profile, sanitized);
    }

    public FragmentResult GetContent(Dictionary<string, object?> data)
    {
        var bindings = _declaration.Bindings is { Count: > 0 }
            ? FragmentProcessor.ResolveBindings(_declaration.Bindings, data)
            : new Dictionary<string, object?>();

        var bound = FragmentBinder.Bind(
            _sanitized.Tree, bindings, Profile,
            expression => FragmentProcessor.EvaluateCondition(expression, bindings));

        if (_sanitized.ContentType == FragmentContentType.Tree)
            return new FragmentResult(_declaration.Id, "", bound.Visibility)
            {
                Tree = bound.Tree,
                Conditions = bound.Conditions,
                Format = _declaration.Format,
                ContentType = FragmentContentType.Tree,
                Diagnostics = _sanitized.Diagnostics,
            };

        // The HTML projection is serialized from the bound tree rather than patched into
        // the sanitized source string. One bind pass feeds both outputs, so an
        // expression-valued `data-bind` and a resolved interpolation site reach `Html` and
        // `Tree` identically instead of only the one a regex could see.
        return new FragmentResult(_declaration.Id, FragmentTree.ToHtml(bound.Tree), bound.Visibility)
        {
            Tree = bound.Tree,
            Conditions = bound.Conditions,
            Format = _declaration.Format,
            ContentType = FragmentContentType.Html,
            Diagnostics = _sanitized.Diagnostics,
        };
    }

    public List<FragmentHandlerDeclaration> GetHandlers()
    {
        return _declaration.ResolveHandlers();
    }

    [Obsolete("Use GetHandlers(). The fragment handler array was renamed from 'events' to 'handlers'.")]
    public List<FragmentHandlerDeclaration> GetEvents()
    {
        return GetHandlers();
    }
}
