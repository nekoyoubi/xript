using System.Text.Json.Nodes;

namespace Xript.Runtime.Fragments;

/// <summary>A node the host should act on: either an id reference or a CSS selector.</summary>
public abstract record NodeRef
{
    public sealed record Id(string Value) : NodeRef;

    public sealed record Selector(string Value) : NodeRef;

    private static readonly System.Text.RegularExpressions.Regex IdReference =
        new(@"^#[A-Za-z][A-Za-z0-9_.:-]*$", System.Text.RegularExpressions.RegexOptions.Compiled);

    public static NodeRef Parse(string target) =>
        IdReference.IsMatch(target) ? new Id(target[1..]) : new Selector(target);
}

/// <summary>A command as it leaves the sandbox, before any vocabulary routing.</summary>
public sealed record RawFragmentOp(string Op, string Selector, string? Prop, string? Attr, PropValue? Value);

public static class FragmentOpNames
{
    public const string Toggle = "toggle";
    public const string SetText = "setText";
    public const string ReplaceChildren = "replaceChildren";
    public const string SetProp = "setProp";
    public const string SetAttr = "setAttr";
    public const string AddClass = "addClass";
    public const string RemoveClass = "removeClass";

    public static readonly HashSet<string> HtmlSugarOps =
        new([AddClass, RemoveClass], StringComparer.Ordinal);
}

/// <summary>
/// Routes a mod's command buffer through the active vocabulary. An op names a prop but
/// not the node it lands on, so a prop's sink is resolved across the whole vocabulary;
/// an op with no sink the vocabulary recognizes is dropped rather than applied blind.
/// </summary>
public static class FragmentOps
{
    private sealed record Routed(PropValue? Value, string? Code, string? Message)
    {
        public bool Rejected => Code is not null;
    }

    public static List<FragmentOp> Finalize(
        IReadOnlyList<RawFragmentOp> ops,
        FormatProfile profile,
        Action<FragmentDiagnostic>? report = null)
    {
        var isTree = !profile.SpeaksHtml;
        var result = new List<FragmentOp>();

        for (var index = 0; index < ops.Count; index++)
        {
            var raw = ops[index];
            var path = $"/{index}";
            var target = NodeRef.Parse(raw.Selector);

            if (isTree && FragmentOpNames.HtmlSugarOps.Contains(raw.Op))
            {
                report?.Invoke(new FragmentDiagnostic(
                    DiagnosticCodes.UnsupportedOp, DiagnosticSeverity.Warning, path, raw.Selector,
                    $"op \"{raw.Op}\" is HTML-vocabulary sugar and has no meaning in format \"{profile.Id}\""));
                continue;
            }

            if (isTree && target is NodeRef.Selector)
            {
                report?.Invoke(new FragmentDiagnostic(
                    DiagnosticCodes.UnsupportedTarget, DiagnosticSeverity.Warning, path, raw.Selector,
                    $"format \"{profile.Id}\" has no CSS selectors — target a node by id (\"#name\")"));
                continue;
            }

            switch (raw.Op)
            {
                case FragmentOpNames.Toggle:
                    result.Add(new FragmentOp(raw.Op, raw.Selector, target,
                        PropValue.Of(raw.Value is PropValue.Bool { Value: true })));
                    break;

                case FragmentOpNames.SetText:
                case FragmentOpNames.AddClass:
                case FragmentOpNames.RemoveClass:
                    result.Add(new FragmentOp(raw.Op, raw.Selector, target,
                        PropValue.Of(raw.Value is null or PropValue.Nul
                            ? ""
                            : PropValue.Stringify(raw.Value))));
                    break;

                case FragmentOpNames.SetProp:
                case FragmentOpNames.SetAttr:
                {
                    var prop = raw.Prop ?? raw.Attr;
                    if (string.IsNullOrEmpty(prop))
                    {
                        report?.Invoke(new FragmentDiagnostic(
                            DiagnosticCodes.OpUnknownProp, DiagnosticSeverity.Warning, path, raw.Selector,
                            $"op \"{raw.Op}\" needs a prop name"));
                        break;
                    }

                    var routed = RouteOpValue(profile, prop, raw.Value);
                    if (routed.Rejected)
                    {
                        report?.Invoke(new FragmentDiagnostic(
                            routed.Code!, DiagnosticSeverity.Warning, path, raw.Selector,
                            routed.Message!, prop));
                        break;
                    }

                    result.Add(new FragmentOp(raw.Op, raw.Selector, target, routed.Value, prop,
                        raw.Op == FragmentOpNames.SetAttr ? prop : null));
                    break;
                }

                case FragmentOpNames.ReplaceChildren:
                    result.Add(new FragmentOp(raw.Op, raw.Selector, target,
                        SanitizeOpChildren(raw.Value, profile)));
                    break;

                default:
                    result.Add(new FragmentOp(raw.Op, raw.Selector, target, null));
                    break;
            }
        }

        return result;
    }

    /// <summary>
    /// Resolves a prop's sink by union across the entire resolved scope. An op names a prop
    /// but never the node it lands on, so resolution order carries no information here and
    /// first-listed-wins does not apply: every node of every vocabulary in scope is consulted,
    /// and two of them declaring the prop with different non-<c>text</c> sinks refuses the op
    /// rather than guessing. The built-in HTML fallback fires only when no declared vocabulary
    /// claims the prop, and is position-independent.
    /// </summary>
    private static Routed RouteOpValue(FormatProfile profile, string prop, PropValue? value)
    {
        if (profile.Scope.Count == 1 && profile.Scope[0] is ResolvedVocabulary.BuiltinHtml)
            return RouteThroughHtmlSink(prop, value, profile.Schemes);

        var sinks = new List<Sink>();
        var declaredAnywhere = false;

        foreach (var (vocabularyIndex, nodeName) in profile.ScopeNodeOrder)
        {
            var vocabulary = (ResolvedVocabulary.Declared)profile.Scope[vocabularyIndex];
            if (!vocabulary.Nodes[nodeName].Props.TryGetValue(prop, out var declared)) continue;
            declaredAnywhere = true;
            if (!sinks.Contains(declared.Sink)) sinks.Add(declared.Sink);
        }

        if (!declaredAnywhere)
        {
            if (profile.SpeaksHtml && HtmlRules.IsAllowedAttribute(prop.ToLowerInvariant()))
                return RouteThroughHtmlSink(prop, value, profile.Schemes);
            return new Routed(null, DiagnosticCodes.OpUnknownProp,
                $"prop \"{prop}\" is not declared by any node of format \"{profile.Id}\"");
        }

        var dangerous = sinks.Where(sink => sink != Sink.Text).ToList();
        if (dangerous.Count > 1)
        {
            var named = dangerous.Select(SinkNames.ToWireName).OrderBy(name => name, StringComparer.Ordinal);
            return new Routed(null, DiagnosticCodes.PropSinkConflict,
                $"prop \"{prop}\" is declared with conflicting sinks ({string.Join(", ", named)}) in format \"{profile.Id}\"");
        }

        var sink = dangerous.Count == 1 ? dangerous[0] : Sink.Text;
        var routedValue = ApplyOpSink(sink, value, profile.Schemes);
        if (routedValue is null)
            return new Routed(null, DiagnosticCodes.UnsafeProp,
                $"prop \"{prop}\" was rejected by sink \"{sink.ToWireName()}\"");

        return new Routed(routedValue, null, null);
    }

    private static Routed RouteThroughHtmlSink(
        string prop, PropValue? value, IReadOnlySet<string> schemes)
    {
        var lower = prop.ToLowerInvariant();
        if (!HtmlRules.IsAllowedAttribute(lower))
            return new Routed(null, DiagnosticCodes.UnsafeProp,
                $"prop \"{prop}\" is not settable on an HTML node");

        var routed = ApplyOpSink(HtmlSinkFor(lower), value, schemes);
        if (routed is null)
            return new Routed(null, DiagnosticCodes.UnsafeProp,
                $"prop \"{prop}\" was rejected by its sink");

        return new Routed(routed, null, null);
    }

    private static Sink HtmlSinkFor(string lowerProp) => lowerProp switch
    {
        "href" => Sink.Uri,
        "src" => Sink.ImageUri,
        "style" => Sink.Css,
        _ => Sink.Text,
    };

    /// <summary>
    /// The op-layer sink pass. A <c>text</c> sink keeps the value's full JSON type;
    /// every other sink demands a string and may reject it outright.
    /// </summary>
    private static PropValue? ApplyOpSink(Sink sink, PropValue? value, IReadOnlySet<string> schemes)
    {
        if (sink == Sink.Text) return value ?? PropValue.Null;
        if (value is not PropValue.Str str) return null;
        var cleaned = VocabularySanitizer.ApplySink(sink, str.Value, schemes);
        return cleaned is null ? null : PropValue.Of(cleaned);
    }

    /// <summary>
    /// <c>replaceChildren</c> is the one op whose value is markup, and it goes through the
    /// same vocabulary the fragment's own source does. A declared format that speaks HTML
    /// carries nodes the built-in HTML vocabulary knows nothing about, so sanitizing its
    /// markup against built-in HTML alone would strip exactly the custom elements the format
    /// exists to declare. A J5ML node list takes the same route through the tree sanitizer.
    /// </summary>
    private static PropValue? SanitizeOpChildren(PropValue? value, FormatProfile profile)
    {
        if (value is PropValue.Str str)
        {
            if (!profile.SpeaksHtml) return str;
            if (profile.Builtin) return PropValue.Of(HtmlReader.Sanitize(str.Value));
            var parsed = HtmlReader.ToTree(str.Value, profile);
            var sanitizedHtml = VocabularySanitizer.Sanitize(parsed, profile);
            return PropValue.Of(FragmentTree.ToHtml(sanitizedHtml.Tree));
        }

        if (value is PropValue.Arr array)
        {
            var nodes = FragmentTree.FromJsml(array.Items.Select(item => item.ToJson()));
            var sanitized = VocabularySanitizer.Sanitize(nodes, profile);
            return PropValue.FromJson(FragmentTree.ToJsml(sanitized.Tree));
        }

        return value;
    }
}
