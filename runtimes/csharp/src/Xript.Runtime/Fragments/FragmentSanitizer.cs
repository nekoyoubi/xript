using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xript.Runtime.Fragments;

public enum FragmentContentType
{
    Html,
    Tree,
}

public sealed record SanitizedFragment(
    List<FragmentNode> Tree,
    string Html,
    FragmentContentType ContentType,
    List<FragmentDiagnostic> Diagnostics,
    List<string> StrippedElements,
    List<StrippedAttribute> StrippedAttributes);

public sealed class FragmentParseException : Exception
{
    public string Format { get; }

    public FragmentParseException(string format, string message) : base(message)
    {
        Format = format;
    }
}

public static class FragmentSanitizer
{
    /// <summary>
    /// The hyphenated names SVG and MathML already define, which a browser does not
    /// resolve as custom elements.
    /// </summary>
    private static readonly HashSet<string> ReservedHyphenatedNames = new(StringComparer.Ordinal)
    {
        "annotation-xml", "color-profile", "font-face", "font-face-src",
        "font-face-uri", "font-face-format", "font-face-name", "missing-glyph",
    };

    /// <summary>
    /// A name a browser resolves as a custom element: it carries a hyphen, starts with
    /// an ASCII letter, and is not one of the names SVG and MathML define.
    /// </summary>
    private static bool IsCustomElementName(string name)
    {
        var lower = name.ToLowerInvariant();
        if (lower.Length == 0 || lower[0] < 'a' || lower[0] > 'z') return false;
        if (!lower.Contains('-')) return false;
        foreach (var c in lower)
            if (!(c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '.' or '_')) return false;
        return !ReservedHyphenatedNames.Contains(lower);
    }

    /// <summary>
    /// Whether a format has a meaningful HTML projection.
    /// </summary>
    /// <remarks>
    /// Built-in formats always do. A host-declared format does when it is HTML plus custom
    /// elements: the built-in <c>html</c> vocabulary is in scope, and every node every other
    /// vocabulary in scope declares is a valid custom element name. Those names mean
    /// something to a browser, so the tree serializes to markup a host can mount directly
    /// instead of walking it first.
    ///
    /// Both halves are load-bearing. A scope without HTML carries no HTML meaning at all.
    /// And a vocabulary that declares a name HTML already owns, or one a browser would not
    /// treat as a custom element, must not project: a declared node named <c>style</c> would
    /// become a live style element, and a name without a hyphen is inert markup rather than a
    /// component. The scan spans every vocabulary in scope, not just the format's inline
    /// nodes, so a referenced vocabulary cannot smuggle a bare <c>&lt;Panel&gt;</c> into
    /// projected markup.
    /// </remarks>
    private static bool ProjectsToHtml(FormatProfile profile)
    {
        if (profile.Builtin) return true;
        if (!profile.SpeaksHtml) return false;
        foreach (var entry in profile.Scope)
        {
            if (entry is not ResolvedVocabulary.Declared vocabulary) continue;
            foreach (var name in vocabulary.NodeOrder)
                if (!IsCustomElementName(name)) return false;
        }
        return true;
    }

    /// <summary>
    /// Sanitizes a fragment source against the vocabulary its format declares.
    /// </summary>
    /// <param name="source">the fragment source, in the format's syntax</param>
    /// <param name="profile">the resolved format profile</param>
    /// <param name="strictVocabulary">promotes built-in vocabulary warnings to errors</param>
    /// <param name="interpolate">segments <c>{{ expr }}</c> sites in text nodes</param>
    /// <exception cref="FragmentParseException">when a <c>jsml</c>-syntax source is not valid JSON</exception>
    public static SanitizedFragment Sanitize(
        string source, FormatProfile profile, bool strictVocabulary = false, bool interpolate = false)
    {
        if (profile.Syntax == FragmentSyntax.J5ml)
        {
            var jsml = VocabularySanitizer.Sanitize(
                FragmentTree.FromJsml(ParseJsmlSource(source, profile.Id)), profile, strictVocabulary,
                interpolate);
            return new SanitizedFragment(
                jsml.Tree,
                ProjectsToHtml(profile) ? FragmentTree.ToHtml(jsml.Tree) : "",
                profile.Builtin ? FragmentContentType.Html : FragmentContentType.Tree,
                jsml.Diagnostics,
                jsml.StrippedElements,
                jsml.StrippedAttributes);
        }

        var parsed = VocabularySanitizer.Sanitize(
            HtmlReader.ToTree(source, profile), profile, strictVocabulary, interpolate);

        if (!profile.Builtin)
            return new SanitizedFragment(
                parsed.Tree,
                ProjectsToHtml(profile) ? FragmentTree.ToHtml(parsed.Tree) : "",
                FragmentContentType.Tree,
                parsed.Diagnostics, parsed.StrippedElements, parsed.StrippedAttributes);

        // `html` is serialized from the sanitized tree rather than scanned out of the
        // source a second time, so the markup a host mounts and the report of what was
        // removed are decided by one traversal. A string pass that patches the input
        // can emit unbalanced markup when the source leaves an element unclosed.
        return new SanitizedFragment(
            parsed.Tree,
            FragmentTree.ToHtml(parsed.Tree),
            FragmentContentType.Html,
            parsed.Diagnostics,
            parsed.StrippedElements,
            parsed.StrippedAttributes);
    }

    /// <summary>
    /// Parses a JSML source string into the J5ML node list the tree builder expects.
    /// A bare element (<c>["div", ...]</c>) and a node list (<c>[["div"], ["p"]]</c>)
    /// are both accepted.
    /// </summary>
    public static List<JsonNode?> ParseJsmlSource(string source, string format = "application/jsml+json")
    {
        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(source);
        }
        catch (JsonException)
        {
            throw new FragmentParseException(format, "invalid JSON");
        }

        if (parsed is JsonArray array)
        {
            if (array.Count > 0 && array[0] is JsonValue first && IsString(first))
                return [parsed];
            return [.. array];
        }

        return [parsed];
    }

    private static bool IsString(JsonValue value)
    {
        if (value.TryGetValue<string>(out _)) return true;
        return value.TryGetValue<JsonElement>(out var element) && element.ValueKind == JsonValueKind.String;
    }
}
