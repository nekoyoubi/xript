using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xript.Runtime.Fragments;

/// <summary>
/// A value a fragment node prop may carry. Arrays and objects are first-class:
/// component vocabularies routinely take structured props, and an HTML attribute
/// is only one of the places a prop value can land.
/// </summary>
public abstract record PropValue
{
    public sealed record Str(string Value) : PropValue;

    public sealed record Num(double Value) : PropValue;

    public sealed record Bool(bool Value) : PropValue;

    public sealed record Nul : PropValue;

    public sealed record Arr(IReadOnlyList<PropValue> Items) : PropValue;

    public sealed record Obj(PropMap Entries) : PropValue;

    public static readonly PropValue Null = new Nul();
    public static readonly PropValue True = new Bool(true);
    public static readonly PropValue False = new Bool(false);

    public static PropValue Of(string value) => new Str(value);

    public static PropValue Of(double value) => new Num(value);

    public static PropValue Of(bool value) => value ? True : False;

    /// <summary>
    /// Reproduces JavaScript's <c>String(value)</c> for a prop value, which is what the
    /// HTML projection and the binder both apply before a value reaches markup.
    /// </summary>
    public static string Stringify(PropValue value) => value switch
    {
        Str s => s.Value,
        Num n => NumberToString(n.Value),
        Bool b => b.Value ? "true" : "false",
        Nul => "null",
        Arr a => string.Join(",", a.Items.Select(item => item is Nul ? "" : Stringify(item))),
        Obj => "[object Object]",
        _ => "",
    };

    /// <summary>
    /// Formats a double the way <c>Number.prototype.toString</c> does: the shortest
    /// round-trip digits, written plainly when the decimal exponent sits in JavaScript's
    /// plain range (<c>1e-7 &lt; |v| &lt; 1e21</c>) and in lower-case exponent form outside it.
    /// .NET's own round-trip format switches to exponent form at different thresholds, so
    /// only its digits are used.
    /// </summary>
    public static string NumberToString(double value)
    {
        if (double.IsNaN(value)) return "NaN";
        if (double.IsPositiveInfinity(value)) return "Infinity";
        if (double.IsNegativeInfinity(value)) return "-Infinity";
        if (value == 0) return "0";

        var sign = value < 0 ? "-" : "";
        var shortest = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var (digits, point) = DecimalDigits(shortest);
        var k = digits.Length;

        string body;
        if (k <= point && point <= 21)
            body = digits + new string('0', point - k);
        else if (0 < point && point <= 21)
            body = digits[..point] + "." + digits[point..];
        else if (-6 < point && point <= 0)
            body = "0." + new string('0', -point) + digits;
        else
        {
            var power = point - 1;
            var powerText = (power < 0 ? "-" : "+") + Math.Abs(power).ToString(CultureInfo.InvariantCulture);
            body = k == 1 ? digits + "e" + powerText : digits[..1] + "." + digits[1..] + "e" + powerText;
        }
        return sign + body;
    }

    /// <summary>
    /// Splits a round-trip number string into its significant digits and the position of
    /// the decimal point relative to them, so the value is <c>0.digits x 10^point</c>.
    /// </summary>
    private static (string Digits, int Point) DecimalDigits(string roundTrip)
    {
        var exponentIndex = roundTrip.IndexOfAny(['E', 'e']);
        var mantissa = exponentIndex < 0 ? roundTrip : roundTrip[..exponentIndex];
        var exponent = exponentIndex < 0
            ? 0
            : int.Parse(roundTrip[(exponentIndex + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);

        var dot = mantissa.IndexOf('.');
        var integerPart = dot < 0 ? mantissa : mantissa[..dot];
        var fractionPart = dot < 0 ? "" : mantissa[(dot + 1)..];
        var allDigits = integerPart + fractionPart;
        var point = integerPart.Length + exponent;

        var leading = 0;
        while (leading < allDigits.Length - 1 && allDigits[leading] == '0') leading++;
        allDigits = allDigits[leading..];
        point -= leading;
        allDigits = allDigits.TrimEnd('0');
        if (allDigits.Length == 0) allDigits = "0";
        return (allDigits, point);
    }

    /// <summary>
    /// The text a prop value contributes as an HTML attribute value. Scalars keep
    /// <see cref="Stringify"/> semantics. A plain object is JSON-encoded, since
    /// <c>String()</c> would yield <c>[object Object]</c>. An array is JSON-encoded when the
    /// prop is declared <c>type: "array"</c> or when it holds an object at any depth; an
    /// undeclared array of scalars keeps its comma-joined form.
    /// </summary>
    /// <param name="value">the prop value</param>
    /// <param name="declaredType">the JSON Schema <c>type</c> the vocabulary declares for the prop, if any</param>
    public static string AttributeValue(PropValue value, IReadOnlyList<string>? declaredType = null) => value switch
    {
        Obj => CanonicalJson(value),
        Arr array when (declaredType?.Contains("array") ?? false) || ContainsObject(array.Items) => CanonicalJson(value),
        _ => Stringify(value),
    };

    private static bool ContainsObject(IReadOnlyList<PropValue> items) =>
        items.Any(item => item is Obj || (item is Arr nested && ContainsObject(nested.Items)));

    /// <summary>
    /// The canonical JSON encoding a structured prop projects to: compact,
    /// <c>JSON.stringify</c> escaping and number formatting, and object keys ordered by
    /// Unicode code point, so the attribute is byte-identical on every runtime.
    /// </summary>
    public static string CanonicalJson(PropValue value)
    {
        var builder = new System.Text.StringBuilder();
        WriteCanonicalJson(value, builder);
        return builder.ToString();
    }

    private static void WriteCanonicalJson(PropValue value, System.Text.StringBuilder builder)
    {
        switch (value)
        {
            case Str s:
                WriteJsonString(s.Value, builder);
                break;
            case Num n:
                builder.Append(double.IsFinite(n.Value) ? NumberToString(n.Value) : "null");
                break;
            case Bool b:
                builder.Append(b.Value ? "true" : "false");
                break;
            case Arr a:
                builder.Append('[');
                for (var i = 0; i < a.Items.Count; i++)
                {
                    if (i > 0) builder.Append(',');
                    WriteCanonicalJson(a.Items[i], builder);
                }
                builder.Append(']');
                break;
            case Obj o:
            {
                var keys = o.Entries.Keys.ToList();
                keys.Sort(CompareCodePoints);
                builder.Append('{');
                for (var i = 0; i < keys.Count; i++)
                {
                    if (i > 0) builder.Append(',');
                    WriteJsonString(keys[i], builder);
                    builder.Append(':');
                    WriteCanonicalJson(o.Entries.Get(keys[i])!, builder);
                }
                builder.Append('}');
                break;
            }
            default:
                builder.Append("null");
                break;
        }
    }

    private static void WriteJsonString(string value, System.Text.StringBuilder builder)
    {
        builder.Append('"');
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < 0x20)
                        builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                    {
                        builder.Append(c).Append(value[i + 1]);
                        i++;
                    }
                    else if (char.IsSurrogate(c))
                        builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else
                        builder.Append(c);
                    break;
            }
        }
        builder.Append('"');
    }

    /// <summary>
    /// Orders two strings by Unicode code point. Ordinal comparison orders UTF-16 code
    /// units, which sorts a character above U+FFFF below one in U+E000..U+FFFF; remapping
    /// each unit before comparing restores code point order.
    /// </summary>
    public static int CompareCodePoints(string a, string b)
    {
        var length = Math.Min(a.Length, b.Length);
        for (var i = 0; i < length; i++)
        {
            var left = CodePointRank(a[i]);
            var right = CodePointRank(b[i]);
            if (left != right) return left < right ? -1 : 1;
        }
        return a.Length.CompareTo(b.Length);
    }

    private static int CodePointRank(char unit) =>
        unit >= 0xE000 ? unit - 0x800 : unit >= 0xD800 ? unit + 0x2000 : unit;

    /// <summary>
    /// Deep-copies a JSON value into the <see cref="PropValue"/> domain, dropping
    /// anything JSON cannot express. Returns <c>null</c> when there is no representation.
    /// </summary>
    public static PropValue? FromJson(JsonNode? node)
    {
        switch (node)
        {
            case null:
                return Null;
            case JsonArray array:
            {
                var items = new List<PropValue>();
                foreach (var item in array)
                {
                    var converted = FromJson(item);
                    if (converted is not null) items.Add(converted);
                }
                return new Arr(items);
            }
            case JsonObject obj:
            {
                var map = new PropMap();
                foreach (var (key, val) in obj)
                {
                    if (FragmentTree.ForbiddenPropNames.Contains(key)) continue;
                    var converted = FromJson(val);
                    if (converted is not null) map.Set(key, converted);
                }
                return new Obj(map);
            }
            case JsonValue value:
            {
                if (value.TryGetValue<bool>(out var b)) return Of(b);
                if (value.TryGetValue<string>(out var s)) return Of(s);
                if (value.TryGetValue<double>(out var d)) return Of(d);
                var element = value.GetValue<JsonElement>();
                return element.ValueKind switch
                {
                    JsonValueKind.True => True,
                    JsonValueKind.False => False,
                    JsonValueKind.String => Of(element.GetString() ?? ""),
                    JsonValueKind.Number => Of(element.GetDouble()),
                    JsonValueKind.Null => Null,
                    _ => null,
                };
            }
            default:
                return null;
        }
    }

    public JsonNode? ToJson() => this switch
    {
        Str s => JsonValue.Create(s.Value),
        Num n => JsonValue.Create(n.Value),
        Bool b => JsonValue.Create(b.Value),
        Nul => null,
        Arr a => new JsonArray([.. a.Items.Select(item => item.ToJson())]),
        Obj o => ObjectToJson(o.Entries),
        _ => null,
    };

    private static JsonNode ObjectToJson(PropMap map)
    {
        var result = new JsonObject();
        foreach (var (key, value) in map)
            result[key] = value.ToJson();
        return result;
    }
}

/// <summary>
/// An insertion-ordered string-to-<see cref="PropValue"/> map. Prop order is
/// byte-observable in the HTML projection, so ordering is part of the contract
/// rather than an implementation detail.
/// </summary>
public sealed class PropMap : IEnumerable<KeyValuePair<string, PropValue>>
{
    private readonly List<string> _order = [];
    private readonly Dictionary<string, PropValue> _values = new(StringComparer.Ordinal);

    public int Count => _order.Count;

    public IReadOnlyList<string> Keys => _order;

    public bool ContainsKey(string key) => _values.ContainsKey(key);

    public bool TryGetValue(string key, out PropValue value) => _values.TryGetValue(key, out value!);

    public PropValue? Get(string key) => _values.TryGetValue(key, out var value) ? value : null;

    public void Set(string key, PropValue value)
    {
        if (!_values.ContainsKey(key)) _order.Add(key);
        _values[key] = value;
    }

    public void Remove(string key)
    {
        if (_values.Remove(key)) _order.Remove(key);
    }

    public PropMap Clone()
    {
        var copy = new PropMap();
        foreach (var key in _order) copy.Set(key, _values[key]);
        return copy;
    }

    public IEnumerator<KeyValuePair<string, PropValue>> GetEnumerator()
    {
        foreach (var key in _order)
            yield return new KeyValuePair<string, PropValue>(key, _values[key]);
    }

    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}
