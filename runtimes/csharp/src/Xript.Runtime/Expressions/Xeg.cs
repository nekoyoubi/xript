using System.Collections.Concurrent;

namespace Xript.Runtime.Expressions;

/// <summary>
/// XEG -- the xript Expression Grammar. One total, pure expression language shared by
/// <c>data-if</c>, <c>data-bind</c>, and inline <c>{{ … }}</c> interpolation.
///
/// Identifiers resolve only against a fill's declared bindings and calls resolve only
/// against the closed builtin table, so no production names a host global and no evaluation
/// reaches a value's members. Semantics are pinned by <c>spec/expression-tests.json</c>, not
/// by "whatever JavaScript does" -- which is precisely how five readings of the same
/// attribute drifted apart in the first place.
/// </summary>
public static class Xeg
{
    private static readonly ConcurrentDictionary<string, ParseResult> Cache = new(StringComparer.Ordinal);

    private readonly record struct ParseResult(Expression? Expression, ExpressionException? Error);

    /// <summary>Parses through the shared cache. Fragments re-render far more often than they load.</summary>
    public static Expression? ParseCached(string source)
    {
        if (Cache.Count > 512) Cache.Clear();
        var result = Cache.GetOrAdd(source, key =>
        {
            ExpressionParser.TryParse(key, out var expression, out var error);
            return new ParseResult(expression, error);
        });
        return result.Expression;
    }

    /// <summary>
    /// Evaluates a source string. An unparseable source is <c>null</c>, never an exception:
    /// a fragment with one bad expression still renders the rest of itself.
    /// </summary>
    public static object? Evaluate(string source, IReadOnlyDictionary<string, object?> bindings)
    {
        var expression = ParseCached(source);
        return expression is null ? null : EvaluateAst(expression.Ast, bindings);
    }

    /// <summary><c>data-if</c>: the expression's truth. Unparseable or failing is <c>false</c>.</summary>
    public static bool EvaluateCondition(string source, IReadOnlyDictionary<string, object?> bindings) =>
        ExprValue.IsTruthy(Evaluate(source, bindings));

    /// <summary>
    /// Classifies a <c>data-bind</c> body. A bare identifier is an lvalue and keeps two-way
    /// write-back; anything else computes a value with no inverse and is read-only.
    /// </summary>
    public static ExpressionKind? Kind(string source) => ParseCached(source)?.Kind;

    /// <summary>
    /// Evaluates a parsed expression. Total by construction: every pathological input lands
    /// on <c>null</c> rather than aborting a render.
    /// </summary>
    public static object? EvaluateAst(Ast ast, IReadOnlyDictionary<string, object?> bindings)
    {
        try
        {
            return Eval(ast, bindings);
        }
        catch
        {
            return null;
        }
    }

    private static object? Eval(Ast ast, IReadOnlyDictionary<string, object?> bindings)
    {
        switch (ast)
        {
            case Ast.Num node: return ExprValue.Finite(node.Value);
            case Ast.Str node: return node.Value;
            case Ast.Bool node: return node.Value;
            case Ast.Null: return null;

            case Ast.Name node:
                return bindings.TryGetValue(node.Value, out var bound)
                    ? ExprValue.Normalize(bound)
                    : null;

            case Ast.Member node:
                return ExprValue.ReadMember(Eval(node.Obj, bindings), node.Property);

            case Ast.Index node:
            {
                var target = Eval(node.Obj, bindings);
                return Eval(node.Key, bindings) switch
                {
                    double index => ExprValue.ReadIndex(target, (long)index),
                    string key => ExprValue.ReadMember(target, key),
                    _ => null,
                };
            }

            case Ast.Unary node:
            {
                var value = Eval(node.Arg, bindings);
                if (node.Op == UnaryOp.Not) return !ExprValue.IsTruthy(value);
                var number = ExprValue.AsNumber(value);
                if (number is null) return null;
                return ExprValue.Finite(node.Op == UnaryOp.Negate ? -number.Value : number.Value);
            }

            case Ast.Logical node:
            {
                var left = Eval(node.Left, bindings);
                return node.Op switch
                {
                    LogicalOp.And => ExprValue.IsTruthy(left) ? Eval(node.Right, bindings) : left,
                    LogicalOp.Or => ExprValue.IsTruthy(left) ? left : Eval(node.Right, bindings),
                    _ => left is null ? Eval(node.Right, bindings) : left,
                };
            }

            case Ast.Cond node:
                return ExprValue.IsTruthy(Eval(node.Test, bindings))
                    ? Eval(node.Consequent, bindings)
                    : Eval(node.Alternate, bindings);

            case Ast.Call node:
            {
                var args = node.Args.Select(arg => Eval(arg, bindings)).ToList();
                return Builtins.Call(node.Function, args);
            }

            case Ast.Binary node:
            {
                var left = Eval(node.Left, bindings);
                var right = Eval(node.Right, bindings);

                switch (node.Op)
                {
                    case BinaryOp.Eq: return ExprValue.StrictEqual(left, right);
                    case BinaryOp.Ne: return !ExprValue.StrictEqual(left, right);
                    case BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge:
                        return ExprValue.Compare(node.Op, left, right);
                    case BinaryOp.Add:
                    {
                        if (left is string || right is string)
                        {
                            if (!ExprValue.IsPrimitive(left) || !ExprValue.IsPrimitive(right)) return null;
                            return ExprValue.Render(left) + ExprValue.Render(right);
                        }
                        var a = ExprValue.AsNumber(left);
                        var b = ExprValue.AsNumber(right);
                        return a is null || b is null ? null : ExprValue.Finite(a.Value + b.Value);
                    }
                    default:
                    {
                        var a = ExprValue.AsNumber(left);
                        var b = ExprValue.AsNumber(right);
                        if (a is null || b is null) return null;
                        return node.Op switch
                        {
                            BinaryOp.Sub => ExprValue.Finite(a.Value - b.Value),
                            BinaryOp.Mul => ExprValue.Finite(a.Value * b.Value),
                            _ when b.Value == 0 => null,
                            BinaryOp.Div => ExprValue.Finite(a.Value / b.Value),
                            _ => ExprValue.Finite(a.Value % b.Value),
                        };
                    }
                }
            }

            default: return null;
        }
    }
}
