using System.Text.RegularExpressions;

namespace Xript.Runtime.Fragments;

/// <summary>
/// The built-in HTML vocabulary: which elements and attributes are legal, and how
/// the three value sinks HTML exposes (<c>href</c>/<c>src</c>, <c>style</c>) are cleaned.
/// </summary>
public static class HtmlRules
{
    public static readonly HashSet<string> AllowedElements = new(StringComparer.Ordinal)
    {
        "div", "span", "p",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li", "dl", "dt", "dd",
        "table", "thead", "tbody", "tfoot", "tr", "td", "th",
        "caption", "col", "colgroup",
        "figure", "figcaption", "blockquote", "pre", "code",
        "em", "strong", "b", "i", "u", "s", "small", "sub", "sup",
        "br", "hr",
        "img", "picture", "source", "audio", "video", "track",
        "details", "summary", "dialog",
        "canvas", "kbd", "slot",
        "section", "article", "aside", "nav",
        "header", "footer", "main",
        "a", "abbr", "mark", "time", "wbr",
        "style",
        "input", "textarea", "select", "option", "label",
        "button", "progress", "meter", "output", "fieldset", "legend",
        "svg", "g", "defs", "symbol", "use",
        "circle", "ellipse", "path", "rect", "line", "polygon", "polyline",
        "text", "tspan",
    };

    public static readonly HashSet<string> StrippedElements = new(StringComparer.Ordinal)
    {
        "script", "iframe", "object", "embed", "form",
        "base", "link", "meta", "title",
        "noscript", "applet", "frame", "frameset",
        "param",
        "foreignobject", "animate", "set",
    };

    /// <summary>
    /// Elements whose content the HTML parser reads as raw text rather than markup.
    /// An unclosed one genuinely does run to the end of input, so skipping to EOF is
    /// correct for these and only for these.
    /// </summary>
    public static readonly HashSet<string> RawTextElements = new(StringComparer.Ordinal)
    {
        "script", "style", "title", "textarea",
        "noscript", "iframe", "xmp", "noembed", "noframes",
    };

    /// <summary>
    /// SVG's text-content metadata elements. <c>title</c> is stripped as HTML's document
    /// title, but inside an SVG it is the accessible name and tooltip primitive, and
    /// <c>desc</c> is its longer description. Both are admitted only under an
    /// <c>&lt;svg&gt;</c>, hold text alone, and carry only <see cref="SvgTextAttributes"/>.
    /// </summary>
    public static readonly HashSet<string> SvgTextElements =
        new(["title", "desc"], StringComparer.Ordinal);

    /// <summary>The attributes an SVG <c>title</c>/<c>desc</c> keeps, beyond the inert <c>data-*</c> and <c>aria-*</c>.</summary>
    public static readonly HashSet<string> SvgTextAttributes =
        new(["id", "class", "lang", "dir"], StringComparer.Ordinal);

    public static readonly HashSet<string> UnwrappedElements =
        new(["html", "head", "body"], StringComparer.Ordinal);

    public static readonly HashSet<string> VoidElements = new(StringComparer.Ordinal)
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    };

    public static readonly HashSet<string> AllowedAttributes = new(StringComparer.Ordinal)
    {
        "class", "id", "style",
        "role", "tabindex", "hidden",
        "src", "alt", "width", "height",
        "href", "target", "rel",
        "colspan", "rowspan", "scope", "headers",
        "lang", "dir", "title",
        "part", "slot", "spellcheck", "inputmode", "autocomplete",
        "abbr", "align", "label", "loading", "decoding",
        "popover", "popovertarget",
        "type", "value", "placeholder", "name", "for",
        "checked", "disabled", "readonly", "required",
        "rows", "cols", "maxlength", "minlength",
        "min", "max", "step", "pattern",
        "open", "low", "high", "optimum",
        "cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2", "points", "d",
        "fill", "stroke", "stroke-width", "opacity", "transform",
        "rx", "ry", "dy", "dx", "focusable", "shape-rendering", "text-anchor",
        "stroke-linecap", "stroke-linejoin", "vector-effect",
        "viewbox", "preserveaspectratio", "xmlns",
    };

    private static readonly Dictionary<string, string> CaseSensitiveAttributes =
        new(StringComparer.Ordinal)
        {
            ["viewbox"] = "viewBox",
            ["preserveaspectratio"] = "preserveAspectRatio",
        };

    /// <summary>
    /// Schemes no host may allow-list. A host that names one of these is declaring an
    /// XSS sink, so the declaration is refused rather than quietly dropped from its set.
    /// </summary>
    public static readonly IReadOnlySet<string> ProhibitedUriSchemes =
        new HashSet<string>(["javascript", "vbscript"], StringComparer.Ordinal);

    /// <summary>
    /// The scheme set a fragment format gets when it declares none. A host widens or
    /// narrows it by declaring <c>schemes</c>, which replaces this list wholesale.
    /// </summary>
    public static readonly IReadOnlyList<string> DefaultUriSchemes =
        ["http", "https", "mailto", "data"];

    public static readonly IReadOnlySet<string> DefaultUriSchemeSet =
        new HashSet<string>(DefaultUriSchemes, StringComparer.Ordinal);

    /// <summary>
    /// A leading scheme. Whitespace before the colon is tolerated so a value cannot dodge
    /// the allow-list by padding a scheme a browser would still resolve; a value that
    /// matches nothing here carries no scheme at all and is relative.
    /// </summary>
    private static readonly Regex UriSchemePattern =
        new(@"^([a-z][a-z0-9+.-]*)\s*:", RegexOptions.Compiled);

    /// <summary>
    /// A well-formed scheme name: lowercase, no colon. Anchored with <c>\z</c> rather than
    /// <c>$</c> so a trailing newline cannot pass, which is what the equivalent JavaScript
    /// pattern does.
    /// </summary>
    public static readonly Regex UriSchemeNamePattern =
        new(@"^[a-z][a-z0-9+.-]*\z", RegexOptions.Compiled);

    public static readonly Regex SafeDataImagePattern =
        new(@"^data:image/(png|jpeg|gif|svg\+xml)[;,]", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly char[] TrimmedUriChars =
        Enumerable.Range(0, 33).Select(c => (char)c).ToArray();

    private static readonly Regex[] DangerousStylePatterns =
    [
        new(@"url\s*\([^)]*\)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"expression\s*\([^)]*\)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"-moz-binding\s*:[^;}""']*", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"behavior\s*:[^;}""']*", RegexOptions.IgnoreCase | RegexOptions.Compiled),
    ];

    /// <summary>
    /// A well-formed attribute/prop name. Rejects any name carrying an attribute-list
    /// delimiter, which would let a crafted JSON key break out of the attribute list when
    /// serialized. The HTML tokenizer can never emit such a name, but a JSON-keyed source can.
    /// </summary>
    private static readonly Regex AttributeNamePattern =
        new(@"^[A-Za-z][A-Za-z0-9_.:-]*$", RegexOptions.Compiled);

    private static readonly Regex CssDeclarationBlockPattern =
        new(@"\{([^}]*)\}", RegexOptions.Compiled);

    public static bool IsValidAttributeName(string name) => AttributeNamePattern.IsMatch(name);

    public static bool IsAllowedAttribute(string name)
    {
        if (name.StartsWith("data-", StringComparison.Ordinal)) return true;
        if (name.StartsWith("aria-", StringComparison.Ordinal)) return true;
        if (name.StartsWith("on", StringComparison.Ordinal)) return false;
        return AllowedAttributes.Contains(name);
    }

    public static string CanonicalAttributeName(string lowerName) =>
        CaseSensitiveAttributes.TryGetValue(lowerName, out var canonical) ? canonical : lowerName;

    /// <summary>
    /// Returns the cleaned URI, or <c>null</c> when the value must be dropped.
    /// The value is normalized the way a browser normalizes a URL before resolving its
    /// scheme: ASCII tab, LF, and CR are removed from anywhere in the string, then leading
    /// and trailing C0-control-or-space (U+0000 through U+0020) is trimmed. Nothing outside
    /// that range is trimmed: a URL parser percent-encodes Unicode whitespace and the
    /// byte-order mark into the path rather than stripping them, so trimming them here
    /// would ship a different URL than the one that was authored.
    /// Matching the raw value instead would let
    /// <c>java&amp;#9;script:</c> reassemble into a live scheme after the tokenizer decodes
    /// the entity. The normalized form is what is returned, so the value that ships is the
    /// one the browser will resolve, and it is also the value the scheme is read from --
    /// reading the scheme from anything less normalized would put the allow-list behind the
    /// same smuggling trick the normalization exists to defeat.
    ///
    /// A value carrying no scheme is relative and is never subject to the allow-list:
    /// <c>about.html</c>, <c>/abs/path</c>, <c>//host/path</c>, <c>#anchor</c>, and
    /// <c>?q=1</c> all survive whatever the set says.
    /// </summary>
    /// <param name="schemes">
    /// the format's effective scheme set; the default safe set when omitted
    /// </param>
    public static string? SanitizeUri(string value, string attrName, IReadOnlySet<string>? schemes = null)
    {
        var allowed = schemes ?? DefaultUriSchemeSet;
        var stripped = new string(value.Where(c => c != '\t' && c != '\n' && c != '\r').ToArray());
        var trimmed = stripped.Trim(TrimmedUriChars);
        var lowered = LowerFull(trimmed);

        var match = UriSchemePattern.Match(lowered);
        if (!match.Success) return trimmed;

        var scheme = match.Groups[1].Value;
        if (ProhibitedUriSchemes.Contains(scheme)) return null;
        if (!allowed.Contains(scheme)) return null;

        if (scheme == "data")
        {
            if (attrName == "src" && SafeDataImagePattern.IsMatch(lowered)) return trimmed;
            return null;
        }

        return trimmed;
    }

    /// <summary>
    /// Lower-cases with the full Unicode mapping. <c>ToLowerInvariant</c> applies the simple
    /// one-to-one mapping, which folds U+0130 onto a bare ASCII <c>i</c> and so reads a
    /// scheme out of a value that carries none; the full mapping expands it to
    /// <c>i</c> plus a combining dot, which no scheme grammar accepts.
    /// </summary>
    private static string LowerFull(string value) =>
        value.Replace("İ", "i̇").ToLowerInvariant();

    public static string SanitizeStyleValue(string value)
    {
        var cleaned = value;
        foreach (var pattern in DangerousStylePatterns)
            cleaned = pattern.Replace(cleaned, "");
        return cleaned.Trim();
    }

    public static string SanitizeStyleBlock(string css)
    {
        var cleaned = css;
        foreach (var pattern in DangerousStylePatterns)
            cleaned = pattern.Replace(cleaned, "");

        return CssDeclarationBlockPattern.Replace(cleaned, match =>
        {
            var declarations = match.Groups[1].Value
                .Split(';')
                .Select(declaration => declaration.Trim())
                .Where(declaration =>
                {
                    if (declaration.Length == 0) return false;
                    var colon = declaration.IndexOf(':');
                    if (colon < 0) return false;
                    return declaration[(colon + 1)..].Trim().Length > 0;
                })
                .ToList();

            if (declarations.Count == 0) return "{}";
            return "{ " + string.Join("; ", declarations) + "; }";
        });
    }
}
