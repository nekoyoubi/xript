using System.Text.Json;

namespace Xript.Runtime;

/// <summary>A script value with no JSON spelling.</summary>
public enum XriptSpecial
{
    Undefined,
    NaN,
    Infinity,
    NegativeInfinity,
    NegativeZero,
}

/// <summary>
/// The marker objects that carry script values JSON has no spelling for across the host
/// boundary when <see cref="RuntimeOptions.ValueFidelity"/> is on. A marker is an object whose
/// <c>$xript</c> key names a known tag and whose other keys are exactly that tag's payload:
/// <list type="bullet">
/// <item><c>{ "$xript": "undefined" }</c>, <c>"NaN"</c>, <c>"Infinity"</c>, <c>"-Infinity"</c>, <c>"-0"</c>: no payload</item>
/// <item><c>{ "$xript": "bigint", "value": "-12" }</c>: a BigInt, as a decimal string</item>
/// <item><c>{ "$xript": "symbol", "description": "d" }</c>: a symbol, <c>description</c> omitted when it has none (only as a whole value: an argument, a result, a callback's return; a nested symbol follows JSON's rules)</item>
/// <item><c>{ "$xript": "string", "units": [97, 55296] }</c>: a string that is not well-formed UTF-16, as its code units</item>
/// <item><c>{ "$xript": "cycle", "up": 1 }</c>: a back-reference to an enclosing array or object, <c>1</c> being the one that holds the marker</item>
/// </list>
/// Any other object, including an unknown tag, an extra key, or a missing payload key, is plain data.
/// </summary>
public static class XriptValue
{
    /// <summary>The key of the marker object.</summary>
    public const string Marker = "$xript";

    /// <summary>
    /// How deeply nested a value may be to cross the boundary, in either direction, with or
    /// without value fidelity. Deeper fails with a <see cref="ValueCrossingException"/>.
    /// A host that reads or writes values this deep with <c>System.Text.Json</c> must raise
    /// its <c>MaxDepth</c> past the default of 64.
    /// </summary>
    public const int MaxDepth = 10000;

    /// <summary>A BigInt marker.</summary>
    public static JsonElement BigInt(System.Numerics.BigInteger value) =>
        JsonSerializer.SerializeToElement(new Dictionary<string, string>
        {
            [Marker] = "bigint",
            ["value"] = value.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    /// <summary>Reads a BigInt marker.</summary>
    public static bool TryGetBigInt(JsonElement value, out System.Numerics.BigInteger bigint)
    {
        bigint = default;
        return Payload(value, "bigint", "value") is { ValueKind: JsonValueKind.String } digits
            && System.Text.RegularExpressions.Regex.IsMatch(digits.GetString()!, "^-?[0-9]+$")
            && System.Numerics.BigInteger.TryParse(digits.GetString(), System.Globalization.NumberStyles.AllowLeadingSign,
                System.Globalization.CultureInfo.InvariantCulture, out bigint);
    }

    /// <summary>A symbol marker; the sandbox receives a fresh <c>Symbol(description)</c>.</summary>
    public static JsonElement Symbol(string? description = null)
    {
        var marker = new Dictionary<string, string> { [Marker] = "symbol" };
        if (description is not null) marker["description"] = description;
        return JsonSerializer.SerializeToElement(marker);
    }

    /// <summary>Reads a symbol marker; <paramref name="description"/> is null when the symbol has none.</summary>
    public static bool TryGetSymbol(JsonElement value, out string? description)
    {
        description = null;
        if (IsTag(value, "symbol", 1)) return true;
        if (Payload(value, "symbol", "description") is not { ValueKind: JsonValueKind.String } text) return false;
        description = text.GetString();
        return true;
    }

    /// <summary>A script string: a JSON string when it is well-formed UTF-16, otherwise a <c>string</c> marker of its code units.</summary>
    public static JsonElement String(string text)
    {
        if (JsonText.IsWellFormed(text)) return JsonSerializer.SerializeToElement(text);
        var units = new System.Text.StringBuilder("{\"").Append(Marker).Append("\":\"string\",\"units\":[");
        units.AppendJoin(',', text.Select(c => (int)c));
        return JsonDocument.Parse(units.Append("]}").ToString()).RootElement.Clone();
    }

    /// <summary>Reads a script string: a JSON string (lone surrogates included) or a <c>string</c> marker.</summary>
    public static bool TryGetString(JsonElement value, out string text)
    {
        text = "";
        if (value.ValueKind == JsonValueKind.String)
        {
            text = JsonText.ReadString(value);
            return true;
        }
        if (Payload(value, "string", "units") is not { ValueKind: JsonValueKind.Array } units) return false;
        var chars = new char[units.GetArrayLength()];
        var i = 0;
        foreach (var unit in units.EnumerateArray())
        {
            if (!unit.TryGetInt32(out var code) || code < 0 || code > 0xFFFF) return false;
            chars[i++] = (char)code;
        }
        text = new string(chars);
        return true;
    }

    /// <summary>A cycle marker naming the enclosing array or object <paramref name="up"/> levels out.</summary>
    public static JsonElement Cycle(int up) =>
        JsonDocument.Parse($"{{\"{Marker}\":\"cycle\",\"up\":{up}}}").RootElement.Clone();

    /// <summary>Reads a cycle marker.</summary>
    public static bool TryGetCycle(JsonElement value, out int up)
    {
        up = 0;
        return Payload(value, "cycle", "up") is { ValueKind: JsonValueKind.Number } levels
            && levels.TryGetInt32(out up) && up >= 1;
    }

    private static bool IsTag(JsonElement value, string tag, int keys)
    {
        if (value.ValueKind != JsonValueKind.Object) return false;
        var count = 0;
        var tagged = false;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (property.Name == Marker && property.Value.ValueKind == JsonValueKind.String && property.Value.GetString() == tag)
                tagged = true;
        }
        return tagged && count == keys;
    }

    private static JsonElement? Payload(JsonElement value, string tag, string key) =>
        IsTag(value, tag, 2) && value.TryGetProperty(key, out var payload) ? payload : null;

    /// <summary>The <c>undefined</c> marker.</summary>
    public static JsonElement Undefined => Of(XriptSpecial.Undefined);

    /// <summary>The <c>NaN</c> marker.</summary>
    public static JsonElement NaN => Of(XriptSpecial.NaN);

    /// <summary>The <c>Infinity</c> marker.</summary>
    public static JsonElement Infinity => Of(XriptSpecial.Infinity);

    /// <summary>The <c>-Infinity</c> marker.</summary>
    public static JsonElement NegativeInfinity => Of(XriptSpecial.NegativeInfinity);

    /// <summary>The <c>-0</c> marker.</summary>
    public static JsonElement NegativeZero => Of(XriptSpecial.NegativeZero);

    /// <summary>The marker tag a special value travels under.</summary>
    public static string Tag(XriptSpecial special) => special switch
    {
        XriptSpecial.Undefined => "undefined",
        XriptSpecial.NaN => "NaN",
        XriptSpecial.Infinity => "Infinity",
        XriptSpecial.NegativeZero => "-0",
        _ => "-Infinity",
    };

    /// <summary>The marker object for a special value.</summary>
    public static JsonElement Of(XriptSpecial special) =>
        JsonDocument.Parse($"{{\"{Marker}\":\"{Tag(special)}\"}}").RootElement.Clone();

    /// <summary>
    /// Any double as a script number: a marker when it is not finite or is <c>-0</c>, an
    /// integer when its value is integral, otherwise a float.
    /// </summary>
    public static JsonElement Number(double number)
    {
        if (double.IsNaN(number)) return NaN;
        if (double.IsPositiveInfinity(number)) return Infinity;
        if (double.IsNegativeInfinity(number)) return NegativeInfinity;
        if (double.IsNegative(number) && number == 0) return NegativeZero;
        if (number == Math.Floor(number) && Math.Abs(number) < long.MaxValue)
            return JsonDocument.Parse(((long)number).ToString()).RootElement.Clone();
        return JsonDocument.Parse(number.ToString("R", System.Globalization.CultureInfo.InvariantCulture)).RootElement.Clone();
    }

    /// <summary>Reads a marker object. False for anything else.</summary>
    public static bool TryGetSpecial(JsonElement value, out XriptSpecial special)
    {
        special = default;
        if (value.ValueKind != JsonValueKind.Object) return false;
        string? tag = null;
        var count = 0;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (property.Name == Marker && property.Value.ValueKind == JsonValueKind.String)
                tag = property.Value.GetString();
        }
        if (count != 1 || tag is null) return false;
        switch (tag)
        {
            case "undefined": special = XriptSpecial.Undefined; return true;
            case "NaN": special = XriptSpecial.NaN; return true;
            case "Infinity": special = XriptSpecial.Infinity; return true;
            case "-Infinity": special = XriptSpecial.NegativeInfinity; return true;
            case "-0": special = XriptSpecial.NegativeZero; return true;
            default: return false;
        }
    }

    /// <summary>Whether a value is the <c>undefined</c> marker.</summary>
    public static bool IsUndefined(JsonElement value) =>
        TryGetSpecial(value, out var special) && special == XriptSpecial.Undefined;

    /// <summary>
    /// Reads a value as a script number: a JSON number, or a <c>NaN</c>, <c>Infinity</c>,
    /// <c>-Infinity</c>, or <c>-0</c> marker.
    /// </summary>
    public static bool TryGetNumber(JsonElement value, out double number)
    {
        number = 0;
        if (value.ValueKind == JsonValueKind.Number)
        {
            number = value.GetDouble();
            return true;
        }
        if (!TryGetSpecial(value, out var special)) return false;
        switch (special)
        {
            case XriptSpecial.NaN: number = double.NaN; return true;
            case XriptSpecial.Infinity: number = double.PositiveInfinity; return true;
            case XriptSpecial.NegativeInfinity: number = double.NegativeInfinity; return true;
            case XriptSpecial.NegativeZero: number = -0.0; return true;
            default: return false;
        }
    }
}
