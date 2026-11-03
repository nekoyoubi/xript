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
/// The marker objects that carry <c>undefined</c>, <c>NaN</c>, <c>Infinity</c>,
/// <c>-Infinity</c> and <c>-0</c> across the host boundary when
/// <see cref="RuntimeOptions.ValueFidelity"/> is on: <c>{ "$xript": "undefined" }</c>,
/// <c>{ "$xript": "NaN" }</c>, <c>{ "$xript": "Infinity" }</c>, <c>{ "$xript": "-Infinity" }</c>,
/// <c>{ "$xript": "-0" }</c>. A one-key object whose only key is <c>$xript</c> and whose value is
/// one of the five tags always means the special value.
/// </summary>
public static class XriptValue
{
    /// <summary>The key of the marker object.</summary>
    public const string Marker = "$xript";

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
