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
    List<FragmentCondition> Conditions)
{
    /// <summary>Every <c>data-each</c> expansion, in document order.</summary>
    public List<FragmentRepeat> Repeats { get; init; } = [];

    /// <summary>
    /// Findings the bind pass made: bound values the vocabulary refused to write, duplicate
    /// or invalid repeat keys, and the copy ceiling.
    /// </summary>
    public List<FragmentDiagnostic> Diagnostics { get; init; } = [];

    /// <summary>This render's repeat sites, to pass back as <c>previous</c> on the next render.</summary>
    public RepeatState RepeatState { get; init; } = new();
}

/// <summary>
/// Why a routed value was refused: the node's vocabulary does not reach the prop at all,
/// or the prop's sink rejected the value.
/// </summary>
public enum PropRouteRefusal
{
    Undeclared,
    Rejected,
}

/// <summary>
/// What each repeat site looked like on the previous render, keyed by
/// <see cref="RepeatSite.Id"/>. Carried from one render to the next so each repeat can
/// report how to patch the copies the host already drew.
/// </summary>
public sealed class RepeatState : Dictionary<string, (string Mode, IReadOnlyList<object> Keys)>
{
    public RepeatState() : base(StringComparer.Ordinal) { }
}

/// <summary>
/// Applies a fragment's bindings over the sanitized tree. <c>data-each</c> replaces each
/// template with one copy per element before the copy's own attributes are read, so a
/// <c>data-if</c> on the template is evaluated per copy with the item in scope.
/// <c>data-if</c> is recorded and never prunes -- fragments stay inert and the host decides
/// what to show. A <c>data-bind</c> value written into a prop is routed through that prop's
/// sink, so a bound value is held to the same contract as an authored one.
/// </summary>
public static class FragmentBinder
{
    private sealed class Context(
        FormatProfile profile,
        Func<string, IReadOnlyDictionary<string, object?>, bool> evaluateCondition,
        RepeatState? previous)
    {
        public FormatProfile Profile { get; } = profile;
        public Func<string, IReadOnlyDictionary<string, object?>, bool> EvaluateCondition { get; } = evaluateCondition;
        public RepeatState? Previous { get; } = previous;
        public RepeatState Next { get; } = new();
        public Dictionary<string, bool> Visibility { get; } = new(StringComparer.Ordinal);
        public List<FragmentCondition> Conditions { get; } = [];
        public List<FragmentRepeat> Repeats { get; } = [];
        public List<FragmentDiagnostic> Diagnostics { get; } = [];
        public int RemainingCopies { get; set; } = Repeat.MaxCopies;
    }

    /// <summary>Binds with XEG evaluating every <c>data-if</c> in its own scope.</summary>
    public static BoundTree Bind(
        IReadOnlyList<FragmentNode> tree,
        IReadOnlyDictionary<string, object?> bindings,
        FormatProfile profile,
        RepeatState? previous = null) =>
        Bind(tree, bindings, profile, Xeg.EvaluateCondition, previous);

    /// <summary>Binds with a caller-supplied <c>data-if</c> evaluator, applied in every scope.</summary>
    public static BoundTree Bind(
        IReadOnlyList<FragmentNode> tree,
        IReadOnlyDictionary<string, object?> bindings,
        FormatProfile profile,
        Func<string, bool> evaluateCondition) =>
        Bind(tree, bindings, profile, (expression, _) => evaluateCondition(expression), null);

    private static BoundTree Bind(
        IReadOnlyList<FragmentNode> tree,
        IReadOnlyDictionary<string, object?> bindings,
        FormatProfile profile,
        Func<string, IReadOnlyDictionary<string, object?>, bool> evaluateCondition,
        RepeatState? previous)
    {
        var ctx = new Context(profile, evaluateCondition, previous);
        var bound = BindChildren(tree, bindings, ctx, [], [], []);
        return new BoundTree(bound, ctx.Visibility, ctx.Conditions)
        {
            Repeats = ctx.Repeats,
            Diagnostics = ctx.Diagnostics,
            RepeatState = ctx.Next,
        };
    }

    private static string SourcePointer(IReadOnlyList<int> path) =>
        string.Concat(path.Select(index => "/" + index));

    private static List<FragmentNode> BindChildren(
        IReadOnlyList<FragmentNode> nodes,
        IReadOnlyDictionary<string, object?> bindings,
        Context ctx,
        IReadOnlyList<int> parentPath,
        IReadOnlyList<int> parentSource,
        IReadOnlyList<object> within)
    {
        var output = new List<FragmentNode>();
        for (var index = 0; index < nodes.Count; index++)
        {
            var node = nodes[index];
            List<int> source = [.. parentSource, index];
            if (node is FragmentNode.Element element && element.Props.Get("data-each") is PropValue.Str each)
            {
                ExpandRepeat(element, each.Value, bindings, ctx, parentPath, source, within, output);
                continue;
            }
            output.Add(BindNode(node, bindings, ctx, [.. parentPath, output.Count], source, within));
        }
        return output;
    }

    private static void ExpandRepeat(
        FragmentNode.Element template,
        string eachSource,
        IReadOnlyDictionary<string, object?> bindings,
        Context ctx,
        IReadOnlyList<int> parentPath,
        List<int> source,
        IReadOnlyList<object> within,
        List<FragmentNode> output)
    {
        var keySource = template.Props.Get("data-key") is PropValue.Str key ? key.Value : null;
        Repeat.TryParseHeader(eachSource, out var header, out _);

        List<object?> items = header is null ? [] : Repeat.Items(header, bindings);
        if (items.Count > ctx.RemainingCopies)
        {
            ctx.Diagnostics.Add(new FragmentDiagnostic(
                DiagnosticCodes.RepeatLimit,
                DiagnosticSeverity.Warning,
                SourcePointer(source),
                template.Name,
                $"repeat truncated to {ctx.RemainingCopies} of {items.Count} copies; a render produces at most {Repeat.MaxCopies}",
                "data-each"));
            items = items.Take(ctx.RemainingCopies).ToList();
        }
        ctx.RemainingCopies -= items.Count;

        List<Dictionary<string, object?>> scopes = header is null
            ? []
            : items.Select((item, index) => Repeat.Scope(bindings, header, item, index)).ToList();

        var resolution = keySource is null
            ? new RepeatKeyResolution(RepeatModes.Replace, RepeatDiff.ReplaceKeys(scopes.Count), null)
            : RepeatDiff.ResolveKeys(scopes.Select(scope => Xeg.Evaluate(keySource, scope)).ToList());
        if (resolution.Problem is { } problem)
        {
            var message = problem == DiagnosticCodes.DuplicateKey
                ? $"data-key \"{keySource}\" produced a duplicate key; copies are keyed by index"
                : $"data-key \"{keySource}\" produced a key that is not a string or a number; copies are keyed by index";
            ctx.Diagnostics.Add(new FragmentDiagnostic(
                problem, DiagnosticSeverity.Warning, SourcePointer(source), template.Name, message, "data-key"));
        }

        var site = new RepeatSite(source, within);
        (string, IReadOnlyList<object>)? previous =
            ctx.Previous is not null && ctx.Previous.TryGetValue(site.Id, out var prior) ? prior : null;
        ctx.Next[site.Id] = (resolution.Mode, resolution.Keys);

        ctx.Repeats.Add(new FragmentRepeat(
            site,
            parentPath,
            output.Count,
            scopes.Count,
            eachSource,
            keySource,
            resolution.Mode,
            resolution.Keys,
            RepeatDiff.Diff(previous, (resolution.Mode, resolution.Keys))));

        var props = template.Props.Clone();
        props.Remove("data-each");
        props.Remove("data-key");
        var copy = template with { Props = props };
        for (var index = 0; index < scopes.Count; index++)
        {
            List<object> copyWithin = [.. within, resolution.Keys[index]];
            output.Add(BindNode(copy, scopes[index], ctx, [.. parentPath, output.Count], source, copyWithin));
        }
    }

    /// <summary>
    /// A bound value the target prop cannot take. The node's reachable props are the ones
    /// its vocabulary lists, so a <c>data-bind</c> aimed at any other prop writes nothing;
    /// the drop is reported rather than silent.
    /// </summary>
    private static FragmentDiagnostic BindRefusal(
        string node, string prop, PropRouteRefusal refusal, IReadOnlyList<int> path) =>
        new(
            refusal == PropRouteRefusal.Undeclared ? DiagnosticCodes.UnknownProp : DiagnosticCodes.UnsafeProp,
            DiagnosticSeverity.Warning,
            string.Concat(path.Select(index => $"/{index}")),
            node,
            refusal == PropRouteRefusal.Undeclared
                ? $"data-bind target \"{prop}\" is not declared on node \"{node}\"; the bound value was dropped"
                : $"data-bind value for prop \"{prop}\" on node \"{node}\" was rejected by its sink",
            prop);

    /// <summary>
    /// Resolves what a <c>data-bind</c> writes, or <c>null</c> when it writes nothing.
    ///
    /// A value renders through <c>str()</c> on both paths, so a bare name renders exactly as
    /// the same name inside an expression does: <c>null</c> is the empty string, <c>0</c> is
    /// <c>"0"</c>.
    ///
    /// The paths differ only in absence. A bare name whose binding is undeclared, or whose
    /// path resolved to nothing, writes nothing, so the fragment's authored fallback survives.
    /// An expression always writes, because a computed result has no absent state to fall
    /// back from.
    /// </summary>
    public static string? BindValue(string source, IReadOnlyDictionary<string, object?> bindings)
    {
        var parsed = Xeg.ParseCached(source);
        if (parsed is { Kind: ExpressionKind.Expression })
            return ExprValue.Render(Xeg.EvaluateAst(parsed.Ast, bindings));

        var name = parsed?.Ast is Ast.Name named ? named.Value : source;
        return bindings.TryGetValue(name, out var value)
            ? ExprValue.Render(ExprValue.Normalize(value))
            : null;
    }

    private static FragmentNode BindNode(
        FragmentNode node,
        IReadOnlyDictionary<string, object?> bindings,
        Context ctx,
        IReadOnlyList<int> path,
        IReadOnlyList<int> source,
        IReadOnlyList<object> within)
    {
        if (node is FragmentNode.Text text)
        {
            return text.Segments is null
                ? text
                : new FragmentNode.Text(Interpolation.ResolveSegments(text.Segments, bindings));
        }

        if (node is not FragmentNode.Element element) return node;

        var profile = ctx.Profile;
        var props = element.Props.Clone();
        var children = BindChildren(element.Children, bindings, ctx, path, source, within);

        if (props.Get("data-if") is PropValue.Str condition)
        {
            var visible = ctx.EvaluateCondition(condition.Value, bindings);
            ctx.Visibility[condition.Value] = visible;
            ctx.Conditions.Add(new FragmentCondition(path, condition.Value, visible));
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
                var routed = RoutePropValueDetailed(profile, element.Name, target, written, out var refusal);
                if (routed is not null) props.Set(target, routed);
                else ctx.Diagnostics.Add(BindRefusal(element.Name, target, refusal, path));
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
        FormatProfile profile, string nodeName, string prop, string value) =>
        RoutePropValueDetailed(profile, nodeName, prop, value, out _);

    /// <summary>
    /// <see cref="RoutePropValue"/>, reporting through <paramref name="refusal"/> why a
    /// <c>null</c> result was refused so the caller can surface it.
    /// </summary>
    public static PropValue? RoutePropValueDetailed(
        FormatProfile profile, string nodeName, string prop, string value, out PropRouteRefusal refusal)
    {
        refusal = PropRouteRefusal.Rejected;

        if (profile.NodeDefinition(nodeName) is { } declared)
        {
            if (FormatProfiles.ProtocolProps.Contains(prop)) return PropValue.Of(value);
            if (!declared.Props.TryGetValue(prop, out var definition))
            {
                refusal = PropRouteRefusal.Undeclared;
                return null;
            }
            if (definition.Sink == Sink.Text) return PropValue.Of(value);
            var cleaned = VocabularySanitizer.ApplySink(definition.Sink, value, profile.Schemes);
            return cleaned is null ? null : PropValue.Of(cleaned);
        }

        var lower = prop.ToLowerInvariant();
        if (!profile.SpeaksHtml || !HtmlRules.IsAllowedAttribute(lower))
        {
            refusal = PropRouteRefusal.Undeclared;
            return null;
        }
        if (lower is "href" or "src")
        {
            var cleaned = HtmlRules.SanitizeUri(value, lower, profile.Schemes);
            return cleaned is null ? null : PropValue.Of(cleaned);
        }
        if (lower == "style") return PropValue.Of(HtmlRules.SanitizeStyleValue(value));
        return PropValue.Of(value);
    }
}
