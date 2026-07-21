namespace Xript.Runtime.Expressions;

/// <summary>
/// The parsed shape of an XEG expression.
///
/// There is no node for a parenthesised group: parentheses steer parsing and carry no
/// meaning, so <c>(hp)</c> and <c>hp</c> produce the same AST and therefore the same
/// <see cref="ExpressionKind"/>.
/// </summary>
public abstract record Ast
{
    public sealed record Num(double Value) : Ast;
    public sealed record Str(string Value) : Ast;
    public sealed record Bool(bool Value) : Ast;
    public sealed record Null : Ast;
    public sealed record Name(string Value) : Ast;
    public sealed record Member(Ast Obj, string Property) : Ast;
    public sealed record Index(Ast Obj, Ast Key) : Ast;
    public sealed record Unary(UnaryOp Op, Ast Arg) : Ast;
    public sealed record Binary(BinaryOp Op, Ast Left, Ast Right) : Ast;
    public sealed record Logical(LogicalOp Op, Ast Left, Ast Right) : Ast;
    public sealed record Cond(Ast Test, Ast Consequent, Ast Alternate) : Ast;
    public sealed record Call(string Function, List<Ast> Args) : Ast;
}

public enum UnaryOp { Not, Negate, Plus }

public enum BinaryOp { Eq, Ne, Lt, Le, Gt, Ge, Add, Sub, Mul, Div, Rem }

public enum LogicalOp { And, Or, Nullish }

/// <summary>
/// Whether a <c>data-bind</c> body is writable. Only a bare name is: a computed value has
/// no inverse, so write-back has nowhere to land.
/// </summary>
public enum ExpressionKind { Name, Expression }

/// <summary>A parsed expression plus what static reading already knows about it.</summary>
public sealed record Expression(
    string Source,
    ExpressionKind Kind,
    Ast Ast,
    IReadOnlyList<string> Names,
    int NodeCount);

public sealed class ExpressionException : Exception
{
    public int Position { get; }

    public ExpressionException(int position, string message) : base(message)
    {
        Position = position;
    }
}
