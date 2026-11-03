using System.Globalization;
using System.Text;

namespace Xript.Runtime.Expressions;

/// <summary>
/// The closed builtin table. Extended only by spec revision: a host cannot register a
/// builtin, because that would be a capability channel wearing a formatter's clothes, and
/// formatting is not where a capability boundary belongs.
/// </summary>
public static class Builtins
{
    public static readonly string[] Names = ExpressionReference.Root.GetProperty("builtins")
        .EnumerateArray()
        .Select(builtin => builtin.GetProperty("name").GetString()!)
        .ToArray();

    public static (int Min, int Max)? Arity(string name) =>
        ExpressionReference.BuiltinArity.TryGetValue(name, out var arity) ? arity : null;

    public static object? Call(string name, IReadOnlyList<object?> args)
    {
        switch (name)
        {
            case "abs": return Number(args[0], Math.Abs);
            case "round": return Number(args[0], XegText.RoundHalfUp);
            case "floor": return Number(args[0], Math.Floor);
            case "ceil": return Number(args[0], Math.Ceiling);

            case "min":
            case "max":
            {
                var values = new List<double>(args.Count);
                foreach (var arg in args)
                {
                    var value = ExprValue.AsNumber(arg);
                    if (value is null) return null;
                    values.Add(value.Value);
                }
                return ExprValue.Finite(name == "min" ? values.Min() : values.Max());
            }

            case "clamp":
            {
                var x = ExprValue.AsNumber(args[0]);
                var lo = ExprValue.AsNumber(args[1]);
                var hi = ExprValue.AsNumber(args[2]);
                if (x is null || lo is null || hi is null || lo > hi) return null;
                return ExprValue.Finite(Math.Min(Math.Max(x.Value, lo.Value), hi.Value));
            }

            case "fixed":
            {
                var x = ExprValue.AsNumber(args[0]);
                var digits = ExprValue.AsNumber(args[1]);
                if (x is null || digits is null) return null;
                if (digits != Math.Floor(digits.Value) || digits < 0 || digits > 20) return null;
                return XegText.FormatFixed(x.Value, (int)digits.Value);
            }

            case "upper": return args[0] is string upper ? XegText.ToUpper(upper) : null;
            case "lower": return args[0] is string lower ? XegText.ToLower(lower) : null;
            case "trim": return args[0] is string trim ? XegText.Trim(trim) : null;

            case "pad":
            {
                if (args[0] is not string text) return null;
                var width = ExprValue.AsNumber(args[1]);
                if (width is null || width != Math.Floor(width.Value) || width < 0 || width > 4096) return null;
                var fill = args.Count > 2 ? args[2] as string : " ";
                if (string.IsNullOrEmpty(fill)) return null;
                if (text.Length >= width) return text;

                var needed = (int)width.Value - text.Length;
                var builder = new StringBuilder(needed + text.Length);
                for (var i = 0; i < needed; i++) builder.Append(fill[i % fill.Length]);
                builder.Append(text);
                return builder.ToString();
            }

            case "slice":
            {
                if (args[0] is not string text) return null;
                var from = ExprValue.AsNumber(args[1]);
                if (from is null) return null;
                var start = RelativeIndex(from.Value, text.Length);
                var end = text.Length;
                if (args.Count > 2)
                {
                    var to = ExprValue.AsNumber(args[2]);
                    if (to is null) return null;
                    end = RelativeIndex(to.Value, text.Length);
                }
                return start < end ? text[start..end] : "";
            }

            case "len": return args[0] switch
            {
                string s => (double)s.Length,
                List<object?> a => (double)a.Count,
                Dictionary<string, object?> o => (double)o.Count,
                _ => null,
            };

            case "has": return args[0] switch
            {
                string s => args[1] is string needle && s.Contains(needle, StringComparison.Ordinal),
                List<object?> a => a.Any(item => ExprValue.StrictEqual(item, args[1])),
                Dictionary<string, object?> o => args[1] is string key && o.ContainsKey(key),
                _ => null,
            };

            case "join":
            {
                if (args[0] is not List<object?> array) return null;
                var separator = args.Count > 1 ? args[1] as string : ",";
                if (separator is null) return null;
                return string.Join(separator, array.Select(ExprValue.Render));
            }

            case "at":
            {
                var index = ExprValue.AsNumber(args[1]);
                if (index is null || index != Math.Floor(index.Value)) return null;
                return args[0] switch
                {
                    string or List<object?> => ExprValue.ReadIndex(args[0], index.Value),
                    _ => null,
                };
            }

            case "str": return ExprValue.Render(args[0]);

            case "num": return args[0] switch
            {
                double d => ExprValue.Finite(d),
                bool b => b ? 1d : 0d,
                string s => ParseNumber(s),
                _ => null,
            };

            case "bool": return ExprValue.IsTruthy(args[0]);

            default: return null;
        }
    }

    /// <summary>
    /// JavaScript's relative index for <c>String.prototype.slice</c>: truncated toward zero,
    /// counted from the end when negative, and clamped to the length. Computed in
    /// floating point, so an index of any magnitude clamps rather than wrapping on a cast.
    /// </summary>
    private static int RelativeIndex(double index, int length)
    {
        var truncated = Math.Truncate(index);
        return (int)(truncated < 0 ? Math.Max(length + truncated, 0) : Math.Min(truncated, length));
    }

    private static object? Number(object? value, Func<double, double> op)
    {
        var number = ExprValue.AsNumber(value);
        return number is null ? null : ExprValue.Finite(op(number.Value));
    }

    /// <summary>
    /// JavaScript's <c>Number(string)</c>, held to XEG's domain: the trimmed text is a decimal
    /// literal or an unsigned <c>0x</c>, <c>0o</c>, or <c>0b</c> integer; an empty or
    /// non-finite result, and anything JavaScript would read as <c>NaN</c>, is <c>null</c>.
    /// </summary>
    private static object? ParseNumber(string text)
    {
        if (XegText.Trim(text).Length == 0) return null;
        var value = XegText.JsNumber(text);
        return double.IsFinite(value) ? value : null;
    }

}
