using System.Text;
using System.Text.Json;

namespace Xript.Runtime;

/// <summary>JSON text helpers that keep strings which are not well-formed UTF-16 intact.</summary>
internal static class JsonText
{
    internal static readonly JsonDocumentOptions DeepDocument = new() { MaxDepth = XriptValue.MaxDepth + 2 };

    /// <summary>Whether every surrogate in <paramref name="text"/> is half of a pair.</summary>
    internal static bool IsWellFormed(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (!char.IsSurrogate(c)) continue;
            if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                i++;
                continue;
            }
            return false;
        }
        return true;
    }

    /// <summary><paramref name="text"/> with every lone surrogate replaced by U+FFFD.</summary>
    internal static string ToWellFormed(string text)
    {
        if (IsWellFormed(text)) return text;
        var chars = text.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            var c = chars[i];
            if (!char.IsSurrogate(c)) continue;
            if (char.IsHighSurrogate(c) && i + 1 < chars.Length && char.IsLowSurrogate(chars[i + 1]))
            {
                i++;
                continue;
            }
            chars[i] = '�';
        }
        return new string(chars);
    }

    /// <summary>Appends <paramref name="text"/> as a JSON string literal, escaped the way <c>JSON.stringify</c> escapes it.</summary>
    internal static void Quote(StringBuilder output, string text)
    {
        output.Append('"');
        var run = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            string? escape = c switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\b' => "\\b",
                '\f' => "\\f",
                '\n' => "\\n",
                '\r' => "\\r",
                '\t' => "\\t",
                < ' ' => $"\\u{(int)c:x4}",
                _ => null,
            };
            if (escape is null) continue;
            output.Append(text, run, i - run).Append(escape);
            run = i + 1;
        }
        output.Append(text, run, text.Length - run).Append('"');
    }

    /// <summary>A JSON string element's text, lone surrogates included, which <see cref="JsonElement.GetString"/> refuses.</summary>
    internal static string ReadString(JsonElement element)
    {
        try
        {
            return element.GetString()!;
        }
        catch (InvalidOperationException)
        {
            var raw = Encoding.UTF8.GetBytes(element.GetRawText());
            return Unescape(raw.AsSpan(1, raw.Length - 2));
        }
    }

    /// <summary>The current string or property name token's text, lone surrogates included.</summary>
    internal static string ReadString(ref Utf8JsonReader reader)
    {
        if (!reader.ValueIsEscaped) return reader.GetString()!;
        try
        {
            return reader.GetString()!;
        }
        catch (InvalidOperationException)
        {
            return Unescape(reader.HasValueSequence ? System.Buffers.BuffersExtensions.ToArray(reader.ValueSequence) : reader.ValueSpan);
        }
    }

    /// <summary>Decodes the escaped UTF-8 body of a JSON string without validating surrogates.</summary>
    private static string Unescape(ReadOnlySpan<byte> raw)
    {
        var output = new StringBuilder(raw.Length);
        var run = 0;
        var i = 0;
        while (i < raw.Length)
        {
            if (raw[i] != (byte)'\\')
            {
                i++;
                continue;
            }
            output.Append(Encoding.UTF8.GetString(raw[run..i]));
            var kind = (char)raw[i + 1];
            if (kind == 'u')
            {
                output.Append((char)Convert.ToUInt16(Encoding.ASCII.GetString(raw.Slice(i + 2, 4)), 16));
                i += 6;
            }
            else
            {
                output.Append(kind switch
                {
                    'b' => '\b',
                    'f' => '\f',
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    _ => kind,
                });
                i += 2;
            }
            run = i;
        }
        output.Append(Encoding.UTF8.GetString(raw[run..]));
        return output.ToString();
    }
}
