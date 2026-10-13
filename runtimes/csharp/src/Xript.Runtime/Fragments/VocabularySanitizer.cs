using System.Text.RegularExpressions;
using Xript.Runtime.Expressions;

namespace Xript.Runtime.Fragments;

public enum DiagnosticSeverity
{
    Warning,
    Error,
}

public static class DiagnosticCodes
{
    public const string UnknownNode = "unknown-node";
    public const string StrippedNode = "stripped-node";
    public const string UnknownProp = "unknown-prop";
    public const string InvalidProp = "invalid-prop";
    public const string UnsafeProp = "unsafe-prop";
    public const string IllegalChild = "illegal-child";
    public const string InvalidExpression = "invalid-expression";

    public const string UnsupportedOp = "unsupported-op";
    public const string UnsupportedTarget = "unsupported-target";
    public const string OpUnknownProp = "op-unknown-prop";
    public const string OpInvalidValue = "op-invalid-value";
    public const string PropSinkConflict = "prop-sink-conflict";

    public const string DuplicateKey = "duplicate-key";
    public const string InvalidKey = "invalid-key";
    public const string RepeatLimit = "repeat-limit";
}

/// <summary>
/// A single vocabulary finding. <c>Path</c> is an index path into the source tree,
/// e.g. <c>/0/2/1</c>.
/// </summary>
public sealed record FragmentDiagnostic(
    string Code,
    DiagnosticSeverity Severity,
    string Path,
    string Node,
    string Message,
    string? Prop = null)
{
    public string SeverityName => Severity == DiagnosticSeverity.Error ? "error" : "warning";
}

public sealed record TreeSanitizeResult(
    List<FragmentNode> Tree,
    List<FragmentDiagnostic> Diagnostics,
    List<string> StrippedElements,
    List<StrippedAttribute> StrippedAttributes);

/// <summary>
/// Applies a fragment format's vocabulary to a parsed tree: node names are matched
/// against the vocabulary, props against each node's declaration, and prop values are
/// routed through the sanitizer their declared sink names.
///
/// Default-deny throughout. A node the vocabulary does not declare is refused: under a
/// host-declared vocabulary that is an error and the subtree is dropped. Under a built-in
/// profile, whose tag surface is open and externally defined, the drop is reported as a
/// warning rather than passing silently, and the disposition follows the source syntax:
/// an HTML-syntax source unwraps the unknown tag so its sanitized children survive, while
/// a JSON-syntax source drops the whole subtree.
/// </summary>
public static class VocabularySanitizer
{
    /// <summary>
    /// A prop name every vocabulary admits by prefix: dataset keys and ARIA attributes.
    /// Both are inert metadata, so they are legal on a declared node without the
    /// vocabulary naming them one at a time.
    /// </summary>
    public static bool IsMetadataPropName(string name)
    {
        var lower = name.ToLowerInvariant();
        return lower.StartsWith("data-", StringComparison.Ordinal)
            || lower.StartsWith("aria-", StringComparison.Ordinal);
    }

    private static readonly Regex EventHandlerPropPattern =
        new("^on", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private sealed class Context
    {
        public required FormatProfile Profile { get; init; }
        public required bool Strict { get; init; }
        public bool Interpolate { get; init; }

        /// <summary>True while walking the descendants of a built-in <c>&lt;svg&gt;</c> element.</summary>
        public bool InSvg { get; set; }
        public List<FragmentDiagnostic> Diagnostics { get; } = [];
        public List<string> StrippedElements { get; } = [];
        public List<StrippedAttribute> StrippedAttributes { get; } = [];

        public DiagnosticSeverity VocabularySeverity =>
            !Profile.Builtin || Strict ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
    }

    private abstract record Resolution
    {
        public sealed record Declared(
            string? Vocabulary, string Name, NodeDefinition Definition) : Resolution;
        public sealed record Html(string Name) : Resolution;
        public sealed record SvgText(string Name) : Resolution;
        public sealed record Stripped(string Name) : Resolution;
        public sealed record Unwrap : Resolution;
        public sealed record Unknown : Resolution;
    }

    /// <summary>
    /// Segments a text node's interpolation sites.
    ///
    /// This runs <em>inside the sanitizer</em>, on the way from source to validated tree, and
    /// that placement is the structural half of the safety argument: substitution happens
    /// later, in the bind pass, over an already-validated tree. There is no code path from a
    /// binding value back into the tokenizer, because the tokenizer has already run and is
    /// never called again.
    /// </summary>
    private static FragmentNode SegmentTextNode(FragmentNode.Text node, Context ctx, string path)
    {
        if (!ctx.Interpolate || !Interpolation.ContainsInterpolation(node.Value)) return node;

        var result = Interpolation.SegmentText(node.Value);
        foreach (var issue in result.Issues)
        {
            ctx.Diagnostics.Add(new FragmentDiagnostic(
                DiagnosticCodes.InvalidExpression,
                DiagnosticSeverity.Error,
                path,
                "#text",
                $"invalid interpolation: {issue.Message}"));
        }

        return result.Segments is null ? node : node with { Segments = result.Segments };
    }

    public static TreeSanitizeResult Sanitize(
        IReadOnlyList<FragmentNode> tree,
        FormatProfile profile,
        bool strictVocabulary = false,
        bool interpolate = false)
    {
        var ctx = new Context { Profile = profile, Strict = strictVocabulary, Interpolate = interpolate };
        var sanitized = WalkNodes(tree, ctx, "", ChildrenConstraint.Any);
        return new TreeSanitizeResult(
            sanitized, ctx.Diagnostics, ctx.StrippedElements, ctx.StrippedAttributes);
    }

    private static List<FragmentNode> WalkNodes(
        IReadOnlyList<FragmentNode> nodes, Context ctx, string path, ChildrenConstraint constraint)
    {
        var result = new List<FragmentNode>();

        for (var index = 0; index < nodes.Count; index++)
        {
            var node = nodes[index];
            var nodePath = $"{path}/{index}";

            if (node is FragmentNode.Text text)
            {
                if (constraint.TextAllowed)
                {
                    result.Add(SegmentTextNode(text, ctx, nodePath));
                    continue;
                }
                if (text.Value.Trim().Length == 0) continue;
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.IllegalChild,
                    ctx.VocabularySeverity,
                    nodePath,
                    "#text",
                    $"text is not permitted here (children: {constraint.Describe()})"));
                continue;
            }

            var element = (FragmentNode.Element)node;
            var resolved = ResolveNode(element.Name, ctx.Profile, ctx.InSvg);

            switch (resolved)
            {
                case Resolution.Unknown:
                {
                    var severity = ctx.VocabularySeverity;
                    ctx.Diagnostics.Add(new FragmentDiagnostic(
                        DiagnosticCodes.UnknownNode,
                        severity,
                        nodePath,
                        element.Name,
                        $"node \"{element.Name}\" is not declared by format \"{ctx.Profile.Id}\""));
                    if (severity == DiagnosticSeverity.Warning && ctx.Profile.Syntax == FragmentSyntax.Html)
                        result.AddRange(WalkNodes(element.Children, ctx, nodePath, constraint));
                    continue;
                }

                case Resolution.Stripped stripped:
                {
                    ctx.StrippedElements.Add(stripped.Name);
                    ctx.Diagnostics.Add(new FragmentDiagnostic(
                        DiagnosticCodes.StrippedNode,
                        DiagnosticSeverity.Warning,
                        nodePath,
                        stripped.Name,
                        $"stripped dangerous element: <{stripped.Name}>"));
                    continue;
                }

                case Resolution.Unwrap:
                    result.AddRange(WalkNodes(element.Children, ctx, nodePath, constraint));
                    continue;
            }

            var resolvedName = resolved switch
            {
                Resolution.Declared declared => declared.Name,
                Resolution.SvgText svgText => svgText.Name,
                _ => ((Resolution.Html)resolved).Name,
            };

            if (!constraint.Allows(resolvedName))
            {
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.IllegalChild,
                    ctx.VocabularySeverity,
                    nodePath,
                    resolvedName,
                    $"node \"{resolvedName}\" is not permitted here (children: {constraint.Describe()})"));
                continue;
            }

            result.Add(resolved switch
            {
                Resolution.Declared d => SanitizeDeclaredNode(element, d.Definition, ctx, nodePath),
                Resolution.SvgText => SanitizeSvgTextNode(element, resolvedName, ctx, nodePath),
                _ => SanitizeHtmlNode(element, resolvedName, ctx, nodePath),
            });
        }

        return result;
    }

    /// <summary>
    /// An SVG <c>title</c> or <c>desc</c>. Text-only: element children are reduced to their
    /// text, a stripped element's subtree is dropped outright, and a <c>style</c> element's
    /// content is dropped rather than surfacing as prose. Each removal is reported.
    /// Attributes are held to <see cref="HtmlRules.SvgTextAttributes"/> plus the inert
    /// <c>data-*</c>/<c>aria-*</c> prefixes.
    /// </summary>
    private static FragmentNode.Element SanitizeSvgTextNode(
        FragmentNode.Element node, string tag, Context ctx, string path)
    {
        var props = new PropMap();

        foreach (var (key, value) in node.Props)
        {
            var lowerKey = key.ToLowerInvariant();
            var allowed = !FragmentTree.ForbiddenPropNames.Contains(lowerKey)
                && HtmlRules.IsValidAttributeName(lowerKey)
                && (HtmlRules.SvgTextAttributes.Contains(lowerKey) || IsMetadataPropName(lowerKey));
            if (!allowed)
            {
                ctx.StrippedAttributes.Add(new StrippedAttribute(tag, lowerKey));
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    lowerKey.StartsWith("on", StringComparison.Ordinal)
                        ? DiagnosticCodes.UnsafeProp
                        : DiagnosticCodes.UnknownProp,
                    DiagnosticSeverity.Warning, path, tag,
                    $"stripped attribute \"{lowerKey}\" on <{tag}>", lowerKey));
                continue;
            }
            props.Set(lowerKey, value);
        }

        var text = CollectSvgText(node.Children, tag, ctx, path);
        var children = new List<FragmentNode>();
        if (text.Length > 0)
            children.Add(SegmentTextNode(new FragmentNode.Text(text), ctx, $"{path}/0"));

        return new FragmentNode.Element { Name = tag, Props = props, Children = children };
    }

    private static string CollectSvgText(
        IReadOnlyList<FragmentNode> nodes, string owner, Context ctx, string path)
    {
        var text = new System.Text.StringBuilder();
        for (var index = 0; index < nodes.Count; index++)
        {
            var childPath = $"{path}/{index}";
            if (nodes[index] is FragmentNode.Text childText)
            {
                text.Append(childText.Value);
                continue;
            }

            var child = (FragmentNode.Element)nodes[index];
            var lower = child.Name.ToLowerInvariant();
            if (HtmlRules.StrippedElements.Contains(lower))
            {
                ctx.StrippedElements.Add(lower);
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.StrippedNode, DiagnosticSeverity.Warning, childPath, lower,
                    $"stripped dangerous element: <{lower}>"));
                continue;
            }

            var keepsText = lower != "style";
            ctx.Diagnostics.Add(new FragmentDiagnostic(
                DiagnosticCodes.IllegalChild, DiagnosticSeverity.Warning, childPath, child.Name,
                keepsText
                    ? $"node \"{child.Name}\" is not permitted inside svg <{owner}>; its text was kept"
                    : $"node \"{child.Name}\" is not permitted inside svg <{owner}> and was dropped"));
            if (keepsText) text.Append(CollectSvgText(child.Children, owner, ctx, childPath));
        }
        return text.ToString();
    }

    /// <summary>
    /// Walks the format's scope in order, returning the first vocabulary's claim on the name.
    /// Order is authoritative and literal: no reordering, no merging. The built-in HTML arm
    /// declines rather than terminates, so a vocabulary listed after it still gets its turn.
    /// </summary>
    private static Resolution ResolveNode(string name, FormatProfile profile, bool inSvg)
    {
        foreach (var entry in profile.Scope)
        {
            if (entry is ResolvedVocabulary.Declared vocabulary)
            {
                if (vocabulary.Nodes.TryGetValue(name, out var declared))
                    return new Resolution.Declared(vocabulary.Id, name, declared);
                continue;
            }

            var lower = name.ToLowerInvariant();
            if (inSvg && HtmlRules.SvgTextElements.Contains(lower)) return new Resolution.SvgText(lower);
            if (HtmlRules.StrippedElements.Contains(lower)) return new Resolution.Stripped(lower);
            if (HtmlRules.UnwrappedElements.Contains(lower) && profile.Syntax == FragmentSyntax.Html)
                return new Resolution.Unwrap();
            if (HtmlRules.AllowedElements.Contains(lower)) return new Resolution.Html(lower);
        }

        return new Resolution.Unknown();
    }

    /// <summary>
    /// Whether a prop value reaches markup as an attribute <em>value</em>. <c>true</c> projects
    /// as a bare attribute and <c>false</c>/<c>null</c> are omitted entirely, so neither carries
    /// text into the document; every other type is stringified into the attribute and must
    /// therefore be sanitized when the attribute is a dangerous sink.
    /// </summary>
    private static bool ProjectsToMarkup(PropValue value)
        => value is not (PropValue.Bool or PropValue.Nul);

    /// <summary>
    /// The built-in HTML vocabulary. Node and attribute names are folded to lower case,
    /// attributes are filtered against a global allowlist, and <c>href</c>/<c>src</c>/<c>style</c>
    /// values are routed through the value sanitizers by attribute name.
    /// </summary>
    private static FragmentNode.Element SanitizeHtmlNode(
        FragmentNode.Element node, string tag, Context ctx, string path)
    {
        var props = new PropMap();

        foreach (var (key, value) in node.Props)
        {
            var lowerKey = key.ToLowerInvariant();

            if (FragmentTree.ForbiddenPropNames.Contains(lowerKey))
            {
                ctx.StrippedAttributes.Add(new StrippedAttribute(tag, lowerKey));
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.UnsafeProp, DiagnosticSeverity.Warning, path, tag,
                    $"prop \"{key}\" is reserved and was dropped", key));
                continue;
            }

            if (!HtmlRules.IsValidAttributeName(lowerKey))
            {
                ctx.StrippedAttributes.Add(new StrippedAttribute(tag, lowerKey));
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.UnsafeProp, DiagnosticSeverity.Warning, path, tag,
                    $"stripped attribute with a malformed name on <{tag}>", key));
                continue;
            }

            if (!HtmlRules.IsAllowedAttribute(lowerKey))
            {
                ctx.StrippedAttributes.Add(new StrippedAttribute(tag, lowerKey));
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    lowerKey.StartsWith("on", StringComparison.Ordinal)
                        ? DiagnosticCodes.UnsafeProp
                        : DiagnosticCodes.UnknownProp,
                    DiagnosticSeverity.Warning, path, tag,
                    $"stripped attribute \"{lowerKey}\" on <{tag}>", lowerKey));
                continue;
            }

            if ((lowerKey is "href" or "src") && ProjectsToMarkup(value))
            {
                var cleaned = HtmlRules.SanitizeUri(
                    PropValue.Stringify(value), lowerKey, ctx.Profile.Schemes);
                if (cleaned is null)
                {
                    ctx.StrippedAttributes.Add(new StrippedAttribute(tag, lowerKey));
                    ctx.Diagnostics.Add(new FragmentDiagnostic(
                        DiagnosticCodes.UnsafeProp, DiagnosticSeverity.Warning, path, tag,
                        $"stripped attribute \"{lowerKey}\" on <{tag}>: unsafe URI", lowerKey));
                    continue;
                }
                props.Set(lowerKey, PropValue.Of(cleaned));
                continue;
            }

            if (lowerKey == "style" && ProjectsToMarkup(value))
            {
                var cleaned = HtmlRules.SanitizeStyleValue(PropValue.Stringify(value));
                if (cleaned.Length > 0) props.Set(lowerKey, PropValue.Of(cleaned));
                continue;
            }

            props.Set(HtmlRules.CanonicalAttributeName(lowerKey), value);
        }

        return new FragmentNode.Element
        {
            Name = tag,
            Props = props,
            Children = WalkSvgAware(node.Children, tag, ctx, path),
            SelfClosing = node.SelfClosing,
        };
    }

    private static List<FragmentNode> WalkSvgAware(
        IReadOnlyList<FragmentNode> children, string tag, Context ctx, string path)
    {
        var enclosingSvg = ctx.InSvg;
        if (tag == "svg") ctx.InSvg = true;
        var walked = WalkNodes(children, ctx, path, ChildrenConstraint.Any);
        ctx.InSvg = enclosingSvg;
        return walked;
    }

    /// <summary>
    /// A node the host's own vocabulary declares. The name and every prop name are matched
    /// verbatim, prop values keep their JSON type, and a value is only sanitized when the
    /// prop declares a sink saying where it lands.
    /// </summary>
    private static FragmentNode.Element SanitizeDeclaredNode(
        FragmentNode.Element node, NodeDefinition definition, Context ctx, string path)
    {
        var props = new PropMap();

        foreach (var (key, value) in node.Props)
        {
            if (FragmentTree.ForbiddenPropNames.Contains(key.ToLowerInvariant())
                || EventHandlerPropPattern.IsMatch(key))
            {
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.UnsafeProp, DiagnosticSeverity.Warning, path, node.Name,
                    $"prop \"{key}\" is reserved and was dropped", key));
                continue;
            }

            if (FormatProfiles.ProtocolProps.Contains(key))
            {
                if (value is not PropValue.Str)
                {
                    ctx.Diagnostics.Add(new FragmentDiagnostic(
                        DiagnosticCodes.InvalidProp, DiagnosticSeverity.Warning, path, node.Name,
                        $"prop \"{key}\" must be a string", key));
                    continue;
                }
                props.Set(key, value);
                continue;
            }

            // `data-*` and `aria-*` are inert by construction and carry no value into a
            // sink, so a vocabulary does not have to enumerate them. The built-in HTML
            // vocabulary already admits both by prefix; a declared one that did not would
            // force a host to restate every dataset key and ARIA attribute it ever writes,
            // and silently drop the ones it forgot.
            if (IsMetadataPropName(key))
            {
                props.Set(key, value);
                continue;
            }

            if (!definition.Props.TryGetValue(key, out var declared))
            {
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.UnknownProp, DiagnosticSeverity.Warning, path, node.Name,
                    $"prop \"{key}\" is not declared on node \"{node.Name}\"", key));
                continue;
            }

            if (declared.Type is not null && !MatchesJsonType(value, declared.Type))
            {
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.InvalidProp, DiagnosticSeverity.Warning, path, node.Name,
                    $"prop \"{key}\" expects type {declared.DescribeType()}", key));
                continue;
            }

            if (declared.Sink == Sink.Text)
            {
                props.Set(key, value);
                continue;
            }

            if (value is not PropValue.Str sinkInput)
            {
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.InvalidProp, DiagnosticSeverity.Warning, path, node.Name,
                    $"prop \"{key}\" declares sink \"{declared.Sink.ToWireName()}\" and must be a string", key));
                continue;
            }

            var cleaned = ApplySink(declared.Sink, sinkInput.Value, ctx.Profile.Schemes);
            if (cleaned is null)
            {
                ctx.Diagnostics.Add(new FragmentDiagnostic(
                    DiagnosticCodes.UnsafeProp, DiagnosticSeverity.Warning, path, node.Name,
                    $"prop \"{key}\" was rejected by sink \"{declared.Sink.ToWireName()}\"", key));
                continue;
            }

            props.Set(key, PropValue.Of(cleaned));
        }

        return new FragmentNode.Element
        {
            Name = node.Name,
            Props = props,
            Children = WalkNodes(node.Children, ctx, path, definition.Children),
            SelfClosing = node.SelfClosing,
        };
    }

    /// <summary>
    /// Runs a string through the sanitizer its sink names. Returns <c>null</c> on rejection.
    /// </summary>
    /// <param name="schemes">
    /// the format's effective scheme set; the default safe set when omitted
    /// </param>
    public static string? ApplySink(Sink sink, string value, IReadOnlySet<string>? schemes = null)
    {
        switch (sink)
        {
            case Sink.Uri:
                return HtmlRules.SanitizeUri(value, "href", schemes);
            case Sink.ImageUri:
                return HtmlRules.SanitizeUri(value, "src", schemes);
            case Sink.Css:
            {
                var cleaned = HtmlRules.SanitizeStyleValue(value);
                if (cleaned.Length == 0 && value.Trim().Length > 0) return null;
                return cleaned;
            }
            case Sink.Html:
                return HtmlReader.Sanitize(value);
            default:
                return value;
        }
    }

    public static bool MatchesJsonType(PropValue value, IReadOnlyList<string> types) =>
        types.Any(candidate => MatchesSingleType(value, candidate));

    private static bool MatchesSingleType(PropValue value, string type) => type switch
    {
        "string" => value is PropValue.Str,
        "number" => value is PropValue.Num,
        "integer" => value is PropValue.Num num && double.IsInteger(num.Value),
        "boolean" => value is PropValue.Bool,
        "null" => value is PropValue.Nul,
        "array" => value is PropValue.Arr,
        "object" => value is PropValue.Obj,
        _ => true,
    };
}
