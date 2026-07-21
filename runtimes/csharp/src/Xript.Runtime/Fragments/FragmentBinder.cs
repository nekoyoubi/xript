using Xript.Runtime.Expressions;

namespace Xript.Runtime.Fragments;

/// <summary>A <c>data-if</c> result, addressed by where its node sits in the bound tree.</summary>
public sealed record FragmentCondition(IReadOnlyList<int> Path, string Expression, bool Visible);

/// <summary>
/// <c>Visibility</c> is keyed by <c>data-if</c> expression text, so two nodes carrying the
/// same condition collapse into one entry and a host cannot map a result back to a node.
/// Deprecated in favour of <c>Conditions</c>; still populated, last-write-wins, as before.
/// </summary>
public sealed record BoundTree(
    List<FragmentNode> Tree,
    Dictionary<string, bool> Visibility,
    List<FragmentCondition> Conditions);

/// <summary>
/// Applies a fragment's bindings over the sanitized tree. <c>data-if</c> is recorded into
/// the visibility map and never prunes -- fragments stay inert and the host decides what to
/// show. A <c>data-bind</c> value written into a prop is routed through that prop's sink,
/// so a bound value is held to the same contract as an authored one.
/// </summary>
public static class FragmentBinder
{
    public static BoundTree Bind(
        IReadOnlyList<FragmentNode> tree,
        IReadOnlyDictionary<string, object?> bindings,
        FormatProfile profile,
        Func<string, bool> evaluateCondition)
    {
        var visibility = new Dictionary<string, bool>(StringComparer.Ordinal);
        var conditions = new List<FragmentCondition>();
        var bound = tree
            .Select((node, index) =>
                BindNode(node, bindings, profile, evaluateCondition, visibility, conditions, [index]))
            .ToList();
        return new BoundTree(bound, visibility, conditions);
    }

    /// <summary>
    /// Resolves what a <c>data-bind</c> writes, or <c>null</c> when it writes nothing.
    ///
    /// A bare name keeps its original contract exactly: an undeclared binding writes nothing,
    /// so the fragment's authored fallback content survives. An expression always produces a
    /// value -- <c>null</c> renders as the empty string -- because a computed result has no
    /// "absent" state to fall back from.
    /// </summary>
    public static string? BindValue(string source, IReadOnlyDictionary<string, object?> bindings)
    {
        var parsed = Xeg.ParseCached(source);
        if (parsed is { Kind: ExpressionKind.Expression })
            return ExprValue.Render(Xeg.EvaluateAst(parsed.Ast, bindings));

        var name = parsed?.Ast is Ast.Name named ? named.Value : source;
        return bindings.TryGetValue(name, out var value) && value is not null
            ? StringifyBinding(value)
            : null;
    }

    private static FragmentNode BindNode(
        FragmentNode node,
        IReadOnlyDictionary<string, object?> bindings,
        FormatProfile profile,
        Func<string, bool> evaluateCondition,
        Dictionary<string, bool> visibility,
        List<FragmentCondition> conditions,
        IReadOnlyList<int> path)
    {
        if (node is FragmentNode.Text text)
        {
            return text.Segments is null
                ? text
                : new FragmentNode.Text(Interpolation.ResolveSegments(text.Segments, bindings));
        }

        if (node is not FragmentNode.Element element) return node;

        var props = element.Props.Clone();
        var children = element.Children
            .Select((child, index) => BindNode(
                child, bindings, profile, evaluateCondition, visibility, conditions,
                [.. path, index]))
            .ToList();

        if (props.Get("data-if") is PropValue.Str condition)
        {
            var visible = evaluateCondition(condition.Value);
            visibility[condition.Value] = visible;
            conditions.Add(new FragmentCondition(path, condition.Value, visible));
        }

        if (props.Get("data-bind") is PropValue.Str binding
            && BindValue(binding.Value, bindings) is { } written)
        {
            var target = BindTarget(profile, element);

            if (target == "children")
            {
                children = [new FragmentNode.Text(written)];
            }
            else
            {
                var routed = RoutePropValue(profile, element.Name, target, written);
                if (routed is not null) props.Set(target, routed);
            }
        }

        return new FragmentNode.Element
        {
            Name = element.Name,
            Props = props,
            Children = children,
            SelfClosing = element.SelfClosing,
        };
    }

    private static string StringifyBinding(object value) => value switch
    {
        string s => s,
        bool b => b ? "true" : "false",
        double d => PropValue.NumberToString(d),
        float f => PropValue.NumberToString(f),
        int i => i.ToString(System.Globalization.CultureInfo.InvariantCulture),
        long l => l.ToString(System.Globalization.CultureInfo.InvariantCulture),
        PropValue prop => PropValue.Stringify(prop),
        _ => value.ToString() ?? "",
    };

    private static bool IsVoidNode(FormatProfile profile, FragmentNode.Element node) =>
        profile.NodeDefinition(node.Name) is { } declared
            ? declared.Children.Kind == ChildrenKind.None
            : HtmlRules.VoidElements.Contains(node.Name);

    private static string BindTarget(FormatProfile profile, FragmentNode.Element node)
    {
        if (profile.NodeDefinition(node.Name)?.BindTo is { } bindTo) return bindTo;
        return IsVoidNode(profile, node) ? "value" : "children";
    }

    /// <summary>Routes a bound value into a prop through that prop's declared sink.</summary>
    public static PropValue? RoutePropValue(
        FormatProfile profile, string nodeName, string prop, string value)
    {
        if (profile.NodeDefinition(nodeName) is { } declared)
        {
            if (FormatProfiles.ProtocolProps.Contains(prop)) return PropValue.Of(value);
            if (!declared.Props.TryGetValue(prop, out var definition)) return null;
            if (definition.Sink == Sink.Text) return PropValue.Of(value);
            var cleaned = VocabularySanitizer.ApplySink(definition.Sink, value, profile.Schemes);
            return cleaned is null ? null : PropValue.Of(cleaned);
        }

        if (!profile.SpeaksHtml) return null;

        var lower = prop.ToLowerInvariant();
        if (!HtmlRules.IsAllowedAttribute(lower)) return null;
        if (lower is "href" or "src")
        {
            var cleaned = HtmlRules.SanitizeUri(value, lower, profile.Schemes);
            return cleaned is null ? null : PropValue.Of(cleaned);
        }
        if (lower == "style") return PropValue.Of(HtmlRules.SanitizeStyleValue(value));
        return PropValue.Of(value);
    }
}
