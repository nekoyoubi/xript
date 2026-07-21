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
    /// Formats a double the way <c>Number.prototype.toString</c> does: shortest
    /// round-trip, integral values without a decimal point, lower-case exponent.
    /// </summary>
    public static string NumberToString(double value)
    {
        if (double.IsNaN(value)) return "NaN";
        if (double.IsPositiveInfinity(value)) return "Infinity";
        if (double.IsNegativeInfinity(value)) return "-Infinity";

        var text = value.ToString("R", CultureInfo.InvariantCulture);
        var exponent = text.IndexOf('E');
        if (exponent < 0) return text;

        var mantissa = text[..exponent];
        var power = text[(exponent + 1)..];
        if (power.StartsWith('+')) power = "+" + power[1..].TrimStart('0');
        else if (power.StartsWith('-')) power = "-" + power[1..].TrimStart('0');
        return mantissa + "e" + power;
    }

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
