using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime.Expressions;

namespace Xript.Runtime.Fragments;

public abstract record FragmentNode
{
    /// <summary>
    /// A text node. <c>Value</c> is the authored source, escapes intact, so the HTML
    /// projection round-trips byte for byte. <c>Segments</c> is present iff the node opened
    /// at least one interpolation site under an <c>interpolate</c> fill -- null, never an
    /// empty list, otherwise, so a non-interpolating fragment produces a tree identical to
    /// one parsed without the mode.
    /// </summary>
    public sealed record Text(string Value) : FragmentNode
    {
        public List<TextSegment>? Segments { get; init; }
    }

    public sealed record Element : FragmentNode
    {
        /// <summary>The node name, case preserved exactly as authored.</summary>
        public string Name { get; init; } = "";

        /// <summary>Declaration order preserved. A bare HTML attribute (<c>disabled</c>) carries <c>true</c>.</summary>
        public PropMap Props { get; init; } = new();

        public List<FragmentNode> Children { get; init; } = [];

        /// <summary>
        /// Serialization hint: the source closed this node with <c>/&gt;</c> even though it is
        /// not a void element. Carries no semantics -- it exists so the HTML projection can
        /// reproduce the source's syntax byte for byte.
        /// </summary>
        public bool SelfClosing { get; init; }
    }
}

public static class FragmentTree
{
    /// <summary>
    /// Prop names that would corrupt the prototype chain of a JavaScript object the tree is
    /// assembled into. .NET has no prototype chain, but the names are rejected in every
    /// vocabulary so diagnostics and output stay identical across runtimes.
    /// </summary>
    public static readonly HashSet<string> ForbiddenPropNames =
        new(["__proto__", "constructor", "prototype"], StringComparer.Ordinal);

    public static string EscapeHtml(string text) =>
        text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    /// <summary>
    /// Escapes a value for placement inside a double-quoted attribute.
    /// </summary>
    /// <remarks>
    /// Quoting alone would make the value inert — a double-quoted attribute does not
    /// terminate until an unescaped <c>"</c>, and that character is escaped here. Angle
    /// brackets and the single quote are escaped anyway so the serialized attribute never
    /// carries a raw <c>&lt;script&gt;</c> substring: downstream consumers scan output for
    /// markup-shaped text, and a value that reads as a tag defeats those checks even when
    /// it cannot execute.
    /// </remarks>
    public static string EscapeAttrValue(string value) =>
        value.Replace("&", "&amp;")
             .Replace("\"", "&quot;")
             .Replace("'", "&#39;")
             .Replace("<", "&lt;")
             .Replace(">", "&gt;");

    /// <summary>
    /// Serializes a tree to HTML.
    /// </summary>
    /// <param name="tree">the tree to serialize</param>
    /// <param name="profile">
    /// the vocabulary in scope, read for each prop's declared JSON Schema <c>type</c> so a
    /// declared <c>array</c> prop projects as JSON; omit for the built-in HTML vocabulary,
    /// which declares none
    /// </param>
    public static string ToHtml(IReadOnlyList<FragmentNode> tree, FormatProfile? profile = null)
    {
        var builder = new StringBuilder();
        foreach (var node in tree) AppendHtml(builder, node, profile);
        return builder.ToString();
    }

    private static void AppendHtml(StringBuilder builder, FragmentNode node, FormatProfile? profile)
    {
        if (node is FragmentNode.Text text)
        {
            builder.Append(EscapeHtml(text.Value));
            return;
        }

        var element = (FragmentNode.Element)node;
        builder.Append('<').Append(element.Name);
        var definition = profile?.NodeDefinition(element.Name);

        foreach (var (key, value) in element.Props)
        {
            if (!HtmlRules.IsValidAttributeName(key)) continue;
            if (value is PropValue.Bool { Value: true })
            {
                builder.Append(' ').Append(key);
                continue;
            }
            if (value is PropValue.Bool { Value: false } or PropValue.Nul) continue;
            var declaredType = definition is not null && definition.Props.TryGetValue(key, out var prop)
                ? prop.Type
                : null;
            builder.Append(' ').Append(key).Append("=\"")
                .Append(EscapeAttrValue(PropValue.AttributeValue(value, declaredType))).Append('"');
        }

        if (HtmlRules.VoidElements.Contains(element.Name)
            || (element.SelfClosing && element.Children.Count == 0))
        {
            builder.Append(" />");
            return;
        }

        builder.Append('>');
        foreach (var child in element.Children) AppendHtml(builder, child, profile);
        builder.Append("</").Append(element.Name).Append('>');
    }

    /// <summary>
    /// Projects a fragment tree into J5ML array form.
    /// </summary>
    /// <remarks>
    /// Serialization runs through the <c>J5ml</c> package rather than writing the
    /// arrays directly, because J5ML normatively orders attribute names by Unicode
    /// code point on serialization. That is not a language's default string
    /// comparison, so the rule is delegated to the implementation that owns it
    /// instead of restated here.
    /// </remarks>
    public static JsonArray ToJsml(IReadOnlyList<FragmentNode> tree) =>
        new([.. tree.Select(node =>
            JsonNode.Parse(J5ml.J5mlDocument.Stringify(ToJ5ml(node))))]);

    private static J5ml.Node ToJ5ml(FragmentNode node)
    {
        if (node is FragmentNode.Text text) return new J5ml.Text(text.Value);

        var element = (FragmentNode.Element)node;
        var attrs = new Dictionary<string, JsonNode?>();
        foreach (var (key, value) in element.Props) attrs[key] = value.ToJson();
        return new J5ml.Element(element.Name, attrs, [.. element.Children.Select(ToJ5ml)]);
    }

    public static List<FragmentNode> FromJsml(IEnumerable<JsonNode?> nodes)
    {
        var tree = new List<FragmentNode>();
        foreach (var node in nodes)
        {
            var converted = JsmlNodeToTree(node);
            if (converted is not null) tree.Add(converted);
        }
        return tree;
    }

    private static FragmentNode? JsmlNodeToTree(JsonNode? node)
    {
        if (node is JsonValue value && value.TryGetValue<JsonElement>(out var element)
            && element.ValueKind == JsonValueKind.String)
            return new FragmentNode.Text(element.GetString() ?? "");
        if (node is JsonValue direct && direct.TryGetValue<string>(out var str))
            return new FragmentNode.Text(str);

        if (node is not JsonArray array || array.Count == 0) return null;

        var nameNode = array[0];
        if (nameNode is not JsonValue nameValue || !TryGetString(nameValue, out var name)) return null;

        var props = new PropMap();
        var childStart = 1;

        if (array.Count > 1 && array[1] is JsonObject rawProps)
        {
            foreach (var (key, raw) in rawProps)
            {
                var converted = PropValue.FromJson(raw);
                if (converted is not null) props.Set(key, converted);
            }
            childStart = 2;
        }

        var children = new List<FragmentNode>();
        for (var i = childStart; i < array.Count; i++)
        {
            var child = JsmlNodeToTree(array[i]);
            if (child is not null) children.Add(child);
        }

        return new FragmentNode.Element { Name = name, Props = props, Children = children };
    }

    private static bool TryGetString(JsonValue value, out string result)
    {
        if (value.TryGetValue<string>(out var direct))
        {
            result = direct;
            return true;
        }
        if (value.TryGetValue<JsonElement>(out var element) && element.ValueKind == JsonValueKind.String)
        {
            result = element.GetString() ?? "";
            return true;
        }
        result = "";
        return false;
    }
}
