using System.Text.Json;
using System.Text.RegularExpressions;
using Jint;
using Jint.Native;

namespace Xript.Runtime;

public record FragmentResult(string FragmentId, string Html, Dictionary<string, bool> Visibility);

public record FragmentOp(string Op, string Selector, object? Value = null, string? Attr = null);

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
                issues.Add($"slot '{frag.Slot}' does not accept format '{frag.Format}'");

            if (slot.Capability is not null && !grantedCapabilities.Contains(slot.Capability))
                issues.Add($"slot '{frag.Slot}' requires capability '{slot.Capability}'");
        }

        return issues;
    }

    public static string SanitizeHtml(string input)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        var result = input;

        result = StripElements(result);
        result = UnwrapDocumentElements(result);
        result = SanitizeStyleBlocks(result);
        result = StripDangerousAttributes(result);
        result = SanitizeInlineStyles(result);
        result = SanitizeUris(result);

        return result;
    }

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
            var expression = match.Groups[1].Value;
            visibility[expression] = EvaluateCondition(expression, bindings);
        }

        return visibility;
    }

    public static bool EvaluateCondition(string expression, Dictionary<string, object?> bindings)
    {
        try
        {
            var engine = new Jint.Engine(cfg => cfg.TimeoutInterval(TimeSpan.FromMilliseconds(100)));
            foreach (var (name, value) in bindings)
            {
                if (value is null)
                    engine.SetValue(name, Jint.Native.JsValue.Null);
                else if (value is int intVal)
                    engine.SetValue(name, intVal);
                else if (value is long longVal)
                    engine.SetValue(name, longVal);
                else if (value is double doubleVal)
                    engine.SetValue(name, doubleVal);
                else if (value is float floatVal)
                    engine.SetValue(name, floatVal);
                else if (value is bool boolVal)
                    engine.SetValue(name, boolVal);
                else if (value is string strVal)
                    engine.SetValue(name, strVal);
                else
                    engine.SetValue(name, value.ToString() ?? "");
            }

            var result = engine.Evaluate($"!!({expression})");
            return result.AsBoolean();
        }
        catch
        {
            return false;
        }
    }

    private static readonly string[] StrippedElementNames =
        ["script", "iframe", "object", "embed", "form", "base", "link", "meta", "title", "noscript", "applet", "frame", "frameset", "param"];

    private static string StripElements(string html)
    {
        foreach (var tag in StrippedElementNames)
        {
            var selfClosingPattern = new Regex(
                $@"<{tag}\b[^>]*/\s*>",
                RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = selfClosingPattern.Replace(html, "");

            var fullPattern = new Regex(
                $@"<{tag}\b[^>]*>[\s\S]*?</{tag}\s*>",
                RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = fullPattern.Replace(html, "");

            var openOnlyPattern = new Regex(
                $@"<{tag}\b[^>]*>",
                RegexOptions.IgnoreCase);
            html = openOnlyPattern.Replace(html, "");
        }

        return html;
    }

    private static readonly string[] UnwrappedElementNames = ["html", "head", "body"];

    private static string UnwrapDocumentElements(string html)
    {
        foreach (var tag in UnwrappedElementNames)
        {
            html = Regex.Replace(html, $@"<{tag}\b[^>]*>", "", RegexOptions.IgnoreCase);
            html = Regex.Replace(html, $@"</{tag}\s*>", "", RegexOptions.IgnoreCase);
        }

        return html;
    }

    private static readonly Regex OnEventAttrPattern =
        new(@"\s+on\w+\s*=\s*(?:""[^""]*""|'[^']*'|\S+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex FormActionAttrPattern =
        new(@"\s+(?:formaction|action|method|enctype)\s*=\s*(?:""[^""]*""|'[^']*'|\S+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string StripDangerousAttributes(string html)
    {
        html = Regex.Replace(html, @"(<[a-zA-Z][^>]*?)\s+on\w+\s*=\s*(?:""[^""]*""|'[^']*'|\S+?)([^>]*>)", match =>
        {
            var result = match.Value;
            while (Regex.IsMatch(result, @"<[a-zA-Z][^>]*?\s+on\w+\s*=\s*(?:""[^""]*""|'[^']*'|\S+)"))
            {
                result = Regex.Replace(result, @"(\s+)on\w+\s*=\s*(?:""[^""]*""|'[^']*'|\S+?)", "", RegexOptions.IgnoreCase);
            }
            return result;
        }, RegexOptions.IgnoreCase | RegexOptions.Singleline);

        return html;
    }

    private static readonly Regex JavascriptUriInHrefPattern =
        new(@"(<[^>]*?\s+href\s*=\s*"")(\s*(?:javascript|vbscript)\s*:[^""]*)("")", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex JavascriptUriInSrcPattern =
        new(@"(<[^>]*?\s+src\s*=\s*"")(\s*(?:javascript|vbscript)\s*:[^""]*)("")", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex DangerousDataUriInSrcPattern =
        new(@"(<[^>]*?\s+src\s*=\s*"")(data:(?!image/(?:png|jpeg|gif|svg\+xml)[;,])[^""]*)("")", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string SanitizeUris(string html)
    {
        html = Regex.Replace(html, @"(<[^>]*?)\s+href\s*=\s*""(\s*(?:javascript|vbscript)\s*:[^""]*)""([^>]*>)",
            "$1$3", RegexOptions.IgnoreCase);

        html = Regex.Replace(html, @"(<[^>]*?)\s+src\s*=\s*""(\s*(?:javascript|vbscript)\s*:[^""]*)""([^>]*>)",
            "$1$3", RegexOptions.IgnoreCase);

        html = Regex.Replace(html, @"(<[^>]*?)\s+src\s*=\s*""(data:(?!image/(?:png|jpeg|gif|svg\+xml)[;,])[^""]*)""([^>]*>)",
            "$1$3", RegexOptions.IgnoreCase);

        return html;
    }

    private static readonly Regex StyleBlockPattern =
        new(@"(<style\b[^>]*>)([\s\S]*?)(</style\s*>)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex[] DangerousStylePatterns =
    [
        new(@"url\s*\([^)]*\)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"expression\s*\([^)]*\)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"-moz-binding\s*:[^;}""]* ", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"behavior\s*:[^;}""]* ", RegexOptions.IgnoreCase | RegexOptions.Compiled),
    ];

    private static string SanitizeStyleBlocks(string html)
    {
        return StyleBlockPattern.Replace(html, match =>
        {
            var openTag = match.Groups[1].Value;
            var css = match.Groups[2].Value;
            var closeTag = match.Groups[3].Value;

            css = CleanStyleContent(css);

            css = CleanCssDeclarationBlocks(css);

            return $"{openTag}{css}{closeTag}";
        });
    }

    private static string CleanStyleContent(string css)
    {
        foreach (var pattern in DangerousStylePatterns)
            css = pattern.Replace(css, "");
        return css;
    }

    private static string CleanCssDeclarationBlocks(string css)
    {
        return Regex.Replace(css, @"\{([^}]*)\}", match =>
        {
            var block = match.Groups[1].Value;
            var declarations = block.Split(';')
                .Select(d => d.Trim())
                .Where(d =>
                {
                    if (string.IsNullOrEmpty(d)) return false;
                    var colonIdx = d.IndexOf(':');
                    if (colonIdx < 0) return false;
                    var value = d[(colonIdx + 1)..].Trim();
                    return value.Length > 0;
                })
                .ToList();

            if (declarations.Count == 0)
                return "{}";

            return "{ " + string.Join("; ", declarations) + "; }";
        });
    }

    private static readonly Regex InlineStylePattern =
        new(@"(<[^>]*?\s+style\s*=\s*"")((?:[^""])*)(""[^>]*>)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string SanitizeInlineStyles(string html)
    {
        return InlineStylePattern.Replace(html, match =>
        {
            var prefix = match.Groups[1].Value;
            var styleValue = match.Groups[2].Value;
            var suffix = match.Groups[3].Value;

            var cleaned = styleValue;
            foreach (var pattern in DangerousStylePatterns)
                cleaned = pattern.Replace(cleaned, "");
            cleaned = cleaned.Trim();

            if (string.IsNullOrEmpty(cleaned))
                return Regex.Replace(match.Value, @"\s*style\s*=\s*""[^""]*""", "");

            return $"{prefix}{cleaned}{suffix}";
        });
    }
}

public sealed class ModInstance
{
    private static int _idCounter;

    public string Id { get; }
    public string Name { get; }
    public string Version { get; }
    public List<FragmentInstance> Fragments { get; }

    public ModInstance(ModManifest mod, Dictionary<string, string>? fragmentSources)
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

            var sanitized = FragmentProcessor.SanitizeHtml(source);
            Fragments.Add(new FragmentInstance(decl, sanitized));
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
    private readonly string _sanitizedSource;

    public string Id => _declaration.Id;
    public string Slot => _declaration.Slot;
    public string Format => _declaration.Format;
    public int Priority => _declaration.Priority ?? 0;

    internal FragmentInstance(FragmentDeclaration declaration, string sanitizedSource)
    {
        _declaration = declaration;
        _sanitizedSource = sanitizedSource;
    }

    public FragmentResult GetContent(Dictionary<string, object?> data)
    {
        var bindings = _declaration.Bindings is { Count: > 0 }
            ? FragmentProcessor.ResolveBindings(_declaration.Bindings, data)
            : new Dictionary<string, object?>();

        return FragmentProcessor.ProcessFragment(_declaration.Id, _sanitizedSource, bindings);
    }

    public List<FragmentEventDeclaration> GetEvents()
    {
        return _declaration.Events ?? [];
    }
}
