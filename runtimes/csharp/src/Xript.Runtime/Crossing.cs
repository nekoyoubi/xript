using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime;
using Jint.Runtime.Descriptors;

namespace Xript.Runtime;

/// <summary>
/// Every value crossing between the sandbox and the host, in both directions.
///
/// Going out, <see cref="Encode"/> walks a script value with <c>JSON.stringify</c>'s rules: own
/// enumerable string keys in order, each property read once, <c>toJSON</c> applied (one that
/// throws is skipped), wrapper objects unwrapped, symbols and functions dropped from objects and
/// <c>null</c> in arrays. A getter that throws fails the crossing with its own error. With
/// <see cref="RuntimeOptions.ValueFidelity"/> on, the values JSON cannot spell travel as
/// <see cref="XriptValue"/> markers; with it off they flatten the way JSON flattens them, and a
/// BigInt or a cycle is refused with a <see cref="ValueCrossingException"/>.
///
/// Coming in, <see cref="Decode"/> builds the sandbox value directly from the JSON text, decoding
/// markers when fidelity is on and reviving retained-callback markers either way.
///
/// Both walks are iterative, so depth is bounded by <see cref="XriptValue.MaxDepth"/> rather than
/// by a thread's stack.
/// </summary>
internal sealed partial class Crossing
{
    private const string Key = XriptValue.Marker;
    private static readonly Regex BigIntText = new("^-?[0-9]+$", RegexOptions.CultureInvariant);

    private readonly Engine _engine;
    private readonly bool _fidelity;
    private readonly RetainedRegistry _retained;
    private readonly ObjectInstance _objectProto;
    private readonly ObjectInstance _arrayProto;
    private readonly ObjectInstance _bigintProto;
    private readonly JsValue _toStringTag;
    private readonly JsValue _numberValue;
    private readonly JsValue _stringValue;
    private readonly JsValue _booleanValue;
    private readonly JsValue _bigintValue;
    private readonly JsValue _symbolDescription;
    private readonly JsValue _symbolCtor;
    private readonly JsValue _bigintCtor;
    private readonly JsValue _isFunction;
    private readonly JsValue _isArray;
    private readonly JsValue _isError;

    /// <summary>Captures the built-ins it relies on; must run before any mod code.</summary>
    internal Crossing(Engine engine, bool fidelity, RetainedRegistry retained)
    {
        _engine = engine;
        _fidelity = fidelity;
        _retained = retained;
        var intrinsics = engine.Evaluate("""
            [Object.prototype, Array.prototype, BigInt.prototype, Object.prototype.toString,
             Number.prototype.valueOf, String.prototype.valueOf, Boolean.prototype.valueOf, BigInt.prototype.valueOf,
             Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get, Symbol, BigInt,
             function (v) { return typeof v === 'function'; }, Array.isArray,
             (function (E) { return function (v) { return v instanceof E; }; })(Error)]
            """).AsObject();
        JsValue At(int index) => intrinsics.Get(index.ToString(CultureInfo.InvariantCulture));
        _objectProto = At(0).AsObject();
        _arrayProto = At(1).AsObject();
        _bigintProto = At(2).AsObject();
        _toStringTag = At(3);
        _numberValue = At(4);
        _stringValue = At(5);
        _booleanValue = At(6);
        _bigintValue = At(7);
        _symbolDescription = At(8);
        _symbolCtor = At(9);
        _bigintCtor = At(10);
        _isFunction = At(11);
        _isArray = At(12);
        _isError = At(13);
    }

    private enum Slot { Top, Array, Object }

    private sealed class OutFrame
    {
        internal required ObjectInstance Container { get; init; }
        internal required bool IsArray { get; init; }
        internal required bool HasPathKey { get; init; }
        internal long Length { get; init; }
        internal List<(JsValue Key, string Name)>? Keys { get; init; }
        internal int Index { get; set; }
        internal bool Wrote { get; set; }
    }

    /// <summary>
    /// A script value as the host receives it. <paramref name="callbacks"/> is given exactly for a
    /// binding argument: it turns each script function into a callback token at its path, which
    /// starts at <paramref name="rootPath"/>. Without it functions flatten as JSON flattens them.
    /// A symbol crosses as a marker only as the value itself, never nested.
    /// </summary>
    internal JsonElement ToHost(
        JsValue value,
        string binding,
        Func<JsValue, IReadOnlyList<object>, string>? callbacks = null,
        IReadOnlyList<object>? rootPath = null)
    {
        var text = Encode(value, binding, callbacks, rootPath);
        return JsonDocument.Parse(text, JsonText.DeepDocument).RootElement.Clone();
    }

    internal string Encode(
        JsValue root,
        string binding,
        Func<JsValue, IReadOnlyList<object>, string>? callbacks = null,
        IReadOnlyList<object>? rootPath = null)
    {
        var output = new StringBuilder();
        var stack = new List<OutFrame>();
        var open = new HashSet<ObjectInstance>(ReferenceEqualityComparer.Instance);
        var path = rootPath is null ? new List<object>() : new List<object>(rootPath);

        bool Visit(JsValue value, string toJsonKey, Slot slot, Action? beforeWrite, bool hasPathKey)
        {
            var literal = Classify(value, toJsonKey, slot, binding, callbacks, path, stack, open, out var container);
            if (literal is null && container is null) return false;
            beforeWrite?.Invoke();
            if (literal is not null)
            {
                output.Append(literal);
                return true;
            }
            var obj = container!;
            if (stack.Count >= XriptValue.MaxDepth)
                throw new ValueCrossingException(binding, $"a value nested deeper than {XriptValue.MaxDepth} levels cannot cross to the host");
            if (IsArray(obj))
            {
                stack.Add(new OutFrame
                {
                    Container = obj,
                    IsArray = true,
                    HasPathKey = hasPathKey,
                    Length = (long)Math.Min(TypeConverter.ToLength(obj.Get("length")), int.MaxValue),
                });
                output.Append('[');
            }
            else
            {
                stack.Add(new OutFrame
                {
                    Container = obj,
                    IsArray = false,
                    HasPathKey = hasPathKey,
                    Keys = EnumerableKeys(obj),
                });
                output.Append('{');
            }
            open.Add(obj);
            return true;
        }

        Visit(root, "", Slot.Top, null, false);

        while (stack.Count > 0)
        {
            var frame = stack[^1];
            if (frame.IsArray ? frame.Index >= frame.Length : frame.Index >= frame.Keys!.Count)
            {
                output.Append(frame.IsArray ? ']' : '}');
                stack.RemoveAt(stack.Count - 1);
                open.Remove(frame.Container);
                if (frame.HasPathKey) path.RemoveAt(path.Count - 1);
                continue;
            }

            var index = frame.Index++;
            if (frame.IsArray)
            {
                if (index > 0) output.Append(',');
                path.Add(index);
                var element = frame.Container.Get(new JsNumber(index));
                Visit(element, index.ToString(CultureInfo.InvariantCulture), Slot.Array, null, true);
                if (stack[^1] == frame) path.RemoveAt(path.Count - 1);
            }
            else
            {
                var (key, name) = frame.Keys![index];
                path.Add(name);
                var value = frame.Container.Get(key);
                Visit(value, name, Slot.Object, () =>
                {
                    if (frame.Wrote) output.Append(',');
                    frame.Wrote = true;
                    JsonText.Quote(output, JsonText.ToWellFormed(name));
                    output.Append(':');
                }, true);
                if (stack[^1] == frame) path.RemoveAt(path.Count - 1);
            }
        }

        return output.ToString();
    }

    /// <summary>
    /// The JSON literal a value writes as, or null with <paramref name="container"/> set when it
    /// opens an array or object, or null with no container when an object property drops it.
    /// </summary>
    private string? Classify(
        JsValue value,
        string toJsonKey,
        Slot slot,
        string binding,
        Func<JsValue, IReadOnlyList<object>, string>? callbacks,
        List<object> path,
        List<OutFrame> stack,
        HashSet<ObjectInstance> open,
        out ObjectInstance? container)
    {
        container = null;
        if (value is ObjectInstance || value.Type == Types.BigInt)
            value = Prepare(value, toJsonKey);

        switch (value.Type)
        {
            case Types.Undefined:
                if (_fidelity) return Marker("undefined");
                return slot == Slot.Object ? null : "null";
            case Types.Null:
                return "null";
            case Types.Boolean:
                return value.AsBoolean() ? "true" : "false";
            case Types.Number:
                return NumberLiteral(value.AsNumber());
            case Types.String:
                return StringLiteral(value.AsString());
            case Types.BigInt:
                if (!_fidelity)
                    throw new ValueCrossingException(binding, "a BigInt cannot cross to the host without value fidelity");
                var digits = new StringBuilder();
                digits.Append("{\"").Append(Key).Append("\":\"bigint\",\"value\":");
                JsonText.Quote(digits, TypeConverter.ToString(value));
                return digits.Append('}').ToString();
            case Types.Symbol:
                if (slot == Slot.Top && _fidelity) return SymbolMarker(value);
                return slot == Slot.Object ? null : "null";
        }

        var obj = value.AsObject();
        if (IsCallable(obj))
        {
            if (callbacks is not null)
            {
                var marker = new StringBuilder("{\"").Append(XriptCallback.Marker).Append("\":");
                JsonText.Quote(marker, callbacks(obj, path));
                return marker.Append('}').ToString();
            }
            return slot == Slot.Object ? null : "null";
        }

        if (open.Contains(obj))
        {
            if (!_fidelity)
                throw new ValueCrossingException(binding, "a cyclic value cannot cross to the host without value fidelity");
            var up = 1;
            while (!ReferenceEquals(stack[^up].Container, obj)) up++;
            return $"{{\"{Key}\":\"cycle\",\"up\":{up}}}";
        }

        container = obj;
        return null;
    }

    private JsValue Prepare(JsValue value, string key)
    {
        var toJson = value is ObjectInstance obj ? obj.Get("toJSON") : _bigintProto.Get("toJSON");
        if (toJson is ObjectInstance candidate && IsCallable(candidate))
        {
            try
            {
                value = _engine.Call(toJson, value, [new JsString(key)]);
            }
            catch (JavaScriptException)
            {
            }
        }
        return value is ObjectInstance prepared ? Unwrap(prepared) : value;
    }

    /// <summary>A <c>Number</c>, <c>String</c>, <c>Boolean</c>, or <c>BigInt</c> wrapper as its primitive, as <c>JSON.stringify</c> unwraps it.</summary>
    private JsValue Unwrap(ObjectInstance obj)
    {
        if (IsPlain(obj) || IsCallable(obj))
            return obj;
        string tag;
        try
        {
            tag = TypeConverter.ToString(_engine.Call(_toStringTag, obj, []));
        }
        catch (JavaScriptException)
        {
            return obj;
        }
        return tag switch
        {
            "[object Number]" when Holds(_numberValue, obj, out _) => TypeConverter.ToNumber(obj),
            "[object String]" when Holds(_stringValue, obj, out _) => TypeConverter.ToString(obj),
            "[object Boolean]" when Holds(_booleanValue, obj, out var boolean) => boolean,
            "[object BigInt]" when Holds(_bigintValue, obj, out var bigint) => bigint,
            _ => obj,
        };
    }

    private bool IsPlain(ObjectInstance obj)
    {
        var proto = obj.Prototype;
        return proto is null || ReferenceEquals(proto, _objectProto) || ReferenceEquals(proto, _arrayProto);
    }

    /// <summary>
    /// <c>Array.isArray</c>, which sees through a Proxy to the array it wraps. Ordinary objects
    /// and arrays answer without a call; Jint keeps its proxy type internal, so any other object
    /// asks the built-in.
    /// </summary>
    private bool IsArray(ObjectInstance obj) =>
        obj.IsArray() || (obj is not JsObject && _engine.Call(_isArray, JsValue.Undefined, [obj]).AsBoolean());

    private bool IsCallable(ObjectInstance obj) =>
        obj is Jint.Native.Function.Function
        || (!IsPlain(obj) && _engine.Call(_isFunction, JsValue.Undefined, [obj]).AsBoolean());

    private bool Holds(JsValue valueOf, ObjectInstance obj, out JsValue primitive)
    {
        try
        {
            primitive = _engine.Call(valueOf, obj, []);
            return true;
        }
        catch (JavaScriptException)
        {
            primitive = JsValue.Undefined;
            return false;
        }
    }

    private static List<(JsValue Key, string Name)> EnumerableKeys(ObjectInstance obj)
    {
        var keys = new List<(JsValue, string)>();
        foreach (var key in obj.GetOwnPropertyKeys(Types.String))
        {
            var descriptor = obj.GetOwnProperty(key);
            if (descriptor != PropertyDescriptor.Undefined && descriptor.Enumerable)
                keys.Add((key, key.ToString()));
        }
        return keys;
    }

    private string NumberLiteral(double number)
    {
        if (double.IsNaN(number)) return _fidelity ? Marker("NaN") : "null";
        if (double.IsPositiveInfinity(number)) return _fidelity ? Marker("Infinity") : "null";
        if (double.IsNegativeInfinity(number)) return _fidelity ? Marker("-Infinity") : "null";
        if (number == 0 && double.IsNegative(number)) return _fidelity ? Marker("-0") : "0";
        return NumberText(number);
    }

    /// <summary>A finite number spelled the way JavaScript spells it, which is always valid JSON.</summary>
    internal static string NumberText(double number) =>
        number == Math.Floor(number) && Math.Abs(number) < long.MaxValue
            ? ((long)number).ToString(CultureInfo.InvariantCulture)
            : TypeConverter.ToString(new JsNumber(number));

    private string StringLiteral(string text)
    {
        var output = new StringBuilder(text.Length + 2);
        if (JsonText.IsWellFormed(text))
        {
            JsonText.Quote(output, text);
            return output.ToString();
        }
        if (!_fidelity)
        {
            JsonText.Quote(output, JsonText.ToWellFormed(text));
            return output.ToString();
        }
        output.Append("{\"").Append(Key).Append("\":\"string\",\"units\":[");
        for (var i = 0; i < text.Length; i++)
        {
            if (i > 0) output.Append(',');
            output.Append((int)text[i]);
        }
        return output.Append("]}").ToString();
    }

    private string SymbolMarker(JsValue symbol)
    {
        var description = _engine.Call(_symbolDescription, symbol, []);
        var output = new StringBuilder("{\"").Append(Key).Append("\":\"symbol\"");
        if (description.IsString())
        {
            output.Append(",\"description\":");
            JsonText.Quote(output, description.AsString());
        }
        return output.Append('}').ToString();
    }

    private static string Marker(string tag) => $"{{\"{Key}\":\"{tag}\"}}";

    private sealed class InFrame
    {
        internal required ObjectInstance Container { get; init; }
        internal required bool IsArray { get; init; }
        internal string? PendingKey { get; set; }
        internal JsValue? Tag { get; set; }
        internal JsValue? Callback { get; set; }
        internal Dictionary<string, JsValue>? Payload { get; set; }
    }

    /// <summary>A host value as the sandbox receives it.</summary>
    internal JsValue Decode(JsonElement element, string binding)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Null: return JsValue.Null;
            case JsonValueKind.Undefined: return JsValue.Undefined;
            case JsonValueKind.True: return JsBoolean.True;
            case JsonValueKind.False: return JsBoolean.False;
            case JsonValueKind.Number:
                return element.TryGetInt64(out var integer) ? new JsNumber(integer) : new JsNumber(element.GetDouble());
            case JsonValueKind.String:
                return new JsString(JsonText.ReadString(element));
        }

        var reader = new Utf8JsonReader(
            Encoding.UTF8.GetBytes(element.GetRawText()),
            new JsonReaderOptions { MaxDepth = XriptValue.MaxDepth + 2 });
        var stack = new List<InFrame>();
        JsValue result = JsValue.Undefined;

        void Attach(JsValue value)
        {
            if (stack.Count == 0)
            {
                result = value;
                return;
            }
            var frame = stack[^1];
            if (frame.IsArray)
            {
                ((Jint.Native.Array.ArrayInstance)frame.Container).Push(value);
                return;
            }
            var key = frame.PendingKey!;
            frame.Container.CreateDataProperty(key, value);
            switch (key)
            {
                case Key: frame.Tag = value; break;
                case XriptCallback.Marker: frame.Callback = value; break;
                case "value" or "description" or "units" or "up":
                    (frame.Payload ??= [])[key] = value;
                    break;
            }
        }

        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                case JsonTokenType.StartArray:
                    if (stack.Count >= XriptValue.MaxDepth)
                        throw new ValueCrossingException(binding, $"a value nested deeper than {XriptValue.MaxDepth} levels cannot cross into the sandbox");
                    var isArray = reader.TokenType == JsonTokenType.StartArray;
                    stack.Add(new InFrame
                    {
                        Container = isArray ? new JsArray(_engine, []) : new JsObject(_engine),
                        IsArray = isArray,
                    });
                    break;
                case JsonTokenType.PropertyName:
                    stack[^1].PendingKey = JsonText.ReadString(ref reader);
                    break;
                case JsonTokenType.EndArray:
                {
                    var frame = stack[^1];
                    stack.RemoveAt(stack.Count - 1);
                    Attach(frame.Container);
                    break;
                }
                case JsonTokenType.EndObject:
                {
                    var frame = stack[^1];
                    stack.RemoveAt(stack.Count - 1);
                    Attach(Finish(frame, stack));
                    break;
                }
                case JsonTokenType.String:
                    Attach(new JsString(JsonText.ReadString(ref reader)));
                    break;
                case JsonTokenType.Number:
                    Attach(reader.TryGetInt64(out var number) ? new JsNumber(number) : new JsNumber(reader.GetDouble()));
                    break;
                case JsonTokenType.True:
                    Attach(JsBoolean.True);
                    break;
                case JsonTokenType.False:
                    Attach(JsBoolean.False);
                    break;
                case JsonTokenType.Null:
                    Attach(JsValue.Null);
                    break;
            }
        }
        return result;
    }

    /// <summary>What a finished object decodes to: itself, or the value its marker names.</summary>
    private JsValue Finish(InFrame frame, List<InFrame> ancestors)
    {
        var obj = frame.Container;
        if (frame.Tag is null && frame.Callback is null) return obj;
        var count = obj.GetOwnPropertyKeys(Types.String).Count;

        if (frame.Callback is { } token && count == 1 && token.IsString())
            return _retained.Resolve(token.AsString()) ?? CallbackScope.Revive(token.AsString(), _engine) ?? obj;

        if (!_fidelity || frame.Tag is not { } tagValue || !tagValue.IsString()) return obj;
        var payload = frame.Payload;
        JsValue? Field(string name) => payload is not null && payload.TryGetValue(name, out var field) ? field : null;

        switch (tagValue.AsString())
        {
            case "undefined" when count == 1: return JsValue.Undefined;
            case "NaN" when count == 1: return new JsNumber(double.NaN);
            case "Infinity" when count == 1: return new JsNumber(double.PositiveInfinity);
            case "-Infinity" when count == 1: return new JsNumber(double.NegativeInfinity);
            case "-0" when count == 1: return new JsNumber(-0.0);
            case "bigint" when count == 2 && Field("value") is { } digits && digits.IsString() && BigIntText.IsMatch(digits.AsString()):
                return _engine.Call(_bigintCtor, JsValue.Undefined, [digits]);
            case "symbol" when count == 1:
                return _engine.Call(_symbolCtor, JsValue.Undefined, []);
            case "symbol" when count == 2 && Field("description") is { } description && description.IsString():
                return _engine.Call(_symbolCtor, JsValue.Undefined, [description]);
            case "string" when count == 2 && Field("units") is ObjectInstance units && units.IsArray()
                && Units(units) is { } text:
                return new JsString(text);
            case "cycle" when count == 2 && Field("up") is { } up && up.IsNumber()
                && up.AsNumber() is var levels && levels >= 1 && levels <= ancestors.Count && levels == Math.Floor(levels):
                return ancestors[^(int)levels].Container;
        }
        return obj;
    }

    private static string? Units(ObjectInstance array)
    {
        var length = (int)TypeConverter.ToLength(array.Get("length"));
        var chars = new char[length];
        for (var i = 0; i < length; i++)
        {
            var unit = array.Get(new JsNumber(i));
            if (!unit.IsNumber()) return null;
            var value = unit.AsNumber();
            if (value < 0 || value > 0xFFFF || value != Math.Floor(value)) return null;
            chars[i] = (char)(int)value;
        }
        return new string(chars);
    }
}
