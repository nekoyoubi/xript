namespace Xript.Runtime.Expressions;

/// <summary>A parsed <c>data-each</c> header.</summary>
/// <param name="Item">The name each element binds to inside a copy.</param>
/// <param name="Index">The optional explicit index name. <c>$index</c> is bound regardless.</param>
/// <param name="Source">The XEG source on the right of <c>in</c>.</param>
public sealed record RepeatHeader(string Item, string? Index, string Source, Expression Expression);

/// <summary>
/// <c>data-each</c> headers: <c>item in expr</c> and <c>(item, index) in expr</c>. Everything
/// here is total: a header that does not parse, an expression that fails, and a value that
/// is not an array all repeat zero times.
/// </summary>
public static class Repeat
{
    /// <summary>The implicit index name, in scope inside every copy.</summary>
    public const string IndexName = "$index";

    /// <summary>
    /// The most copies one render may produce across every <c>data-each</c> in a fragment.
    /// Nested repeats multiply, so without a ceiling a template's render cost would grow with
    /// the host's data raised to the nesting depth.
    /// </summary>
    public const int MaxCopies = 10000;

    private static readonly HashSet<string> ReservedBinderNames =
        new(["true", "false", "null", "in"], StringComparer.Ordinal);

    private static bool IsWhitespace(char ch) => ch is ' ' or '\t' or '\n' or '\r' or '\f' or '\v';

    private static bool IsIdentStart(char ch) => char.IsAsciiLetter(ch) || ch == '_' || ch == '$';

    private static bool IsIdentPart(char ch) => char.IsAsciiLetterOrDigit(ch) || ch == '_' || ch == '$';

    /// <summary>
    /// Parses a <c>data-each</c> header. The binder names follow XEG's identifier rule,
    /// <c>in</c> must be followed by whitespace, and everything after it must be a member
    /// of the grammar.
    /// </summary>
    public static bool TryParseHeader(string source, out RepeatHeader? header, out string? error)
    {
        (header, error) = ParseHeader(source);
        return header is not null;
    }

    private static (RepeatHeader? Header, string? Error) ParseHeader(string source)
    {
        var i = 0;

        void Skip()
        {
            while (i < source.Length && IsWhitespace(source[i])) i++;
        }

        string? Ident()
        {
            if (i >= source.Length || !IsIdentStart(source[i])) return null;
            var start = i++;
            while (i < source.Length && IsIdentPart(source[i])) i++;
            return source[start..i];
        }

        static (RepeatHeader?, string?) Fail(string message) => (null, message);

        Skip();
        string? item;
        string? index = null;

        if (i < source.Length && source[i] == '(')
        {
            i++;
            Skip();
            item = Ident();
            if (item is null) return Fail("expected an item name after '('");
            Skip();
            if (i < source.Length && source[i] == ',')
            {
                i++;
                Skip();
                index = Ident();
                if (index is null) return Fail("expected an index name after ','");
                Skip();
            }
            if (i >= source.Length || source[i] != ')') return Fail("expected ')' to close the binder list");
            i++;
            Skip();
        }
        else
        {
            item = Ident();
            if (item is null) return Fail("expected 'item in expression' or '(item, index) in expression'");
            if (i >= source.Length || !IsWhitespace(source[i])) return Fail("expected whitespace before 'in'");
            Skip();
        }

        if (i + 2 >= source.Length || source[i] != 'i' || source[i + 1] != 'n' || !IsWhitespace(source[i + 2]))
            return Fail("expected 'in' followed by an expression");
        i += 2;

        foreach (var name in index is null ? new[] { item } : new[] { item, index })
        {
            if (ReservedBinderNames.Contains(name)) return Fail($"'{name}' cannot name a repeat binding");
        }
        if (index is not null && index == item)
            return Fail($"the item and index cannot share the name '{item}'");

        var end = source.Length;
        while (end > i && IsWhitespace(source[end - 1])) end--;
        Skip();
        if (i >= end) return Fail("expected an expression after 'in'");

        var rest = source[i..end];
        var expression = Xeg.ParseCached(rest);
        if (expression is null)
        {
            ExpressionParser.TryParse(rest, out _, out var parseError);
            return Fail(parseError?.Message ?? "invalid expression");
        }

        return (new RepeatHeader(item, index, rest, expression), null);
    }

    /// <summary>
    /// The elements a header repeats over. A failing expression and a non-array value are
    /// both empty: a repeat renders zero copies rather than aborting the render.
    /// </summary>
    public static List<object?> Items(RepeatHeader header, IReadOnlyDictionary<string, object?> bindings) =>
        Xeg.EvaluateAst(header.Expression.Ast, bindings) is List<object?> items ? items : [];

    /// <summary>
    /// The bindings a copy evaluates against: the enclosing scope, with <c>$index</c>, the
    /// item name, and the index name layered on top. Inner names shadow outer ones.
    /// </summary>
    public static Dictionary<string, object?> Scope(
        IReadOnlyDictionary<string, object?> bindings, RepeatHeader header, object? item, int index)
    {
        var scope = new Dictionary<string, object?>(bindings, StringComparer.Ordinal)
        {
            [IndexName] = (double)index,
            [header.Item] = item,
        };
        if (header.Index is not null) scope[header.Index] = (double)index;
        return scope;
    }
}
