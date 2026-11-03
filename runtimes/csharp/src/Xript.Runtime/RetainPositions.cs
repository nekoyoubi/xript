using System.Text.Json;

namespace Xript.Runtime;

/// <summary>
/// Where in a binding's arguments a callback may be retained: every position the manifest marks
/// <c>"retain": true</c>, found by walking the declared parameter types along the callback's
/// actual path, so a recursive type is retainable at any depth. A path's first step is the
/// argument index and its later steps are object keys or array indices.
/// </summary>
internal sealed class RetainPositions
{
    private sealed record DeclaredParam(TypeNode Type, bool Retain);

    private abstract record TypeNode;
    private sealed record FnType : TypeNode;
    private sealed record NamedType(string Name) : TypeNode;
    private sealed record OptionalType(TypeNode Inner) : TypeNode;
    private sealed record ArrayType(TypeNode Inner) : TypeNode;
    private sealed record MapType(TypeNode Inner) : TypeNode;
    private sealed record UnionType(List<TypeNode> Branches) : TypeNode;
    private sealed record OtherType : TypeNode;

    private readonly List<DeclaredParam?> _params = [];
    private readonly bool _lastVariadic;
    private readonly Dictionary<string, JsonElement>? _types;

    internal static readonly RetainPositions None = new([], false, null);

    private RetainPositions(List<DeclaredParam?> parameters, bool lastVariadic, Dictionary<string, JsonElement>? types)
    {
        _params = parameters;
        _lastVariadic = lastVariadic;
        _types = types;
    }

    /// <summary>The retain positions of one binding declaration, resolving type names against <paramref name="types"/>.</summary>
    internal static RetainPositions For(JsonElement bindingDef, Dictionary<string, JsonElement>? types)
    {
        if (bindingDef.ValueKind != JsonValueKind.Object || !bindingDef.TryGetProperty("params", out var parameters)
            || parameters.ValueKind != JsonValueKind.Array)
            return None;

        var declared = new List<DeclaredParam?>();
        var lastVariadic = false;
        foreach (var param in parameters.EnumerateArray())
        {
            var hasType = param.ValueKind == JsonValueKind.Object && param.TryGetProperty("type", out _);
            declared.Add(hasType ? new DeclaredParam(Parse(param.GetProperty("type")), IsRetain(param)) : null);
            lastVariadic = param.ValueKind == JsonValueKind.Object
                && param.TryGetProperty("variadic", out var v) && v.ValueKind == JsonValueKind.True;
        }
        return new RetainPositions(declared, lastVariadic, types);
    }

    /// <summary>Whether a callback found at <paramref name="path"/> sits at a retain position.</summary>
    internal bool Matches(IReadOnlyList<object> path)
    {
        if (_params.Count == 0 || path.Count == 0 || path[0] is not int argument) return false;
        var last = _params.Count - 1;
        DeclaredParam? param = argument < last || (argument == last && !_lastVariadic)
            ? _params[argument]
            : _lastVariadic && argument >= last ? _params[last] : null;
        return param is not null && RetainsAt(param.Type, param.Retain, path, 1);
    }

    private static bool IsRetain(JsonElement declaration) =>
        declaration.TryGetProperty("retain", out var retain) && retain.ValueKind == JsonValueKind.True;

    /// <summary>
    /// Whether <paramref name="type"/> leads, along the path from <paramref name="at"/>, to a retain
    /// position. <paramref name="retainHere"/> is the flag of the parameter or field the type belongs
    /// to; it applies only to the type itself or an optional of it, so a function inside an array,
    /// map, or union is a retain position only when a declared field marks it.
    /// </summary>
    private bool RetainsAt(TypeNode type, bool retainHere, IReadOnlyList<object> path, int at)
    {
        var remaining = path.Count - at;
        switch (type)
        {
            case FnType:
                return retainHere && remaining == 0;
            case OptionalType optional:
                return RetainsAt(optional.Inner, retainHere, path, at);
            case ArrayType array:
                return remaining > 0 && RetainsAt(array.Inner, false, path, at + 1);
            case MapType map:
                return remaining > 0 && RetainsAt(map.Inner, false, path, at + 1);
            case UnionType union:
                return union.Branches.Any(branch => RetainsAt(branch, false, path, at));
            case NamedType named:
                if (remaining == 0 || _types is null || !_types.TryGetValue(named.Name, out var def))
                    return false;
                if (def.ValueKind != JsonValueKind.Object || !def.TryGetProperty("fields", out var fields)
                    || fields.ValueKind != JsonValueKind.Object)
                    return false;
                var key = path[at] is string name ? name : Convert.ToString(path[at], System.Globalization.CultureInfo.InvariantCulture)!;
                if (!fields.TryGetProperty(key, out var field) || field.ValueKind != JsonValueKind.Object
                    || !field.TryGetProperty("type", out var fieldType))
                    return false;
                return RetainsAt(Parse(fieldType), IsRetain(field), path, at + 1);
            default:
                return false;
        }
    }

    private static TypeNode Parse(JsonElement type)
    {
        switch (type.ValueKind)
        {
            case JsonValueKind.String:
                return new TypeRefParser(type.GetString()!).ParseAll();
            case JsonValueKind.Object:
                if (type.TryGetProperty("function", out _)) return new FnType();
                if (type.TryGetProperty("optional", out var optional)) return new OptionalType(Parse(optional));
                if (type.TryGetProperty("array", out var array)) return new ArrayType(Parse(array));
                if (type.TryGetProperty("map", out var map)) return new MapType(Parse(map));
                if (type.TryGetProperty("union", out var union) && union.ValueKind == JsonValueKind.Array)
                    return new UnionType([.. union.EnumerateArray().Select(Parse)]);
                return new OtherType();
            default:
                return new OtherType();
        }
    }

    /// <summary>
    /// The string type grammar: <c>union := postfix ('|' postfix)*</c>,
    /// <c>postfix := primary ('[]' | '?')*</c>, <c>primary := name | '(' union ')'</c>.
    /// Anything it cannot read is an opaque type with no retain positions.
    /// </summary>
    private sealed class TypeRefParser(string text)
    {
        private int _at;

        internal TypeNode ParseAll()
        {
            try
            {
                var node = Union();
                SkipSpace();
                return _at == text.Length ? node : new OtherType();
            }
            catch (FormatException)
            {
                return new OtherType();
            }
        }

        private TypeNode Union()
        {
            var branches = new List<TypeNode> { Postfix() };
            while (true)
            {
                SkipSpace();
                if (_at < text.Length && text[_at] == '|')
                {
                    _at++;
                    branches.Add(Postfix());
                }
                else break;
            }
            return branches.Count == 1 ? branches[0] : new UnionType(branches);
        }

        private TypeNode Postfix()
        {
            var node = Primary();
            while (true)
            {
                SkipSpace();
                if (_at + 1 < text.Length && text[_at] == '[' && text[_at + 1] == ']')
                {
                    _at += 2;
                    node = new ArrayType(node);
                }
                else if (_at < text.Length && text[_at] == '?')
                {
                    _at++;
                    node = new OptionalType(node);
                }
                else return node;
            }
        }

        private TypeNode Primary()
        {
            SkipSpace();
            if (_at < text.Length && text[_at] == '(')
            {
                _at++;
                var inner = Union();
                SkipSpace();
                if (_at >= text.Length || text[_at] != ')') throw new FormatException();
                _at++;
                return inner;
            }
            var start = _at;
            while (_at < text.Length && (char.IsLetterOrDigit(text[_at]) || text[_at] is '_' or '$' or '.'))
                _at++;
            if (_at == start) throw new FormatException();
            var name = text[start.._at];
            return name == "function" ? new FnType() : new NamedType(name);
        }

        private void SkipSpace()
        {
            while (_at < text.Length && char.IsWhiteSpace(text[_at])) _at++;
        }
    }
}
