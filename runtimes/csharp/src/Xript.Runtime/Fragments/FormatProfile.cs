using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xript.Runtime.Fragments;

public enum FragmentSyntax
{
    Html,
    J5ml,
}

/// <summary>
/// Where a prop's value lands. This -- not the node's name -- is the only thing
/// sanitization ever needed to know.
/// </summary>
public enum Sink
{
    Text,
    Uri,
    ImageUri,
    Css,
    Html,
}

public static class SinkNames
{
    public static string ToWireName(this Sink sink) => sink switch
    {
        Sink.Uri => "uri",
        Sink.ImageUri => "image-uri",
        Sink.Css => "css",
        Sink.Html => "html",
        _ => "text",
    };

    public static Sink Parse(string? name) => name switch
    {
        "uri" => Sink.Uri,
        "image-uri" => Sink.ImageUri,
        "css" => Sink.Css,
        "html" => Sink.Html,
        _ => Sink.Text,
    };
}

/// <summary>A JSON Schema body plus the reserved <c>sink</c> keyword.</summary>
public sealed record PropDefinition
{
    public Sink Sink { get; init; } = Sink.Text;

    /// <summary>The JSON Schema <c>type</c> keyword, if declared. One or more type names.</summary>
    public IReadOnlyList<string>? Type { get; init; }

    /// <summary>Whether <c>type</c> was declared as a list, which changes the diagnostic text.</summary>
    public bool TypeIsList { get; init; }

    public string DescribeType()
    {
        if (Type is null) return "null";
        var quoted = Type.Select(name => JsonSerializer.Serialize(name));
        return TypeIsList ? "[" + string.Join(",", quoted) + "]" : quoted.First();
    }
}

public enum ChildrenKind
{
    Any,
    None,
    Text,
    List,
}

public sealed record ChildrenConstraint(ChildrenKind Kind, IReadOnlyList<string>? Names = null)
{
    public static readonly ChildrenConstraint Any = new(ChildrenKind.Any);

    public bool TextAllowed => Kind is ChildrenKind.Any or ChildrenKind.Text;

    public bool Allows(string name) => Kind switch
    {
        ChildrenKind.Any => true,
        ChildrenKind.List => Names is not null && Names.Contains(name, StringComparer.Ordinal),
        _ => false,
    };

    public string Describe() => Kind switch
    {
        ChildrenKind.Any => "any",
        ChildrenKind.None => "none",
        ChildrenKind.Text => "text",
        _ => string.Join(", ", Names ?? []),
    };
}

public sealed record NodeDefinition
{
    public string? Description { get; init; }

    public IReadOnlyDictionary<string, PropDefinition> Props { get; init; } =
        new Dictionary<string, PropDefinition>(StringComparer.Ordinal);

    /// <summary>Declaration order of <see cref="Props"/>, which a conflicting-sink report follows.</summary>
    public IReadOnlyList<string> PropOrder { get; init; } = [];

    public ChildrenConstraint Children { get; init; } = ChildrenConstraint.Any;

    public string? BindTo { get; init; }
}

/// <summary>
/// Why a format declaration was refused. Callers that report rather than throw need to tell
/// an undeclared vocabulary reference apart from a malformed scope without reading the
/// message text.
/// </summary>
public enum FormatProfileErrorCode
{
    Malformed,
    UnknownSyntax,
    UnknownVocabulary,
    HtmlNotLast,
    EmptyScope,
    StrippedNameShadowed,
    InvalidSchemes,
    ProhibitedScheme,
}

public static class FormatProfileErrorCodes
{
    public static string ToWireName(this FormatProfileErrorCode code) => code switch
    {
        FormatProfileErrorCode.UnknownSyntax => "unknown-syntax",
        FormatProfileErrorCode.UnknownVocabulary => "unknown-vocabulary",
        FormatProfileErrorCode.HtmlNotLast => "html-not-last",
        FormatProfileErrorCode.EmptyScope => "empty-scope",
        FormatProfileErrorCode.StrippedNameShadowed => "stripped-name-shadowed",
        FormatProfileErrorCode.InvalidSchemes => "invalid-schemes",
        FormatProfileErrorCode.ProhibitedScheme => "prohibited-scheme",
        _ => "malformed",
    };
}

public sealed class FormatProfileException : Exception
{
    public string Format { get; }

    public FormatProfileErrorCode Code { get; }

    public FormatProfileException(
        string format, string message, FormatProfileErrorCode code = FormatProfileErrorCode.Malformed)
        : base(message)
    {
        Format = format;
        Code = code;
    }
}

/// <summary>
/// One vocabulary in a format's resolved scope. A declared vocabulary carries its own nodes
/// and, when it came from the manifest's <c>vocabularies</c> block rather than a format's
/// inline <c>nodes</c>, the id it was declared under.
/// </summary>
public abstract record ResolvedVocabulary
{
    public sealed record Declared(
        string? Id,
        IReadOnlyDictionary<string, NodeDefinition> Nodes,
        IReadOnlyList<string> NodeOrder) : ResolvedVocabulary;

    public sealed record BuiltinHtml : ResolvedVocabulary;
}

public sealed record FormatProfile
{
    public string Id { get; init; } = "";

    public FragmentSyntax Syntax { get; init; }

    /// <summary>
    /// The vocabularies in scope, in resolution order: the first to claim a node name wins.
    /// </summary>
    public IReadOnlyList<ResolvedVocabulary> Scope { get; init; } = [];

    /// <summary>
    /// The URI schemes a <c>uri</c> or <c>image-uri</c> value may name, lowercase and without
    /// the colon. Absolute URIs naming anything else are dropped; relative values carry no
    /// scheme and are unaffected. Empty means deliberate closure: no absolute URIs at all.
    /// </summary>
    public IReadOnlySet<string> Schemes { get; init; } = HtmlRules.DefaultUriSchemeSet;

    /// <summary>True for the four reserved built-in profiles. Drives <c>contentType</c>.</summary>
    public bool Builtin { get; init; }

    /// <summary>
    /// Every declared node in scope, walked vocabulary by vocabulary and, within each, in
    /// declaration order. Derived from <see cref="Scope"/> rather than stored, so a
    /// conflicting-sink report cannot follow an order the other runtimes do not have.
    /// </summary>
    public IReadOnlyList<(int VocabularyIndex, string Name)> ScopeNodeOrder
    {
        get
        {
            var order = new List<(int, string)>();
            for (var index = 0; index < Scope.Count; index++)
            {
                if (Scope[index] is not ResolvedVocabulary.Declared declared) continue;
                foreach (var name in declared.NodeOrder) order.Add((index, name));
            }
            return order;
        }
    }

    /// <summary>Whether the built-in HTML vocabulary is anywhere in scope.</summary>
    public bool SpeaksHtml => Scope.Any(entry => entry is ResolvedVocabulary.BuiltinHtml);

    /// <summary>Whether any declared vocabulary in scope owns <paramref name="name"/> verbatim.</summary>
    public bool AnyVocabularyDeclares(string name) => NodeDefinition(name) is not null;

    /// <summary>
    /// The definition the first vocabulary in scope claiming <paramref name="name"/> gives it.
    /// Names are matched verbatim and case-sensitively; the built-in HTML vocabulary is not
    /// consulted, since it resolves tags rather than declaring nodes.
    /// </summary>
    public NodeDefinition? NodeDefinition(string name)
    {
        foreach (var entry in Scope)
        {
            if (entry is not ResolvedVocabulary.Declared declared) continue;
            if (declared.Nodes.TryGetValue(name, out var definition)) return definition;
        }
        return null;
    }
}

public static class FormatProfiles
{
    /// <summary>Props legal on every node of every vocabulary. Always strings, never sanitized, never dropped.</summary>
    public static readonly HashSet<string> ProtocolProps =
        new(["id", "data-bind", "data-if", "data-each", "data-key"], StringComparer.Ordinal);

    public static readonly IReadOnlyList<string> BuiltinFormatIds =
        ["text/html", "text/html+jsml", "application/j5ml+json", "application/jsml+json"];

    /// <summary>Slot content types that are not fragments at all and are never sanitized.</summary>
    public static readonly IReadOnlyList<string> NonFragmentFormatIds =
        ["application/x-xript-role", "application/x-xript-hook", "application/x-xript-command"];

    /// <summary>Format ids a host may not declare in its own <c>formats</c> block.</summary>
    public static readonly HashSet<string> ReservedFormatIds =
        new([.. BuiltinFormatIds, .. NonFragmentFormatIds], StringComparer.Ordinal);

    /// <summary>The only vocabulary a format may name without declaring it.</summary>
    public static readonly IReadOnlyList<string> BuiltinVocabularyIds = ["html"];

    private static readonly IReadOnlyList<ResolvedVocabulary> BuiltinHtmlScope =
        [new ResolvedVocabulary.BuiltinHtml()];

    public static readonly IReadOnlyDictionary<string, FormatProfile> Builtins =
        new Dictionary<string, FormatProfile>(StringComparer.Ordinal)
        {
            ["text/html"] = new()
            {
                Id = "text/html",
                Syntax = FragmentSyntax.Html,
                Scope = BuiltinHtmlScope,
                Builtin = true,
            },
            ["text/html+jsml"] = new()
            {
                Id = "text/html+jsml",
                Syntax = FragmentSyntax.Html,
                Scope = BuiltinHtmlScope,
                Builtin = true,
            },
            ["application/j5ml+json"] = new()
            {
                Id = "application/j5ml+json",
                Syntax = FragmentSyntax.J5ml,
                Scope = BuiltinHtmlScope,
                Builtin = true,
            },
            ["application/jsml+json"] = new()
            {
                Id = "application/jsml+json",
                Syntax = FragmentSyntax.J5ml,
                Scope = BuiltinHtmlScope,
                Builtin = true,
            },
        };

    /// <summary>
    /// Resolves a media type to the vocabularies a fragment of that type may speak.
    /// Built-in ids always win, so a host restating one is ignored rather than rejected.
    /// </summary>
    /// <param name="format">the fragment's media type</param>
    /// <param name="formats">the host manifest's <c>formats</c> block, if it declares one</param>
    /// <param name="vocabularies">the host manifest's <c>vocabularies</c> block, if it declares one</param>
    /// <returns>the profile, or <c>null</c> when the format is unknown</returns>
    /// <exception cref="FormatProfileException">when the format is declared but malformed</exception>
    public static FormatProfile? Resolve(
        string format,
        IReadOnlyDictionary<string, JsonElement>? formats,
        IReadOnlyDictionary<string, JsonElement>? vocabularies)
    {
        if (Builtins.TryGetValue(format, out var builtin)) return builtin;

        if (formats is null || !formats.TryGetValue(format, out var declaration)) return null;

        var node = JsonNode.Parse(declaration.GetRawText());
        if (node is not JsonObject obj)
            throw new FormatProfileException(format, $"fragment format \"{format}\" is not an object");

        var hasSyntax = obj.ContainsKey("syntax");
        var syntaxRaw = hasSyntax ? obj["syntax"] : null;
        var syntaxName = AsString(syntaxRaw);
        if (syntaxName is not ("html" or "j5ml" or "jsml"))
            throw new FormatProfileException(
                format,
                $"fragment format \"{format}\" declares an unknown syntax: {Describe(hasSyntax, syntaxRaw)}",
                FormatProfileErrorCode.UnknownSyntax);

        var schemes = ParseSchemes(obj, format);

        var scope = new List<ResolvedVocabulary>();

        if (obj.ContainsKey("nodes"))
            scope.Add(ParseVocabulary(null, obj["nodes"], format, $"fragment format \"{format}\""));

        if (obj.ContainsKey("vocabularies"))
        {
            var refs = obj["vocabularies"];
            if (refs is not JsonArray refArray)
                throw new FormatProfileException(
                    format, $"fragment format \"{format}\" declares a non-array 'vocabularies'");

            foreach (var entry in refArray)
            {
                if (AsString(entry) is not { } reference)
                    throw new FormatProfileException(
                        format,
                        $"fragment format \"{format}\" references a non-string vocabulary: {(entry is null ? "null" : entry.ToJsonString())}");

                if (BuiltinVocabularyIds.Contains(reference, StringComparer.Ordinal))
                {
                    scope.Add(new ResolvedVocabulary.BuiltinHtml());
                    continue;
                }

                if (vocabularies is not null && vocabularies.TryGetValue(reference, out var declared))
                {
                    if (JsonNode.Parse(declared.GetRawText()) is not JsonObject declaredObj)
                        throw new FormatProfileException(
                            format, $"vocabulary \"{reference}\" is not an object");
                    scope.Add(ParseVocabulary(
                        reference,
                        declaredObj.TryGetPropertyValue("nodes", out var vocabularyNodes) ? vocabularyNodes : null,
                        format,
                        $"vocabulary \"{reference}\""));
                    continue;
                }

                if (!reference.Contains('.'))
                    throw new FormatProfileException(
                        format,
                        $"fragment format \"{format}\" references \"{reference}\", which is not a built-in vocabulary (built-ins: {string.Join(", ", BuiltinVocabularyIds)}); a host-declared vocabulary id needs two or more dot-separated segments",
                        FormatProfileErrorCode.UnknownVocabulary);

                throw new FormatProfileException(
                    format,
                    $"fragment format \"{format}\" references an undeclared vocabulary: \"{reference}\"",
                    FormatProfileErrorCode.UnknownVocabulary);
            }
        }

        var htmlIndex = scope.FindIndex(entry => entry is ResolvedVocabulary.BuiltinHtml);
        if (htmlIndex >= 0 && htmlIndex != scope.Count - 1)
            throw new FormatProfileException(
                format,
                $"fragment format \"{format}\" lists the built-in html vocabulary before a declared vocabulary; html must be last so declared nodes always win",
                FormatProfileErrorCode.HtmlNotLast);

        if (scope.Count == 0)
            throw new FormatProfileException(
                format,
                $"fragment format \"{format}\" declares no vocabulary and admits no nodes",
                FormatProfileErrorCode.EmptyScope);

        if (htmlIndex >= 0)
        {
            foreach (var entry in scope)
            {
                if (entry is not ResolvedVocabulary.Declared vocabulary) continue;
                foreach (var name in vocabulary.NodeOrder)
                {
                    if (!HtmlRules.StrippedElements.Contains(name.ToLowerInvariant())) continue;
                    throw new FormatProfileException(
                        format,
                        $"fragment format \"{format}\" brings a vocabulary declaring \"{name}\" into scope alongside the built-in html vocabulary; \"{name}\" is an element the sanitizer always strips and may not be shadowed",
                        FormatProfileErrorCode.StrippedNameShadowed);
                }
            }
        }

        return new FormatProfile
        {
            Id = format,
            Syntax = syntaxName is "j5ml" or "jsml" ? FragmentSyntax.J5ml : FragmentSyntax.Html,
            Scope = scope,
            Schemes = schemes,
            Builtin = false,
        };
    }

    /// <summary>
    /// Reads a format's <c>schemes</c> into the effective scheme set.
    ///
    /// Absent means the default safe set. Present replaces it wholesale, so a host both
    /// widens and narrows through the same key, and <c>[]</c> is deliberate closure rather
    /// than a shorthand for the default. Naming <c>javascript</c> or <c>vbscript</c> is
    /// refused outright: dropping them silently would let a host believe it had granted
    /// something it had not, and the whole point of the floor is that no host can argue
    /// its way under it.
    /// </summary>
    private static IReadOnlySet<string> ParseSchemes(JsonObject obj, string format)
    {
        if (!obj.ContainsKey("schemes")) return HtmlRules.DefaultUriSchemeSet;

        if (obj["schemes"] is not JsonArray array)
            throw new FormatProfileException(
                format,
                $"fragment format \"{format}\" declares a non-array 'schemes'",
                FormatProfileErrorCode.InvalidSchemes);

        var schemes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in array)
        {
            if (AsString(entry) is not { } declared)
                throw new FormatProfileException(
                    format,
                    $"fragment format \"{format}\" declares a non-string scheme: {(entry is null ? "null" : entry.ToJsonString())}",
                    FormatProfileErrorCode.InvalidSchemes);

            var scheme = declared.ToLowerInvariant();
            if (HtmlRules.ProhibitedUriSchemes.Contains(scheme))
                throw new FormatProfileException(
                    format,
                    $"fragment format \"{format}\" declares the prohibited scheme \"{scheme}\"; it is refused in every fragment and cannot be allow-listed",
                    FormatProfileErrorCode.ProhibitedScheme);

            if (!HtmlRules.UriSchemeNamePattern.IsMatch(scheme))
                throw new FormatProfileException(
                    format,
                    $"fragment format \"{format}\" declares a malformed scheme: {JsonSerializer.Serialize(declared)}; a scheme is a lowercase name with no colon",
                    FormatProfileErrorCode.InvalidSchemes);

            schemes.Add(scheme);
        }

        return schemes;
    }

    private static ResolvedVocabulary.Declared ParseVocabulary(
        string? id, JsonNode? rawNodes, string format, string origin)
    {
        if (rawNodes is not JsonObject nodeMap)
            throw new FormatProfileException(format, $"{origin} declares a non-object 'nodes'");

        var nodes = new Dictionary<string, NodeDefinition>(StringComparer.Ordinal);
        var nodeOrder = new List<string>();

        foreach (var (name, definition) in nodeMap)
        {
            if (definition is not JsonObject nodeObj)
                throw new FormatProfileException(format, $"{origin} declares a non-object node: {name}");
            nodes[name] = ParseNode(nodeObj);
            nodeOrder.Add(name);
        }

        return new ResolvedVocabulary.Declared(id, nodes, nodeOrder);
    }

    private static NodeDefinition ParseNode(JsonObject node)
    {
        var props = new Dictionary<string, PropDefinition>(StringComparer.Ordinal);
        var propOrder = new List<string>();

        if (node["props"] is JsonObject propMap)
        {
            foreach (var (name, definition) in propMap)
            {
                props[name] = definition is JsonObject propObj ? ParseProp(propObj) : new PropDefinition();
                propOrder.Add(name);
            }
        }

        return new NodeDefinition
        {
            Description = AsString(node["description"]),
            Props = props,
            PropOrder = propOrder,
            Children = ParseChildren(node.ContainsKey("children") ? node["children"] : null),
            BindTo = AsString(node["bindTo"]),
        };
    }

    private static PropDefinition ParseProp(JsonObject prop)
    {
        IReadOnlyList<string>? type = null;
        var typeIsList = false;

        switch (prop.ContainsKey("type") ? prop["type"] : null)
        {
            case JsonArray array:
                type = [.. array.Select(AsString).Where(name => name is not null).Select(name => name!)];
                typeIsList = true;
                break;
            case JsonValue value when AsString(value) is { } name:
                type = [name];
                break;
        }

        return new PropDefinition
        {
            Sink = SinkNames.Parse(AsString(prop["sink"])),
            Type = type,
            TypeIsList = typeIsList,
        };
    }

    private static ChildrenConstraint ParseChildren(JsonNode? children)
    {
        switch (children)
        {
            case JsonArray array:
                return new ChildrenConstraint(
                    ChildrenKind.List,
                    [.. array.Select(AsString).Where(name => name is not null).Select(name => name!)]);
            case JsonValue value:
                return AsString(value) switch
                {
                    "none" => new ChildrenConstraint(ChildrenKind.None),
                    "text" => new ChildrenConstraint(ChildrenKind.Text),
                    _ => ChildrenConstraint.Any,
                };
            default:
                return ChildrenConstraint.Any;
        }
    }

    private static string? AsString(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        if (value.TryGetValue<string>(out var direct)) return direct;
        if (value.TryGetValue<JsonElement>(out var element) && element.ValueKind == JsonValueKind.String)
            return element.GetString();
        return null;
    }

    private static string Describe(bool present, JsonNode? node) =>
        !present ? "undefined" : node is null ? "null" : node.ToJsonString();
}
