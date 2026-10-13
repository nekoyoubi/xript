using Xript.Runtime.Expressions;

namespace Xript.Runtime.Fragments;

/// <summary>How a repeat's copies are identified across updates.</summary>
public static class RepeatModes
{
    /// <summary>Every copy has a distinct <c>data-key</c>; updates patch by key.</summary>
    public const string Keyed = "keyed";

    /// <summary><c>data-key</c> produced a duplicate or invalid key; copies fall back to position.</summary>
    public const string Index = "index";

    /// <summary>No <c>data-key</c>; updates replace the repeated range.</summary>
    public const string Replace = "replace";
}

/// <summary>
/// Identifies a repeat across renders: its template's source path and the keys of the copies
/// enclosing it. A key is a <c>string</c> or a <c>double</c>.
/// </summary>
public sealed record RepeatSite(IReadOnlyList<int> Template, IReadOnlyList<object> Within)
{
    /// <summary>A stable string for the site, for keying per-instance repeat state.</summary>
    public string Id =>
        string.Join(".", Template) + "|" + string.Join("\u0000", Within.Select(RepeatDiff.KeyToken));
}

/// <summary>
/// One step of turning the previous render's copies into this render's. <c>From</c> is set
/// for <c>remove</c>, <c>reuse</c>, and <c>move</c>; <c>To</c> for <c>insert</c>, <c>reuse</c>,
/// and <c>move</c>.
/// </summary>
public sealed record RepeatPatchOp(string Op, object Key, int? From, int? To);

/// <summary>One <c>data-each</c> expansion in a bound tree.</summary>
/// <param name="Path">Child-index path of the copies' parent in the bound tree; empty is the root.</param>
/// <param name="Start">Index of the first copy among the parent's children.</param>
/// <param name="Expression">The <c>data-each</c> source, verbatim.</param>
/// <param name="Key">The <c>data-key</c> source, or null when the template has none.</param>
/// <param name="Mode">One of <see cref="RepeatModes"/>.</param>
public sealed record FragmentRepeat(
    RepeatSite Site,
    IReadOnlyList<int> Path,
    int Start,
    int Count,
    string Expression,
    string? Key,
    string Mode,
    IReadOnlyList<object> Keys,
    IReadOnlyList<RepeatPatchOp> Patch);

/// <summary>The keys a repeat resolved to, and what went wrong with them if anything did.</summary>
public sealed record RepeatKeyResolution(string Mode, IReadOnlyList<object> Keys, string? Problem);

public static class RepeatDiff
{
    internal static string KeyToken(object key) => key switch
    {
        double d => "n:" + ExprValue.FormatNumber(d),
        string s => "s:" + s,
        _ => "x:" + key,
    };

    private static List<object> IndexKeys(int count) =>
        Enumerable.Range(0, count).Select(i => (object)(double)i).ToList();

    /// <summary>Index keys for a repeat with no <c>data-key</c>.</summary>
    public static List<object> ReplaceKeys(int count) => IndexKeys(count);

    /// <summary>
    /// Resolves a repeat's keys from each copy's evaluated <c>data-key</c>. A key must be a
    /// string or a finite number. One invalid or duplicated key drops the whole repeat to
    /// index keying, because a key set with a hole in it cannot say which copy is which.
    /// </summary>
    public static RepeatKeyResolution ResolveKeys(IReadOnlyList<object?> values)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var duplicate = false;
        foreach (var value in values)
        {
            if (value is not string && !(value is double d && double.IsFinite(d)))
                return new RepeatKeyResolution(RepeatModes.Index, IndexKeys(values.Count), DiagnosticCodes.InvalidKey);
            if (!seen.Add(KeyToken(value))) duplicate = true;
        }
        if (duplicate)
            return new RepeatKeyResolution(RepeatModes.Index, IndexKeys(values.Count), DiagnosticCodes.DuplicateKey);
        return new RepeatKeyResolution(RepeatModes.Keyed, values.Select(v => v!).ToList(), null);
    }

    /// <summary>
    /// The indices of <paramref name="sequence"/> that form its longest strictly increasing
    /// subsequence, by the patience method: binary search for the leftmost tail not less than
    /// the value, then walk predecessors back from the last tail. Every runtime runs this exact
    /// procedure, so a sequence with more than one longest subsequence resolves the same way
    /// everywhere.
    /// </summary>
    public static List<int> LongestIncreasingSubsequence(IReadOnlyList<int> sequence)
    {
        var tails = new List<int>();
        var predecessors = new int[sequence.Count];
        for (var i = 0; i < sequence.Count; i++)
        {
            var value = sequence[i];
            int lo = 0, hi = tails.Count;
            while (lo < hi)
            {
                var mid = (lo + hi) / 2;
                if (sequence[tails[mid]] < value) lo = mid + 1;
                else hi = mid;
            }
            predecessors[i] = lo > 0 ? tails[lo - 1] : -1;
            if (lo == tails.Count) tails.Add(i);
            else tails[lo] = i;
        }
        var result = new int[tails.Count];
        var cursor = tails.Count > 0 ? tails[^1] : -1;
        for (var k = tails.Count - 1; k >= 0; k--)
        {
            result[k] = cursor;
            cursor = predecessors[cursor];
        }
        return [.. result];
    }

    /// <summary>
    /// Computes how a host turns the previous render of a repeat into the next one.
    ///
    /// With no previous render every copy is an insert. When either render is <c>replace</c>,
    /// or the mode changed, the previous copies are all removed and the next ones all inserted.
    /// Otherwise copies match by key: removes first, in previous order; then every next copy in
    /// order is an <c>insert</c>, a <c>reuse</c> (kept, already in relative order), or a
    /// <c>move</c> (kept, but relocated). The copies marked <c>reuse</c> are the longest run
    /// already in order, so a single removal or insertion moves nothing.
    /// </summary>
    public static List<RepeatPatchOp> Diff(
        (string Mode, IReadOnlyList<object> Keys)? previous,
        (string Mode, IReadOnlyList<object> Keys) next)
    {
        var ops = new List<RepeatPatchOp>();
        if (previous is not { } prior)
        {
            for (var to = 0; to < next.Keys.Count; to++) ops.Add(new RepeatPatchOp("insert", next.Keys[to], null, to));
            return ops;
        }

        if (next.Mode == RepeatModes.Replace || prior.Mode != next.Mode)
        {
            for (var from = 0; from < prior.Keys.Count; from++) ops.Add(new RepeatPatchOp("remove", prior.Keys[from], from, null));
            for (var to = 0; to < next.Keys.Count; to++) ops.Add(new RepeatPatchOp("insert", next.Keys[to], null, to));
            return ops;
        }

        var previousIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var from = 0; from < prior.Keys.Count; from++) previousIndex[KeyToken(prior.Keys[from])] = from;
        var nextTokens = new HashSet<string>(next.Keys.Select(KeyToken), StringComparer.Ordinal);

        for (var from = 0; from < prior.Keys.Count; from++)
        {
            if (!nextTokens.Contains(KeyToken(prior.Keys[from])))
                ops.Add(new RepeatPatchOp("remove", prior.Keys[from], from, null));
        }

        var keptPositions = new List<int>();
        var keptFrom = new List<int>();
        for (var to = 0; to < next.Keys.Count; to++)
        {
            if (previousIndex.TryGetValue(KeyToken(next.Keys[to]), out var from))
            {
                keptPositions.Add(to);
                keptFrom.Add(from);
            }
        }
        var stable = LongestIncreasingSubsequence(keptFrom).Select(i => keptPositions[i]).ToHashSet();

        for (var to = 0; to < next.Keys.Count; to++)
        {
            var key = next.Keys[to];
            ops.Add(previousIndex.TryGetValue(KeyToken(key), out var from)
                ? new RepeatPatchOp(stable.Contains(to) ? "reuse" : "move", key, from, to)
                : new RepeatPatchOp("insert", key, null, to));
        }
        return ops;
    }
}
