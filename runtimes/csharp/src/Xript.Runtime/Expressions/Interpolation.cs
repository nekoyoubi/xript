using System.Text;

namespace Xript.Runtime.Expressions;

/// <summary>
/// A piece of a segmented text node.
///
/// There is no third variant, and there never will be: a segment lives inside a text node,
/// which has no props and no children, so a resolved value has nowhere to land that would
/// make it markup.
/// </summary>
public abstract record TextSegment
{
    public sealed record Literal(string Value) : TextSegment;
    public sealed record Expr(string Source) : TextSegment;
}

public sealed record SegmentIssue(int Position, string Message);

public sealed record SegmentResult(List<TextSegment>? Segments, List<SegmentIssue> Issues);

public static class Interpolation
{
    private const string Open = "{{";
    private const string Close = "}}";
    private const string Escape = "\\{{";

    /// <summary>
    /// Segments a text node's content into literal and expression pieces.
    ///
    /// The rules, in order:
    /// <list type="number">
    /// <item><c>\{{</c> emits a literal <c>{{</c> and consumes the backslash. It is the
    /// <em>only</em> escape sequence, so <c>C:\Users</c> and a <c>\n</c> in a code sample are
    /// untouched.</item>
    /// <item>Otherwise <c>{{</c> opens a site, which closes at the first <c>}}</c>.</item>
    /// <item>An <em>unclosed</em> <c>{{</c> is literal text, not an error. Prose that says
    /// "write <c>{{</c> to interpolate" and never closes it survives intact.</item>
    /// <item><c>}}</c> outside a site is literal.</item>
    /// <item>Single <c>{</c> and <c>}</c> are never special, anywhere.</item>
    /// <item>A site that opens <em>and closes</em> but whose body is not an XEG expression is
    /// an error: once both delimiters are present the author's intent is unambiguous.</item>
    /// </list>
    /// </summary>
    public static SegmentResult SegmentText(string text)
    {
        var segments = new List<TextSegment>();
        var issues = new List<SegmentIssue>();
        var literal = new StringBuilder();
        var changed = false;
        var i = 0;

        void Flush()
        {
            if (literal.Length == 0) return;
            segments.Add(new TextSegment.Literal(literal.ToString()));
            literal.Clear();
        }

        while (i < text.Length)
        {
            if (StartsAt(text, i, Escape))
            {
                literal.Append(Open);
                changed = true;
                i += Escape.Length;
                continue;
            }

            if (!StartsAt(text, i, Open))
            {
                literal.Append(text[i]);
                i++;
                continue;
            }

            var close = text.IndexOf(Close, i + Open.Length, StringComparison.Ordinal);
            if (close < 0)
            {
                literal.Append(Open);
                i += Open.Length;
                continue;
            }

            var body = text[(i + Open.Length)..close];
            changed = true;

            if (body.Contains(Open, StringComparison.Ordinal))
            {
                issues.Add(new SegmentIssue(i, "nested '{{' inside an interpolation site"));
            }
            else if (!ExpressionParser.TryParse(body.Trim(), out _, out var error))
            {
                issues.Add(new SegmentIssue(i + Open.Length + error!.Position, error.Message));
            }

            Flush();
            segments.Add(new TextSegment.Expr(body.Trim()));
            i = close + Close.Length;
        }

        if (!changed) return new SegmentResult(null, issues);

        Flush();
        return new SegmentResult(segments, issues);
    }

    /// <summary>
    /// Whether a text node could open a site at all. Cheap enough to run over every text node
    /// before doing the segmenting scan.
    /// </summary>
    public static bool ContainsInterpolation(string text) =>
        text.Contains(Open, StringComparison.Ordinal);

    /// <summary>
    /// Resolves segments to their rendered text.
    ///
    /// Every piece joins as plain text. The tokenizer is never re-entered, so a value that
    /// itself contains <c>{{</c> or a tag is inert.
    /// </summary>
    public static string ResolveSegments(
        IReadOnlyList<TextSegment> segments,
        IReadOnlyDictionary<string, object?> bindings)
    {
        var builder = new StringBuilder();
        foreach (var segment in segments)
        {
            builder.Append(segment switch
            {
                TextSegment.Literal literal => literal.Value,
                TextSegment.Expr expr => ExprValue.Render(Xeg.Evaluate(expr.Source, bindings)),
                _ => "",
            });
        }
        return builder.ToString();
    }

    /// <summary>Re-serializes segments back to their authored source, for round-trip checks.</summary>
    public static string SegmentsToSource(IReadOnlyList<TextSegment> segments)
    {
        var builder = new StringBuilder();
        foreach (var segment in segments)
        {
            builder.Append(segment switch
            {
                TextSegment.Literal literal => literal.Value.Replace(Open, Escape, StringComparison.Ordinal),
                TextSegment.Expr expr => $"{{{{ {expr.Source} }}}}",
                _ => "",
            });
        }
        return builder.ToString();
    }

    private static bool StartsAt(string text, int index, string token) =>
        index + token.Length <= text.Length
        && string.CompareOrdinal(text, index, token, 0, token.Length) == 0;
}
