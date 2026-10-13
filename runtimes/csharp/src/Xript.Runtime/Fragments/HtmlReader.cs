using System.Text;

namespace Xript.Runtime.Fragments;

public sealed record StrippedAttribute(string Element, string Attribute);

public sealed record HtmlSanitizeResult(
    string Html,
    List<string> StrippedElements,
    List<StrippedAttribute> StrippedAttributes);

public static class HtmlReader
{
    /// <summary>
    /// Sanitizes an HTML string against the built-in HTML vocabulary.
    /// </summary>
    /// <remarks>
    /// The result is serialized from the sanitized tree, never patched out of the
    /// input string, so the output is always well-formed: a source that leaves an
    /// element unclosed still yields balanced markup. Unbalanced output would
    /// re-parse against whatever context a caller inserts it into.
    ///
    /// Sanitization always runs against the built-in profile rather than a caller's,
    /// which bounds the recursion: the built-in profile declares no sinks, so a
    /// nested <c>html</c> sink cannot re-enter this method.
    /// </remarks>
    public static HtmlSanitizeResult SanitizeDetailed(string input)
    {
        var profile = FormatProfiles.Builtins["text/html"];
        var parsed = VocabularySanitizer.Sanitize(ToTree(input, profile), profile);
        return new HtmlSanitizeResult(
            FragmentTree.ToHtml(parsed.Tree), parsed.StrippedElements, parsed.StrippedAttributes);
    }

    public static string Sanitize(string input) => SanitizeDetailed(input).Html;

    private static List<HtmlAttribute> SanitizeAttributes(
        string tag, IReadOnlyList<HtmlAttribute> attributes, List<StrippedAttribute> strippedLog)
    {
        var result = new List<HtmlAttribute>();

        foreach (var attr in attributes)
        {
            var lowerName = attr.Name.ToLowerInvariant();

            if (!HtmlRules.IsAllowedAttribute(lowerName))
            {
                strippedLog.Add(new StrippedAttribute(tag, lowerName));
                continue;
            }

            if (lowerName is "href" or "src")
            {
                var cleaned = HtmlRules.SanitizeUri(attr.Value, lowerName);
                if (cleaned is null)
                {
                    strippedLog.Add(new StrippedAttribute(tag, lowerName));
                    continue;
                }
                result.Add(new HtmlAttribute(lowerName, cleaned));
                continue;
            }

            if (lowerName == "style")
            {
                var cleaned = HtmlRules.SanitizeStyleValue(attr.Value);
                if (cleaned.Length > 0) result.Add(new HtmlAttribute(lowerName, cleaned));
                continue;
            }

            result.Add(new HtmlAttribute(HtmlRules.CanonicalAttributeName(lowerName), attr.Value));
        }

        return result;
    }

    private static void AppendOpenTag(
        StringBuilder builder, string tag, List<HtmlAttribute> attributes, bool selfClosing)
    {
        builder.Append('<').Append(tag);
        foreach (var attr in attributes)
        {
            if (attr.Value.Length == 0) builder.Append(' ').Append(attr.Name);
            else builder.Append(' ').Append(attr.Name).Append("=\"")
                .Append(FragmentTree.EscapeAttrValue(attr.Value)).Append('"');
        }
        builder.Append(selfClosing ? " />" : ">");
    }

    private static string CollectStyleContent(List<HtmlToken> tokens, int styleOpenIndex)
    {
        var content = new StringBuilder();
        for (var i = styleOpenIndex + 1; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Type == HtmlTokenType.Close && token.Tag == "style") break;
            if (token.Type == HtmlTokenType.Text) content.Append(token.Value);
        }
        return content.ToString();
    }

    /// <summary>
    /// Parses an HTML source string into an unsanitized fragment tree, preserving node
    /// and prop name casing. Vocabulary rules are applied afterwards by the sanitizer.
    ///
    /// HTML's raw-text elements (<c>style</c>, and every element the vocabulary strips
    /// outright) do not have their content parsed as markup: a <c>&lt;/div&gt;</c> inside
    /// one is text, so parsing it as markup would let content escape the region that was
    /// supposed to swallow it. A node the active vocabulary declares by name is never
    /// treated as a raw-text element, even when an HTML element shares the name.
    /// </summary>
    public static List<FragmentNode> ToTree(string input, FormatProfile? profile = null)
    {
        var tokens = HtmlTokenizer.Tokenize(input);
        var root = new FragmentNode.Element { Name = "#root" };
        var stack = new List<FragmentNode.Element> { root };
        var skipUntil = "";
        var skipIsRawText = false;

        bool HtmlRulesApply(string rawName)
        {
            if (profile is null) return true;
            return profile.SpeaksHtml && !profile.AnyVocabularyDeclares(rawName);
        }

        for (var idx = 0; idx < tokens.Count; idx++)
        {
            var token = tokens[idx];
            var parent = stack[^1];

            if (skipUntil.Length > 0)
            {
                if (token.Type == HtmlTokenType.Close && token.Tag == skipUntil)
                {
                    skipUntil = "";
                    continue;
                }
                // A stripped element that never closes must not eat the rest of the
                // document: an ancestor's close tag implicitly closes it. The stripped
                // element was never pushed, so anything still on the stack is an
                // ancestor. Raw-text elements keep skipping, matching the parser.
                var ancestorCloses = token.Type == HtmlTokenType.Close
                    && !skipIsRawText
                    && stack.Exists(element =>
                        string.Equals(element.Name, token.Tag, StringComparison.OrdinalIgnoreCase));
                if (!ancestorCloses) continue;
                skipUntil = "";
            }

            switch (token.Type)
            {
                case HtmlTokenType.Text:
                    parent.Children.Add(new FragmentNode.Text(token.Value));
                    break;

                case HtmlTokenType.Comment:
                    break;

                case HtmlTokenType.Open:
                {
                    var element = new FragmentNode.Element
                    {
                        Name = token.RawTag,
                        Props = AttributesToProps(token.Attributes),
                        SelfClosing = token.SelfClosing && !HtmlRules.VoidElements.Contains(token.Tag),
                    };
                    parent.Children.Add(element);

                    var rawText = HtmlRulesApply(token.RawTag)
                        && (token.Tag == "style" || HtmlRules.StrippedElements.Contains(token.Tag))
                        && !(HtmlRules.SvgTextElements.Contains(token.Tag) && InsideSvg(stack));

                    if (rawText)
                    {
                        if (token.Tag == "style")
                        {
                            var cleaned = HtmlRules.SanitizeStyleBlock(CollectStyleContent(tokens, idx));
                            if (cleaned.Length > 0) element.Children.Add(new FragmentNode.Text(cleaned));
                        }
                        if (!token.SelfClosing && !HtmlRules.VoidElements.Contains(token.Tag))
                        {
                            skipUntil = token.Tag;
                            skipIsRawText = HtmlRules.RawTextElements.Contains(token.Tag);
                        }
                        break;
                    }

                    if (token.SelfClosing || HtmlRules.VoidElements.Contains(token.Tag)) break;
                    stack.Add(element);
                    break;
                }

                case HtmlTokenType.Close:
                {
                    if (HtmlRules.VoidElements.Contains(token.Tag)) break;
                    var depth = stack.Count - 1;
                    while (depth > 0 && !string.Equals(
                        stack[depth].Name.ToLowerInvariant(), token.Tag, StringComparison.Ordinal)) depth--;
                    if (depth > 0) stack.RemoveRange(depth, stack.Count - depth);
                    break;
                }
            }
        }

        return root.Children;
    }

    /// <summary>
    /// Whether an open <c>&lt;svg&gt;</c> encloses the insertion point. Inside SVG the HTML
    /// parser reads <c>&lt;title&gt;</c> as a foreign element with ordinary content, not as
    /// the document title's raw-text region.
    /// </summary>
    private static bool InsideSvg(List<FragmentNode.Element> stack) =>
        stack.Exists(element => string.Equals(element.Name, "svg", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// A repeated attribute name resolves to its first occurrence: the parser discards a
    /// duplicate rather than overwriting the one already collected. Taking the last would
    /// disagree with what a browser reads out of the same source, so a value the browser
    /// never honours could be the one that gets validated.
    /// </summary>
    private static PropMap AttributesToProps(IReadOnlyList<HtmlAttribute> attributes)
    {
        var props = new PropMap();
        foreach (var attr in attributes)
        {
            if (props.ContainsKey(attr.Name)) continue;
            props.Set(attr.Name, attr.Value.Length == 0 ? PropValue.True : PropValue.Of(attr.Value));
        }
        return props;
    }
}
