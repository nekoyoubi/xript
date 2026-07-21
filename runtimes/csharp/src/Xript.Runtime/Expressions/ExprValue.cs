using System.Collections;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xript.Runtime.Fragments;

namespace Xript.Runtime.Expressions;

/// <summary>
/// The XEG value domain: <c>null</c>, <c>bool</c>, <c>double</c>, <c>string</c>,
/// <c>List&lt;object?&gt;</c>, <c>Dictionary&lt;string, object?&gt;</c>. Nothing else gets
/// in, which is what keeps a delegate, a task, or a live CLR object from reaching an
/// expression through a binding.
/// </summary>
public static class ExprValue
{
    /// <summary>
    /// Normalizes an arbitrary host value into the value domain. Anything JSON cannot
    /// express is dropped rather than boxed through, so an expression can never reach a
    /// callable or a type's members.
    /// </summary>
    public static object? Normalize(object? value)
    {
        switch (value)
        {
            case null: return null;
            case bool or string: return value;
            case double d: return double.IsFinite(d) ? d : null;
            case float f: return double.IsFinite(f) ? (double)f : null;
            case int or long or short or byte or sbyte or uint or ulong or ushort:
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            case decimal m: return (double)m;
            case JsonElement element: return FromJsonElement(element);
            case JsonNode node: return FromJsonElement(node.Deserialize<JsonElement>());
            case PropValue prop: return FromPropValue(prop);
            case IDictionary<string, object?> map:
            {
                var result = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var (key, item) in map)
                {
                    if (FragmentTree.ForbiddenPropNames.Contains(key)) continue;
                    result[key] = Normalize(item);
                }
                return result;
            }
            case IDictionary dictionary:
            {
                var result = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (DictionaryEntry entry in dictionary)
                {
                    var key = entry.Key?.ToString();
                    if (key is null || FragmentTree.ForbiddenPropNames.Contains(key)) continue;
                    result[key] = Normalize(entry.Value);
                }
                return result;
            }
            case IEnumerable sequence:
            {
                var items = new List<object?>();
                foreach (var item in sequence) items.Add(Normalize(item));
                return items;
            }
            default: return null;
        }
    }

    private static object? FromJsonElement(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number => element.TryGetDouble(out var number) ? number : null,
        JsonValueKind.Array => element.EnumerateArray().Select(FromJsonElement).ToList(),
        JsonValueKind.Object => element.EnumerateObject()
            .Where(property => !FragmentTree.ForbiddenPropNames.Contains(property.Name))
            .ToDictionary(property => property.Name, property => FromJsonElement(property.Value), StringComparer.Ordinal),
        _ => null,
    };

    private static object? FromPropValue(PropValue value) => value switch
    {
        PropValue.Str s => s.Value,
        PropValue.Num n => n.Value,
        PropValue.Bool b => b.Value,
        PropValue.Arr a => a.Items.Select(item => Normalize(item)).ToList(),
        PropValue.Obj o => o.Entries.ToDictionary(entry => entry.Key, entry => Normalize(entry.Value), StringComparer.Ordinal),
        _ => null,
    };

    public static bool IsTruthy(object? value) => value switch
    {
        null => false,
        bool b => b,
        double d => d != 0 && !double.IsNaN(d),
        string s => s.Length > 0,
        _ => true,
    };

    /// <summary>
    /// <c>str()</c> -- the one stringification every runtime shares. <c>null</c> renders as
    /// empty, which is what makes an absent value disappear from prose rather than spelling
    /// out "null".
    /// </summary>
    public static string Render(object? value) => value switch
    {
        null => "",
        bool b => b ? "true" : "false",
        double d => FormatNumber(d),
        string s => s,
        List<object?> items => string.Join(",", items.Select(Render)),
        Dictionary<string, object?> => "[object Object]",
        _ => "",
    };

    /// <summary>
    /// JavaScript's <c>String(number)</c> for the range fragments actually carry: integers
    /// print without a decimal point, everything else prints its shortest round-tripping form.
    /// </summary>
    public static string FormatNumber(double value)
    {
        if (!double.IsFinite(value)) return "";
        if (value == 0) return "0";
        if (value == Math.Floor(value) && Math.Abs(value) < 1e21)
            return ((long)value).ToString(CultureInfo.InvariantCulture);
        return value.ToString("R", CultureInfo.InvariantCulture);
    }

    public static double? AsNumber(object? value) =>
        value is double d && double.IsFinite(d) ? d : null;

    /// <summary>Wraps a computed double, collapsing every non-finite result to <c>null</c>.</summary>
    public static object? Finite(double value) => double.IsFinite(value) ? value : null;

    public static bool IsPrimitive(object? value) =>
        value is null or bool or double or string;

    /// <summary>
    /// Strict equality. Two arrays or two objects are never equal, even to themselves: XEG
    /// has no identity to compare, and structural equality over an unbounded value would
    /// make an expression's cost depend on the data rather than on the AST.
    /// </summary>
    public static bool StrictEqual(object? left, object? right)
    {
        if (!IsPrimitive(left) || !IsPrimitive(right)) return false;
        if (left is null && right is null) return true;
        if (left is null || right is null) return false;
        if (left is double a && right is double b) return a == b;
        if (left is string sa && right is string sb) return string.Equals(sa, sb, StringComparison.Ordinal);
        if (left is bool ba && right is bool bb) return ba == bb;
        return false;
    }

    /// <summary>
    /// Ordering comparisons. Mixed types yield <c>false</c> rather than a coercion cascade,
    /// so a comparison never quietly succeeds against a value of the wrong shape.
    /// </summary>
    public static bool Compare(BinaryOp op, object? left, object? right)
    {
        if (left is double a && right is double b)
        {
            if (double.IsNaN(a) || double.IsNaN(b)) return false;
            return op switch
            {
                BinaryOp.Lt => a < b,
                BinaryOp.Le => a <= b,
                BinaryOp.Gt => a > b,
                BinaryOp.Ge => a >= b,
                _ => false,
            };
        }

        if (left is string sa && right is string sb)
        {
            var order = string.CompareOrdinal(sa, sb);
            return op switch
            {
                BinaryOp.Lt => order < 0,
                BinaryOp.Le => order <= 0,
                BinaryOp.Gt => order > 0,
                BinaryOp.Ge => order >= 0,
                _ => false,
            };
        }

        return false;
    }

    /// <summary>
    /// Reads a member. Every miss -- a member of <c>null</c>, a key an object does not own,
    /// an index past the end -- yields <c>null</c> rather than throwing, so an expression
    /// over partial data still renders.
    /// </summary>
    public static object? ReadMember(object? target, string name)
    {
        switch (target)
        {
            case Dictionary<string, object?> map:
                return map.TryGetValue(name, out var value) ? value : null;
            case List<object?> items when name == "length":
                return (double)items.Count;
            case List<object?> items:
                return int.TryParse(name, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                    ? ReadIndex(items, index)
                    : null;
            case string text when name == "length":
                return (double)text.Length;
            default:
                return null;
        }
    }

    public static object? ReadIndex(object? target, long index)
    {
        switch (target)
        {
            case List<object?> items:
                return ReadIndex(items, index);
            case string text:
            {
                var resolved = index < 0 ? text.Length + index : index;
                return resolved >= 0 && resolved < text.Length
                    ? text[(int)resolved].ToString()
                    : null;
            }
            case Dictionary<string, object?> map:
                return map.TryGetValue(FormatNumber(index), out var value) ? value : null;
            default:
                return null;
        }
    }

    private static object? ReadIndex(List<object?> items, long index)
    {
        var resolved = index < 0 ? items.Count + index : index;
        return resolved >= 0 && resolved < items.Count ? items[(int)resolved] : null;
    }
}
