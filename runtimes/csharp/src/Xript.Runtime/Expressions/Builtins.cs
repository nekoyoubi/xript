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
    public static readonly string[] Names =
    [
        "abs", "round", "floor", "ceil", "min", "max", "clamp", "fixed",
        "upper", "lower", "trim", "pad", "slice",
        "len", "has", "join", "at",
        "str", "num", "bool",
    ];

    public static (int Min, int Max)? Arity(string name) => name switch
    {
        "abs" or "round" or "floor" or "ceil" => (1, 1),
        "min" or "max" => (1, int.MaxValue),
        "clamp" => (3, 3),
        "fixed" => (2, 2),
        "upper" or "lower" or "trim" => (1, 1),
        "pad" => (2, 3),
        "slice" => (2, 3),
        "len" => (1, 1),
        "has" => (2, 2),
        "join" => (1, 2),
        "at" => (2, 2),
        "str" or "num" or "bool" => (1, 1),
        _ => null,
    };

    public static object? Call(string name, IReadOnlyList<object?> args)
    {
        switch (name)
        {
            case "abs": return Number(args[0], Math.Abs);
            // JS `Math.round` rounds half *up*, not half away from zero and not half to
            // even (which is what `Math.Round` would do here). Spelling it out keeps
            // `round(-2.5)` at -2 across every runtime.
            case "round": return Number(args[0], x => Math.Floor(x + 0.5));
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
                return FormatFixed(x.Value, (int)digits.Value);
            }

            case "upper": return args[0] is string upper ? upper.ToUpperInvariant() : null;
            case "lower": return args[0] is string lower ? lower.ToLowerInvariant() : null;
            case "trim": return args[0] is string trim ? trim.Trim() : null;

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
                while (builder.Length < needed) builder.Append(fill);
                builder.Length = needed;
                builder.Append(text);
                return builder.ToString();
            }

            case "slice":
            {
                if (args[0] is not string text) return null;
                var from = ExprValue.AsNumber(args[1]);
                if (from is null) return null;
                if (args.Count > 2)
                {
                    var to = ExprValue.AsNumber(args[2]);
                    if (to is null) return null;
                    return Slice(text, (long)from.Value, (long)to.Value);
                }
                return Slice(text, (long)from.Value, text.Length);
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
                    string or List<object?> => ExprValue.ReadIndex(args[0], (long)index.Value),
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

    private static object? Number(object? value, Func<double, double> op)
    {
        var number = ExprValue.AsNumber(value);
        return number is null ? null : ExprValue.Finite(op(number.Value));
    }

    private static object? ParseNumber(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.Length == 0) return null;
        return double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            && double.IsFinite(value)
                ? value
                : null;
    }

    private static string Slice(string text, long from, long to)
    {
        long Clamp(long i) => Math.Clamp(i < 0 ? text.Length + i : i, 0, text.Length);
        var start = Clamp(from);
        var end = Clamp(to);
        return start >= end ? "" : text[(int)start..(int)end];
    }

    /// <summary><c>Number.prototype.toFixed</c> semantics: round half away from zero, then pad.</summary>
    private static string FormatFixed(double value, int digits)
    {
        var factor = Math.Pow(10, digits);
        var scaled = value * factor;
        var rounded = scaled < 0 ? -Math.Floor(-scaled + 0.5) : Math.Floor(scaled + 0.5);
        return (rounded / factor).ToString("F" + digits.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
    }
}
