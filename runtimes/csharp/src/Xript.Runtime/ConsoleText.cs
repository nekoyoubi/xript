using System.Globalization;
using System.Text;
using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime;

namespace Xript.Runtime;

/// <summary>
/// The text a console call hands the host, shared with every xript runtime: each argument
/// rendered on its own and joined by single spaces. A string is itself, an <c>Error</c> is
/// <c>name: message</c>, a function its source, and anything else the text of the data a
/// JavaScript host would receive: <c>JSON.stringify</c>'s rules, keeping <c>undefined</c>, the
/// special numbers, and BigInts, with <c>[Circular]</c> for a reference back to an ancestor.
/// An argument whose reading throws renders as <c>[unreadable: &lt;description&gt;]</c> and
/// leaves the others alone; an execution-limit stop is not caught and still ends the script.
/// </summary>
internal sealed partial class Crossing
{
    private sealed class TextFrame
    {
        internal required ObjectInstance Container { get; init; }
        internal required bool IsArray { get; init; }
        internal long Length { get; init; }
        internal List<(JsValue Key, string Name)>? Keys { get; init; }
        internal int Index { get; set; }
        internal bool Wrote { get; set; }
    }

    private sealed class TooDeepException() : Exception($"a value nested deeper than {XriptValue.MaxDepth} levels cannot be read");

    internal string ConsoleMessage(JsValue[] arguments)
    {
        var parts = new string[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            try
            {
                parts[i] = ConsoleArgument(arguments[i]);
            }
            catch (JavaScriptException thrown)
            {
                parts[i] = $"[unreadable: {DescribeThrown(thrown.Error)}]";
            }
            catch (TooDeepException tooDeep)
            {
                parts[i] = $"[unreadable: RangeError: {tooDeep.Message}]";
            }
        }
        return string.Join(' ', parts);
    }

    private static readonly string[] Named = ["name", "message", "stack"];

    private string ConsoleArgument(JsValue value)
    {
        if (value.IsString()) return value.AsString();
        if (value.IsSymbol()) return SymbolText(value);
        var source = value as ObjectInstance;
        if (source is not null && IsCallable(source)) return TypeConverter.ToString(source);
        var isError = source is not null && _engine.Call(_isError, JsValue.Undefined, [source]).AsBoolean();

        var named = new Dictionary<string, JsValue>();
        var prepared = source is not null || value.Type == Types.BigInt ? Prepare(value, "") : value;
        string text;
        if (prepared.IsString()) text = prepared.AsString();
        else if (prepared.IsSymbol()) text = SymbolText(prepared);
        else if (prepared is ObjectInstance container && IsCallable(container)) text = "undefined";
        else text = DataText(prepared, source, named);
        return isError ? ErrorLabel(named) : text;
    }

    /// <summary>An <c>Error</c>'s text, from the <c>name</c> and <c>message</c> its data form carries.</summary>
    private static string ErrorLabel(Dictionary<string, JsValue> named)
    {
        var name = named.TryGetValue("name", out var n) && n.IsString() ? n.AsString() : "Error";
        return named.TryGetValue("message", out var m) && m.IsString() && m.AsString().Length > 0
            ? $"{name}: {m.AsString()}"
            : name;
    }

    /// <summary>
    /// How a value a reading threw is described: for an object, <c>name: message</c> when its
    /// message is a non-empty string and its bare name otherwise (<c>Error</c> standing in for a
    /// name that is not a string); for anything else, <c>String(value)</c>.
    /// </summary>
    private static string DescribeThrown(JsValue thrown)
    {
        if (thrown is ObjectInstance obj)
        {
            var name = ReadQuietly(obj, "name");
            var message = ReadQuietly(obj, "message");
            var label = name.IsString() ? name.AsString() : "Error";
            return message.IsString() && message.AsString().Length > 0 ? $"{label}: {message.AsString()}" : label;
        }
        try
        {
            return thrown.IsSymbol() ? thrown.ToString() : TypeConverter.ToString(thrown);
        }
        catch (JavaScriptException)
        {
            return "Error";
        }
    }

    private static JsValue ReadQuietly(ObjectInstance obj, string key)
    {
        try
        {
            return obj.Get(key);
        }
        catch (JavaScriptException)
        {
            return JsValue.Undefined;
        }
    }

    private string SymbolText(JsValue symbol)
    {
        var description = _engine.Call(_symbolDescription, symbol, []);
        return description.IsString() ? $"Symbol({description.AsString()})" : "Symbol()";
    }

    /// <summary>
    /// The text of a data form, walked without recursion. <paramref name="root"/> is already
    /// prepared (<c>toJSON</c> applied, wrappers unwrapped). With <paramref name="source"/>, the
    /// top-level object it came from, a root object also carries <c>name</c>, <c>message</c>, and
    /// <c>stack</c> when the source has them other than as own enumerable keys, copied after its
    /// own keys; one that throws, or holds <c>undefined</c>, a symbol, or a function, is left out.
    /// <paramref name="named"/> collects the root's <c>name</c> and <c>message</c> as the data form
    /// carries them. <paramref name="ancestors"/> are containers a copied value sits inside.
    /// </summary>
    private string DataText(
        JsValue root,
        ObjectInstance? source = null,
        Dictionary<string, JsValue>? named = null,
        HashSet<ObjectInstance>? ancestors = null)
    {
        var output = new StringBuilder();
        var stack = new List<TextFrame>();
        var open = new HashSet<ObjectInstance>(ancestors ?? [], ReferenceEqualityComparer.Instance);
        var rootEmitted = new HashSet<string>();
        TextFrame? rootFrame = null;
        var prepareRoot = false;

        bool Visit(JsValue value, string toJsonKey, bool inObject, Action? beforeWrite, out JsValue prepared)
        {
            if (prepareRoot && (value is ObjectInstance || value.Type == Types.BigInt))
                value = Prepare(value, toJsonKey);
            prepareRoot = true;
            prepared = value;
            string? literal = value.Type switch
            {
                Types.Undefined => "undefined",
                Types.Null => "null",
                Types.Boolean => value.AsBoolean() ? "true" : "false",
                Types.Number => ConsoleNumber(value.AsNumber()),
                Types.String => QuotedText(value.AsString()),
                Types.BigInt => TypeConverter.ToString(value) + "n",
                Types.Symbol => inObject ? null : "null",
                _ => "",
            };
            if (literal is null) return false;
            if (literal.Length > 0 || value.Type == Types.String)
            {
                beforeWrite?.Invoke();
                output.Append(literal);
                return true;
            }

            var obj = value.AsObject();
            if (IsCallable(obj))
            {
                if (inObject) return false;
                beforeWrite?.Invoke();
                output.Append("null");
                return true;
            }
            beforeWrite?.Invoke();
            if (open.Contains(obj))
            {
                output.Append("[Circular]");
                return true;
            }
            if (stack.Count >= XriptValue.MaxDepth)
                throw new TooDeepException();
            var isArray = IsArray(obj);
            stack.Add(isArray
                ? new TextFrame { Container = obj, IsArray = true, Length = (long)Math.Min(TypeConverter.ToLength(obj.Get("length")), int.MaxValue) }
                : new TextFrame { Container = obj, IsArray = false, Keys = EnumerableKeys(obj) });
            open.Add(obj);
            output.Append(isArray ? '[' : '{');
            return true;
        }

        Visit(root, "", false, null, out _);
        if (stack.Count > 0) rootFrame = stack[0];
        while (stack.Count > 0)
        {
            var frame = stack[^1];
            if (frame.IsArray ? frame.Index >= frame.Length : frame.Index >= frame.Keys!.Count)
            {
                if (frame == rootFrame && !frame.IsArray && source is not null)
                    CopyNamed(frame);
                output.Append(frame.IsArray ? ']' : '}');
                stack.RemoveAt(stack.Count - 1);
                open.Remove(frame.Container);
                continue;
            }
            var index = frame.Index++;
            if (frame.IsArray)
            {
                if (index > 0) output.Append(',');
                Visit(frame.Container.Get(new JsNumber(index)), index.ToString(CultureInfo.InvariantCulture), false, null, out _);
            }
            else
            {
                var (key, name) = frame.Keys![index];
                var wrote = Visit(frame.Container.Get(key), name, true, () =>
                {
                    if (frame.Wrote) output.Append(',');
                    frame.Wrote = true;
                    output.Append(QuotedText(name)).Append(':');
                }, out var prepared);
                if (frame == rootFrame && wrote)
                {
                    rootEmitted.Add(name);
                    if (named is not null && name is "name" or "message") named[name] = prepared;
                }
            }
        }
        return output.ToString();

        void CopyNamed(TextFrame frame)
        {
            foreach (var key in Named)
            {
                if (rootEmitted.Contains(key) || !source.HasProperty(key)) continue;
                JsValue value;
                string text;
                try
                {
                    value = source.Get(key);
                    if (value is ObjectInstance || value.Type == Types.BigInt)
                        value = Prepare(value, key);
                    if (value.IsUndefined() || value.IsSymbol() || (value is ObjectInstance candidate && IsCallable(candidate)))
                        continue;
                    text = DataText(value, ancestors: open);
                }
                catch (JavaScriptException)
                {
                    continue;
                }
                catch (TooDeepException)
                {
                    continue;
                }
                if (frame.Wrote) output.Append(',');
                frame.Wrote = true;
                output.Append(QuotedText(key)).Append(':').Append(text);
                if (named is not null && key is "name" or "message") named[key] = value;
            }
        }
    }

    private static string ConsoleNumber(double number)
    {
        if (double.IsNaN(number)) return "NaN";
        if (double.IsPositiveInfinity(number)) return "Infinity";
        if (double.IsNegativeInfinity(number)) return "-Infinity";
        if (number == 0 && double.IsNegative(number)) return "-0";
        return TypeConverter.ToString(new JsNumber(number));
    }

    /// <summary>A string quoted as <c>JSON.stringify</c> quotes it, a lone surrogate escaped as <c>\uXXXX</c>.</summary>
    private static string QuotedText(string text)
    {
        var output = new StringBuilder(text.Length + 2);
        JsonText.Quote(output, text);
        if (JsonText.IsWellFormed(text)) return output.ToString();
        var escaped = new StringBuilder(output.Length + 8);
        for (var i = 0; i < output.Length; i++)
        {
            var c = output[i];
            if (char.IsHighSurrogate(c) && i + 1 < output.Length && char.IsLowSurrogate(output[i + 1]))
            {
                escaped.Append(c).Append(output[++i]);
                continue;
            }
            if (char.IsSurrogate(c))
                escaped.Append($"\\u{(int)c:x4}");
            else
                escaped.Append(c);
        }
        return escaped.ToString();
    }
}
