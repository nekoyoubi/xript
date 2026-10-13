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
    public const string RemoveAttr = "removeAttr";
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
                case FragmentOpNames.RemoveAttr:
                {
                    var prop = raw.Prop ?? raw.Attr;
                    if (string.IsNullOrEmpty(prop))
                    {
                        report?.Invoke(new FragmentDiagnostic(
                            DiagnosticCodes.OpUnknownProp, DiagnosticSeverity.Warning, path, raw.Selector,
                            $"op \"{raw.Op}\" needs a prop name"));
                        break;
                    }

                    var isAttribute = raw.Op != FragmentOpNames.SetProp || LandsOnHtmlAttribute(profile, prop);
                    var removes = raw.Op == FragmentOpNames.RemoveAttr
                        || (isAttribute && raw.Value is null or PropValue.Nul or PropValue.Bool { Value: false });
                    if (removes)
                    {
                        var refusal = CheckPropName(profile, prop);
                        if (refusal is not null)
                        {
                            report?.Invoke(new FragmentDiagnostic(
                                refusal.Code!, DiagnosticSeverity.Warning, path, raw.Selector, refusal.Message!, prop));
                            break;
                        }
                        result.Add(new FragmentOp(FragmentOpNames.RemoveAttr, raw.Selector, target, null, prop, prop));
                        break;
                    }

                    if (isAttribute && raw.Value is PropValue.Obj or PropValue.Arr)
                    {
                        report?.Invoke(new FragmentDiagnostic(
                            DiagnosticCodes.OpInvalidValue, DiagnosticSeverity.Warning, path, raw.Selector,
                            $"op \"{raw.Op}\" on \"{raw.Selector}\" cannot write a non-primitive value to attribute \"{prop}\"",
                            prop));
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
                    if (raw.Value is not (PropValue.Str or PropValue.Arr))
                    {
                        report?.Invoke(new FragmentDiagnostic(
                            DiagnosticCodes.OpInvalidValue, DiagnosticSeverity.Warning, path, raw.Selector,
                            $"op \"replaceChildren\" on \"{raw.Selector}\" needs a string or a list of children"));
                        break;
                    }
                    result.Add(new FragmentOp(raw.Op, raw.Selector, target,
                        SanitizeOpChildren(raw.Value, profile, path, report)));
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

    private static bool IsHtmlOnly(FormatProfile profile) =>
        profile.Scope.Count == 1 && profile.Scope[0] is ResolvedVocabulary.BuiltinHtml;

    private static bool DeclaredByScope(FormatProfile profile, string prop) =>
        profile.ScopeNodeOrder.Any(entry =>
            ((ResolvedVocabulary.Declared)profile.Scope[entry.Item1]).Nodes[entry.Item2].Props.ContainsKey(prop));

    /// <summary>
    /// Whether a prop write resolves to an HTML attribute rather than to a typed prop a
    /// declared vocabulary owns. An attribute holds a string, so it has no <c>false</c> to
    /// hold: <c>false</c> and <c>null</c> there mean "absent", the way a boolean attribute
    /// does in HTML.
    /// </summary>
    private static bool LandsOnHtmlAttribute(FormatProfile profile, string prop) =>
        IsHtmlOnly(profile) || (profile.SpeaksHtml && !DeclaredByScope(profile, prop));

    /// <summary>The name half of <see cref="RouteOpValue"/>: whether an op may address this prop at all.</summary>
    private static Routed? CheckPropName(FormatProfile profile, string prop)
    {
        var lower = prop.ToLowerInvariant();
        if (IsHtmlOnly(profile))
            return HtmlRules.IsAllowedAttribute(lower)
                ? null
                : new Routed(null, DiagnosticCodes.UnsafeProp, $"prop \"{prop}\" is not settable on an HTML node");
        if (DeclaredByScope(profile, prop) || (profile.SpeaksHtml && HtmlRules.IsAllowedAttribute(lower)))
            return null;
        return new Routed(null, DiagnosticCodes.OpUnknownProp,
            $"prop \"{prop}\" is not declared by any node of format \"{profile.Id}\"");
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
    /// The value keeps the shape the mod gave it: a list of strings under an HTML-speaking
    /// format is a list of markup strings, each sanitized on its own and the list kept, and
    /// the empty list is an explicit clear. Any other list is a J5ML node list.
    /// </summary>
    /// <remarks>
    /// Every finding the nested pass makes is forwarded through <paramref name="report"/> with
    /// its path prefixed by the op's, and for a markup list by the item's index too (<c>/0</c>
    /// op, <c>/2</c> item, <c>/1</c> node), so a node or prop the markup loses is reported
    /// rather than dropped silently.
    /// </remarks>
    private static PropValue? SanitizeOpChildren(
        PropValue? value, FormatProfile profile, string opPath, Action<FragmentDiagnostic>? report)
    {
        if (value is PropValue.Str str) return PropValue.Of(SanitizeOpMarkup(str.Value, profile, opPath, report));

        if (value is PropValue.Arr markupList && profile.SpeaksHtml && markupList.Items.All(item => item is PropValue.Str))
        {
            return new PropValue.Arr(markupList.Items
                .Select((item, index) => PropValue.Of(
                    SanitizeOpMarkup(((PropValue.Str)item).Value, profile, $"{opPath}/{index}", report)))
                .ToList());
        }

        if (value is PropValue.Arr array)
        {
            var nodes = FragmentTree.FromJsml(array.Items.Select(item => item.ToJson()));
            var sanitized = VocabularySanitizer.Sanitize(nodes, profile);
            ForwardDiagnostics(sanitized.Diagnostics, opPath, report);
            return PropValue.FromJson(FragmentTree.ToJsml(sanitized.Tree));
        }

        return value;
    }

    /// <summary>
    /// Sanitizes one markup string. A built-in format's markup is read as <c>text/html</c>,
    /// which is what the string sanitizer has always done; a declared format's markup is read
    /// against its own scope so its custom elements survive.
    /// </summary>
    private static string SanitizeOpMarkup(
        string source, FormatProfile profile, string pathPrefix, Action<FragmentDiagnostic>? report)
    {
        if (!profile.SpeaksHtml) return source;
        var markupProfile = profile.Builtin ? FormatProfiles.Builtins["text/html"] : profile;
        var sanitized = VocabularySanitizer.Sanitize(HtmlReader.ToTree(source, markupProfile), markupProfile);
        ForwardDiagnostics(sanitized.Diagnostics, pathPrefix, report);
        return FragmentTree.ToHtml(sanitized.Tree, markupProfile);
    }

    private static void ForwardDiagnostics(
        IEnumerable<FragmentDiagnostic> diagnostics, string pathPrefix, Action<FragmentDiagnostic>? report)
    {
        if (report is null) return;
        foreach (var diagnostic in diagnostics)
            report(diagnostic with { Path = pathPrefix + diagnostic.Path });
    }
}
