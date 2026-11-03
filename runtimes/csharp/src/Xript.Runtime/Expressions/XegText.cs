using System.Globalization;
using System.Numerics;
using System.Text;

namespace Xript.Runtime.Expressions;

/// <summary>
/// The string and number primitives XEG pins across runtimes: case mapping and whitespace as
/// JavaScript defines them, and numbers rendered the way <c>String(number)</c> and
/// <c>toFixed</c> do, computed from the exact binary value rather than from .NET's formatter.
/// Strings are UTF-16 code units, as in JavaScript, so lengths and indices are .NET's own.
/// </summary>
public static class XegText
{
    private static readonly Dictionary<int, int[]> UpperMap = LoadMap(CaseTables.Upper);
    private static readonly Dictionary<int, int[]> LowerMap = LoadMap(CaseTables.Lower);

    private static int NextCodePoint(string text, ref int index)
    {
        int value;
        if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
        {
            value = char.ConvertToUtf32(text[index], text[index + 1]);
            index += 2;
        }
        else
        {
            value = text[index];
            index += 1;
        }
        return value;
    }

    /// <summary>JavaScript's whitespace set for <c>trim</c>: WhiteSpace plus LineTerminator. Includes U+FEFF, excludes U+0085.</summary>
    public static bool IsWhitespace(char c) => (int)c switch
    {
        0x0009 or 0x000B or 0x000C or 0x0020 or 0x00A0 or 0xFEFF => true,
        0x000A or 0x000D or 0x2028 or 0x2029 => true,
        0x1680 or 0x202F or 0x205F or 0x3000 => true,
        >= 0x2000 and <= 0x200A => true,
        _ => false,
    };

    public static string Trim(string text)
    {
        var start = 0;
        var end = text.Length;
        while (start < end && IsWhitespace(text[start])) start++;
        while (end > start && IsWhitespace(text[end - 1])) end--;
        return text[start..end];
    }

    /// <summary>A decimal literal as <c>num()</c> accepts it: optional sign, digits with an optional point, optional exponent.</summary>
    /// <summary>
    /// JavaScript's <c>Number(string)</c> exactly: a blank string is <c>0</c>, <c>Infinity</c> is
    /// infinite, an unsigned <c>0x</c>, <c>0o</c>, or <c>0b</c> integer reads in its radix, and
    /// anything that is not a numeric literal is <c>NaN</c>.
    /// </summary>
    public static double JsNumber(string text)
    {
        var trimmed = Trim(text);
        if (trimmed.Length == 0) return 0;
        if (trimmed.Length > 2 && trimmed[0] == '0')
        {
            var radix = trimmed[1] switch { 'x' or 'X' => 16, 'o' or 'O' => 8, 'b' or 'B' => 2, _ => 0 };
            if (radix != 0) return RadixInteger(trimmed[2..], radix) ?? double.NaN;
        }
        switch (trimmed)
        {
            case "Infinity" or "+Infinity": return double.PositiveInfinity;
            case "-Infinity": return double.NegativeInfinity;
        }
        if (!IsDecimalLiteral(trimmed)) return double.NaN;
        return double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : double.NaN;
    }

    /// <summary>
    /// An integer in a power-of-two radix, rounded to the nearest double with ties to even, as
    /// JavaScript rounds <c>Number('0x…')</c> however many digits it has. <c>null</c> when a
    /// character is not a digit of the radix.
    /// </summary>
    public static double? RadixInteger(string digits, int radix)
    {
        var width = BitOperations.TrailingZeroCount(radix);
        var bits = new List<bool>(digits.Length * width);
        foreach (var c in digits)
        {
            var digit = c switch
            {
                >= '0' and <= '9' => c - '0',
                >= 'a' and <= 'z' => c - 'a' + 10,
                >= 'A' and <= 'Z' => c - 'A' + 10,
                _ => radix,
            };
            if (digit >= radix) return null;
            for (var k = width - 1; k >= 0; k--) bits.Add(((digit >> k) & 1) == 1);
        }
        var first = bits.IndexOf(true);
        if (first < 0) return 0;
        var significant = bits.Count - first;
        ulong Fold(int from, int count)
        {
            ulong acc = 0;
            for (var i = from; i < from + count; i++) acc = (acc << 1) | (bits[i] ? 1UL : 0UL);
            return acc;
        }
        if (significant <= 53) return Fold(first, significant);
        var mantissa = Fold(first, 53);
        var round = bits[first + 53];
        var sticky = false;
        for (var i = first + 54; i < bits.Count; i++) sticky |= bits[i];
        if (round && (sticky || (mantissa & 1) == 1)) mantissa++;
        var exponent = significant - 53;
        if (mantissa == 1UL << 53)
        {
            mantissa >>= 1;
            exponent++;
        }
        return exponent > 1024 ? double.PositiveInfinity : Math.ScaleB(mantissa, exponent);
    }

    public static bool IsDecimalLiteral(string text)
    {
        var i = 0;
        if (i < text.Length && text[i] is '+' or '-') i++;
        var intStart = i;
        while (i < text.Length && char.IsAsciiDigit(text[i])) i++;
        var intDigits = i - intStart;
        var fracDigits = 0;
        if (i < text.Length && text[i] == '.')
        {
            i++;
            var fracStart = i;
            while (i < text.Length && char.IsAsciiDigit(text[i])) i++;
            fracDigits = i - fracStart;
        }
        if (intDigits == 0 && fracDigits == 0) return false;
        if (i < text.Length && text[i] is 'e' or 'E')
        {
            i++;
            if (i < text.Length && text[i] is '+' or '-') i++;
            var expStart = i;
            while (i < text.Length && char.IsAsciiDigit(text[i])) i++;
            if (i == expStart) return false;
        }
        return i == text.Length;
    }

    /// <summary>Unicode default full uppercase mapping, independent of culture.</summary>
    public static string ToUpper(string text)
    {
        var builder = new StringBuilder(text.Length);
        var points = ToCodePointValues(text);
        foreach (var cp in points) Append(builder, UpperMap.TryGetValue(cp, out var mapped) ? mapped : null, cp);
        return builder.ToString();
    }

    /// <summary>Unicode default full lowercase mapping, independent of culture, with the Final_Sigma rule.</summary>
    public static string ToLower(string text)
    {
        var builder = new StringBuilder(text.Length);
        var points = ToCodePointValues(text);
        for (var i = 0; i < points.Count; i++)
        {
            var cp = points[i];
            if (cp == 0x03A3 && IsFinalSigma(points, i))
            {
                builder.Append((char)0x03C2);
                continue;
            }
            Append(builder, LowerMap.TryGetValue(cp, out var mapped) ? mapped : null, cp);
        }
        return builder.ToString();
    }

    private static bool IsFinalSigma(List<int> points, int index)
    {
        var before = index - 1;
        while (before >= 0 && InRanges(CaseTables.CaseIgnorable, points[before])) before--;
        if (before < 0 || !InRanges(CaseTables.Cased, points[before])) return false;
        var after = index + 1;
        while (after < points.Count && InRanges(CaseTables.CaseIgnorable, points[after])) after++;
        return after >= points.Count || !InRanges(CaseTables.Cased, points[after]);
    }

    private static void Append(StringBuilder builder, int[]? mapped, int cp)
    {
        if (mapped is null)
        {
            AppendCodePoint(builder, cp);
            return;
        }
        foreach (var target in mapped) AppendCodePoint(builder, target);
    }

    private static void AppendCodePoint(StringBuilder builder, int cp)
    {
        if (cp is >= 0xD800 and <= 0xDFFF) builder.Append((char)cp);
        else builder.Append(char.ConvertFromUtf32(cp));
    }

    private static List<int> ToCodePointValues(string text)
    {
        var result = new List<int>(text.Length);
        var i = 0;
        while (i < text.Length) result.Add(NextCodePoint(text, ref i));
        return result;
    }

    private static bool InRanges(int[] ranges, int cp)
    {
        int lo = 0, hi = ranges.Length / 2 - 1;
        while (lo <= hi)
        {
            var mid = (lo + hi) / 2;
            if (cp < ranges[mid * 2]) hi = mid - 1;
            else if (cp > ranges[mid * 2 + 1]) lo = mid + 1;
            else return true;
        }
        return false;
    }

    private static Dictionary<int, int[]> LoadMap(int[] runs)
    {
        var map = new Dictionary<int, int[]>();
        var i = 0;
        while (i < runs.Length)
        {
            var cp = runs[i];
            var count = runs[i + 1];
            map[cp] = runs[(i + 2)..(i + 2 + count)];
            i += 2 + count;
        }
        return map;
    }

    /// <summary>JavaScript's <c>Math.round</c>: the nearest integer, a half rounding toward positive infinity.</summary>
    public static double RoundHalfUp(double value)
    {
        var floor = Math.Floor(value);
        return value - floor >= 0.5 ? floor + 1 : floor;
    }

    /// <summary>
    /// JavaScript's <c>String(number)</c>: the shortest digits that round-trip, nearest the exact
    /// value when two qualify, in plain notation from 1e-6 up to 1e21 and exponent form outside it.
    /// </summary>
    public static string FormatNumber(double value)
    {
        if (!double.IsFinite(value)) return "";
        if (value == 0) return "0";
        var magnitude = Math.Abs(value);
        var significant = CountSignificant(magnitude.ToString("R", CultureInfo.InvariantCulture));
        var (digits, point) = ExactDecimal(magnitude);
        (digits, point) = RoundSignificant(digits, point, significant);
        digits = digits.TrimEnd('0');
        if (digits.Length == 0) digits = "0";
        return (value < 0 ? "-" : "") + Layout(digits, point);
    }

    /// <summary>
    /// JavaScript's <c>Number.prototype.toFixed</c>: the exact binary value rounded to
    /// <paramref name="fractionDigits"/> places, a half rounding away from zero, and
    /// <c>String(value)</c> from 1e21 up.
    /// </summary>
    public static string FormatFixed(double value, int fractionDigits)
    {
        if (Math.Abs(value) >= 1e21) return FormatNumber(value);
        var negative = value < 0;
        var (digits, point) = ExactDecimal(Math.Abs(value));
        var keep = point + fractionDigits;
        BigInteger kept;
        if (keep <= 0)
        {
            kept = keep == 0 && digits.Length > 0 && digits[0] >= '5' ? BigInteger.One : BigInteger.Zero;
        }
        else
        {
            var head = keep >= digits.Length ? digits.PadRight(keep, '0') : digits[..keep];
            kept = BigInteger.Parse(head, CultureInfo.InvariantCulture);
            if (keep < digits.Length && digits[keep] >= '5') kept += 1;
        }
        var text = kept.ToString(CultureInfo.InvariantCulture).PadLeft(fractionDigits + 1, '0');
        var whole = text[..^fractionDigits];
        var fraction = text[^fractionDigits..];
        var sign = negative ? "-" : "";
        return fractionDigits == 0 ? sign + text : $"{sign}{whole}.{fraction}";
    }

    /// <summary>
    /// The exact decimal expansion of a positive finite double as digits with no leading zero,
    /// and the decimal point position: the value is <c>0.d1d2… × 10^point</c>.
    /// </summary>
    private static (string Digits, int Point) ExactDecimal(double value)
    {
        if (value == 0) return ("0", 1);
        var bits = BitConverter.DoubleToInt64Bits(value);
        var exponent = (int)((bits >> 52) & 0x7FF);
        var mantissa = bits & 0xFFFFFFFFFFFFFL;
        if (exponent == 0) exponent = 1;
        else mantissa |= 1L << 52;
        var power = exponent - 1075;

        string digits;
        int point;
        if (power >= 0)
        {
            digits = (new BigInteger(mantissa) << power).ToString(CultureInfo.InvariantCulture);
            point = digits.Length;
        }
        else
        {
            digits = (new BigInteger(mantissa) * BigInteger.Pow(5, -power)).ToString(CultureInfo.InvariantCulture);
            point = digits.Length + power;
        }
        var trimmed = digits.TrimEnd('0');
        return (trimmed.Length == 0 ? "0" : trimmed, point);
    }

    /// <summary>Rounds exact digits to <paramref name="count"/> significant digits, a half rounding to even.</summary>
    private static (string Digits, int Point) RoundSignificant(string digits, int point, int count)
    {
        if (digits.Length <= count) return (digits, point);
        var head = BigInteger.Parse(digits[..count], CultureInfo.InvariantCulture);
        var next = digits[count];
        var rest = digits[(count + 1)..].Any(c => c != '0');
        var roundUp = next > '5' || (next == '5' && (rest || !head.IsEven));
        if (roundUp) head += 1;
        var text = head.ToString(CultureInfo.InvariantCulture);
        if (text.Length > count) return (text[..count], point + 1);
        return (text, point);
    }

    private static int CountSignificant(string shortest)
    {
        var mantissa = shortest.Split('E')[0].Replace(".", "").TrimStart('0');
        return Math.Max(1, mantissa.TrimEnd('0').Length);
    }

    private static string Layout(string digits, int point)
    {
        var k = digits.Length;
        if (k <= point && point <= 21) return digits + new string('0', point - k);
        if (0 < point && point <= 21) return $"{digits[..point]}.{digits[point..]}";
        if (-6 < point && point <= 0) return "0." + new string('0', -point) + digits;
        var exponent = point - 1;
        var mantissa = k == 1 ? digits : $"{digits[0]}.{digits[1..]}";
        return $"{mantissa}e{(exponent < 0 ? '-' : '+')}{Math.Abs(exponent)}";
    }
}
