using System.Globalization;
using System.Text.RegularExpressions;
namespace Xript.Runtime.Fragments;

public sealed record HtmlAttribute(string Name, string Value);

public enum HtmlTokenType
{
    Text,
    Open,
    Close,
    Comment,
}

public sealed record HtmlToken
{
    public HtmlTokenType Type { get; init; }

    /// <summary>Text/comment payload.</summary>
    public string Value { get; init; } = "";

    /// <summary>The lower-cased tag name, for rule lookups.</summary>
    public string Tag { get; init; } = "";

    /// <summary>The tag name exactly as authored, for vocabularies that preserve case.</summary>
    public string RawTag { get; init; } = "";

    public IReadOnlyList<HtmlAttribute> Attributes { get; init; } = [];

    public bool SelfClosing { get; init; }
}

/// <summary>
/// A tolerant HTML tokenizer matching the reference implementation exactly: no entity
/// decoding, no attribute-name folding, and unterminated constructs degrade to text.
/// </summary>
public static class HtmlTokenizer
{
    private const string ReplacementCharacter = "\ufffd";

    /// <summary>
    /// A raw U+0000 is a parse error wherever it appears. In a tag name, an attribute
    /// name, or an attribute value the parser substitutes U+FFFD; in ordinary text the
    /// tree builder discards the character outright, which is why the two helpers differ.
    /// A character reference that resolves to U+0000 is not raw and always becomes
    /// U+FFFD, so entity decoding runs after the raw pass.
    /// </summary>
    internal static string ReplaceNulls(string text) => text.Replace("\0", ReplacementCharacter);

    private static string DropNulls(string text) => text.Replace("\0", "");

    private static readonly Dictionary<string, string> NamedEntities = new(StringComparer.OrdinalIgnoreCase)
    {
        ["amp"] = "&", ["lt"] = "<", ["gt"] = ">",
        ["quot"] = "\"", ["apos"] = "'", ["nbsp"] = " ",
    };

    /// <summary>
    /// Decodes character references so a text token carries real characters rather
    /// than their encoded form. The tree is the canonical representation and the
    /// serializer escapes on the way out, so leaving references encoded here would
    /// double-escape them on a round trip.
    /// </summary>
    /// <remarks>
    /// Decoding is safe because the result lands in a text node: it is re-escaped
    /// when serialized and never reinterpreted as markup.
    /// </remarks>
    internal static string DecodeTextEntities(string text)
    {
        if (!text.Contains('&')) return text;
        return EntityPattern.Replace(text, match =>
        {
            var body = match.Groups[1].Value;
            if (body[0] == '#')
            {
                var isHex = body.Length > 1 && (body[1] == 'x' || body[1] == 'X');
                var digits = isHex ? body[2..] : body[1..];
                if (!int.TryParse(
                        digits,
                        isHex ? NumberStyles.HexNumber : NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out var codePoint))
                    return match.Value;
                if (codePoint < 0 || codePoint > 0x10ffff) return match.Value;
                if (codePoint == 0) return ReplacementCharacter;
                try { return char.ConvertFromUtf32(codePoint); }
                catch (ArgumentOutOfRangeException) { return match.Value; }
            }
            return NamedEntities.TryGetValue(body, out var named) ? named : match.Value;
        });
    }

    private static readonly Regex EntityPattern =
        new(@"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);", RegexOptions.Compiled);

    public static List<HtmlToken> Tokenize(string html)
    {
        var tokens = new List<HtmlToken>();
        var i = 0;

        while (i < html.Length)
        {
            if (html[i] == '<')
            {
                if (StartsWith(html, i, "<!--"))
                {
                    var end = html.IndexOf("-->", i + 4, StringComparison.Ordinal);
                    if (end < 0)
                    {
                        tokens.Add(new HtmlToken { Type = HtmlTokenType.Comment, Value = html[(i + 4)..] });
                        break;
                    }
                    tokens.Add(new HtmlToken { Type = HtmlTokenType.Comment, Value = html[(i + 4)..end] });
                    i = end + 3;
                    continue;
                }

                if (i + 1 < html.Length && html[i + 1] == '/')
                {
                    var end = html.IndexOf('>', i + 2);
                    if (end < 0)
                    {
                        tokens.Add(new HtmlToken
                        {
                            Type = HtmlTokenType.Text,
                            Value = DecodeTextEntities(DropNulls(html[i..])),
                        });
                        break;
                    }
                    var rawTag = ReplaceNulls(html[(i + 2)..end].Trim());
                    tokens.Add(new HtmlToken
                    {
                        Type = HtmlTokenType.Close,
                        Tag = rawTag.ToLowerInvariant(),
                        RawTag = rawTag,
                    });
                    i = end + 1;
                    continue;
                }

                if (TryParseOpenTag(html, i, out var token, out var openEnd))
                {
                    tokens.Add(token);
                    i = openEnd;
                    continue;
                }

                tokens.Add(new HtmlToken { Type = HtmlTokenType.Text, Value = "<" });
                i++;
            }
            else
            {
                var end = html.IndexOf('<', i);
                if (end < 0) end = html.Length;
                tokens.Add(new HtmlToken
                {
                    Type = HtmlTokenType.Text,
                    Value = DecodeTextEntities(DropNulls(html[i..end])),
                });
                i = end;
            }
        }

        return tokens;
    }

    private static bool StartsWith(string html, int index, string prefix) =>
        index + prefix.Length <= html.Length && string.CompareOrdinal(html, index, prefix, 0, prefix.Length) == 0;

    private static bool IsTagNameChar(char c) =>
        char.IsAsciiLetterOrDigit(c) || c == '_' || c == '.' || c == ':' || c == '-';

    private static bool TryParseOpenTag(string html, int start, out HtmlToken token, out int end)
    {
        token = null!;
        end = start;

        var i = start + 1;
        while (i < html.Length && char.IsWhiteSpace(html[i])) i++;

        var tagStart = i;
        while (i < html.Length && (IsTagNameChar(html[i]) || (html[i] == '\0' && i > tagStart))) i++;
        var rawTag = ReplaceNulls(html[tagStart..i]);
        var tag = rawTag.ToLowerInvariant();

        if (tag.Length == 0) return false;

        var attributes = new List<HtmlAttribute>();

        while (i < html.Length)
        {
            while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
            if (i >= html.Length) break;

            if (html[i] == '>')
            {
                token = Open(tag, rawTag, attributes, false);
                end = i + 1;
                return true;
            }

            if (html[i] == '/' && i + 1 < html.Length && html[i + 1] == '>')
            {
                token = Open(tag, rawTag, attributes, true);
                end = i + 2;
                return true;
            }

            if (TryParseAttribute(html, i, out var attribute, out var attrEnd))
            {
                attributes.Add(attribute);
                i = attrEnd;
            }
            else
            {
                i++;
            }
        }

        token = Open(tag, rawTag, attributes, false);
        end = i;
        return true;
    }

    private static HtmlToken Open(string tag, string rawTag, List<HtmlAttribute> attributes, bool selfClosing) =>
        new()
        {
            Type = HtmlTokenType.Open,
            Tag = tag,
            RawTag = rawTag,
            Attributes = attributes,
            SelfClosing = selfClosing,
        };

    private static bool TryParseAttribute(string html, int start, out HtmlAttribute attribute, out int end)
    {
        attribute = null!;
        var i = start;

        var nameStart = i;
        while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '=' && html[i] != '/' && html[i] != '>') i++;
        var name = ReplaceNulls(html[nameStart..i]);
        if (name.Length == 0)
        {
            end = start;
            return false;
        }

        while (i < html.Length && char.IsWhiteSpace(html[i])) i++;

        if (i >= html.Length || html[i] != '=')
        {
            attribute = new HtmlAttribute(name, "");
            end = i;
            return true;
        }

        i++;
        while (i < html.Length && char.IsWhiteSpace(html[i])) i++;

        string value;

        if (i < html.Length && (html[i] == '"' || html[i] == '\''))
        {
            var quote = html[i];
            i++;
            var valueStart = i;
            while (i < html.Length && html[i] != quote) i++;
            value = html[valueStart..i];
            if (i < html.Length) i++;
        }
        else
        {
            var valueStart = i;
            while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '>') i++;
            value = html[valueStart..i];
        }

        attribute = new HtmlAttribute(name, DecodeTextEntities(ReplaceNulls(value)));
        end = i;
        return true;
    }
}
