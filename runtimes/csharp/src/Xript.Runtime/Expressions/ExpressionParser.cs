using System.Globalization;
using System.Text;

namespace Xript.Runtime.Expressions;

/// <summary>
/// The XEG parser: source text in, AST out, no code generation anywhere.
///
/// This replaced a per-evaluation <c>Jint.Engine</c>. That shape was the closest of the
/// four runtimes to correct -- a bare engine, no CLR interop, a timeout -- and it still had
/// to go: a second JavaScript engine is a second grammar with second semantics, and the
/// whole point is that one expression means one thing everywhere.
/// </summary>
public static class ExpressionParser
{
    public const int DefaultMaxExpressionNodes = 256;

    /// <summary>
    /// Words the grammar refuses as identifiers. Each names a JavaScript capability XEG does
    /// not have; rejecting them by name makes the error say so instead of surfacing as an
    /// anonymous syntax error two tokens later.
    /// </summary>
    private static readonly HashSet<string> ReservedWords = new(StringComparer.Ordinal)
    {
        "function", "return", "var", "let", "const", "new", "delete", "typeof", "void",
        "in", "instanceof", "this", "class", "import", "export", "await", "yield",
        "if", "else", "for", "while", "do", "switch", "case", "try", "catch", "throw",
        "undefined", "globalThis", "eval", "arguments",
    };

    private enum TokenType { Num, Str, Name, Punct, Eof }

    private readonly record struct Token(TokenType Type, string Text, double Number, int Pos);

    private static readonly string[] Punct2 = ["==", "!=", "<=", ">=", "&&", "||", "??"];
    private static readonly string[] Punct1 =
        ["<", ">", "+", "-", "*", "/", "%", "!", "?", ":", "(", ")", "[", "]", ",", "."];

    private static List<Token> Tokenize(string source)
    {
        var tokens = new List<Token>();
        var i = 0;

        while (i < source.Length)
        {
            var ch = source[i];

            if (char.IsWhiteSpace(ch)) { i++; continue; }

            if (char.IsAsciiDigit(ch) || (ch == '.' && i + 1 < source.Length && char.IsAsciiDigit(source[i + 1])))
            {
                var start = i;
                while (i < source.Length && char.IsAsciiDigit(source[i])) i++;
                if (i < source.Length && source[i] == '.'
                    && i + 1 < source.Length && char.IsAsciiDigit(source[i + 1]))
                {
                    i++;
                    while (i < source.Length && char.IsAsciiDigit(source[i])) i++;
                }
                else if (i < source.Length && source[i] == '.' && start == i)
                {
                    i++;
                    while (i < source.Length && char.IsAsciiDigit(source[i])) i++;
                }
                if (i < source.Length && (source[i] == 'e' || source[i] == 'E'))
                {
                    var j = i + 1;
                    if (j < source.Length && (source[j] == '+' || source[j] == '-')) j++;
                    if (j < source.Length && char.IsAsciiDigit(source[j]))
                    {
                        i = j;
                        while (i < source.Length && char.IsAsciiDigit(source[i])) i++;
                    }
                }
                var text = source[start..i];
                if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                    throw new ExpressionException(start, "invalid number literal");
                tokens.Add(new Token(TokenType.Num, text, value, start));
                continue;
            }

            if (ch == '"' || ch == '\'')
            {
                var start = i;
                var quote = ch;
                i++;
                var builder = new StringBuilder();
                while (i < source.Length && source[i] != quote)
                {
                    if (source[i] == '\n') throw new ExpressionException(start, "unterminated string literal");
                    if (source[i] == '\\')
                    {
                        i++;
                        if (i >= source.Length) throw new ExpressionException(start, "unterminated string literal");
                        switch (source[i])
                        {
                            case 'n': builder.Append('\n'); break;
                            case 't': builder.Append('\t'); break;
                            case 'r': builder.Append('\r'); break;
                            case 'b': builder.Append('\b'); break;
                            case 'f': builder.Append('\f'); break;
                            case '0': builder.Append('\0'); break;
                            case 'u':
                            {
                                if (i + 4 >= source.Length)
                                    throw new ExpressionException(i, "invalid unicode escape");
                                var hex = source.Substring(i + 1, 4);
                                if (!int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var code))
                                    throw new ExpressionException(i, "invalid unicode escape");
                                builder.Append((char)code);
                                i += 4;
                                break;
                            }
                            default: builder.Append(source[i]); break;
                        }
                        i++;
                        continue;
                    }
                    builder.Append(source[i]);
                    i++;
                }
                if (i >= source.Length) throw new ExpressionException(start, "unterminated string literal");
                i++;
                tokens.Add(new Token(TokenType.Str, builder.ToString(), 0, start));
                continue;
            }

            if (char.IsAsciiLetter(ch) || ch == '_' || ch == '$')
            {
                var start = i;
                while (i < source.Length
                    && (char.IsAsciiLetterOrDigit(source[i]) || source[i] == '_' || source[i] == '$'))
                {
                    i++;
                }
                tokens.Add(new Token(TokenType.Name, source[start..i], 0, start));
                continue;
            }

            var three = i + 3 <= source.Length ? source.Substring(i, 3) : "";
            if (three == "===") { tokens.Add(new Token(TokenType.Punct, "==", 0, i)); i += 3; continue; }
            if (three == "!==") { tokens.Add(new Token(TokenType.Punct, "!=", 0, i)); i += 3; continue; }

            var two = i + 2 <= source.Length ? source.Substring(i, 2) : "";
            if (Array.IndexOf(Punct2, two) >= 0)
            {
                tokens.Add(new Token(TokenType.Punct, two, 0, i));
                i += 2;
                continue;
            }

            if (two is "++" or "--")
                throw new ExpressionException(i, $"'{two}' is not part of the xript expression grammar");
            if (two == "=>")
                throw new ExpressionException(i, "arrow functions are not part of the xript expression grammar");
            if (two == "?.")
                throw new ExpressionException(i, "optional chaining is not part of the xript expression grammar");

            var one = ch.ToString();
            if (Array.IndexOf(Punct1, one) >= 0)
            {
                tokens.Add(new Token(TokenType.Punct, one, 0, i));
                i++;
                continue;
            }

            throw ch switch
            {
                '=' => new ExpressionException(i, "assignment is not part of the xript expression grammar"),
                ';' => new ExpressionException(i, "statements are not part of the xript expression grammar"),
                '{' or '}' => new ExpressionException(i, "object literals and blocks are not part of the xript expression grammar"),
                '&' or '|' or '^' or '~' => new ExpressionException(i, "bitwise operators are not part of the xript expression grammar"),
                '`' => new ExpressionException(i, "template literals are not part of the xript expression grammar"),
                '#' => new ExpressionException(i, "block helpers ('{{#if}}', '{{#each}}') do not exist -- a fragment carries no control flow"),
                _ => new ExpressionException(i, $"unexpected character '{ch}'"),
            };
        }

        tokens.Add(new Token(TokenType.Eof, "", 0, source.Length));
        return tokens;
    }

    private sealed class Cursor
    {
        public required string Source { get; init; }
        public required List<Token> Tokens { get; init; }
        public required int MaxNodes { get; init; }
        public int Index;
        public int Count;
        public readonly List<string> Names = [];

        public Token Peek => Tokens[Math.Min(Index, Tokens.Count - 1)];

        public Token Next()
        {
            var token = Peek;
            if (Index < Tokens.Count - 1) Index++;
            return token;
        }

        public bool At(string value) => Peek.Type == TokenType.Punct && Peek.Text == value;

        public bool Eat(string value)
        {
            if (!At(value)) return false;
            Index++;
            return true;
        }

        public void Expect(string value)
        {
            if (!Eat(value)) throw new ExpressionException(Peek.Pos, $"expected '{value}'");
        }

        public T Node<T>(T node) where T : Ast
        {
            Count++;
            if (Count > MaxNodes)
                throw new ExpressionException(0, $"expression exceeds the {MaxNodes}-node limit");
            return node;
        }
    }

    public static Expression Parse(string source, int maxNodes = DefaultMaxExpressionNodes)
    {
        if (string.IsNullOrWhiteSpace(source)) throw new ExpressionException(0, "empty expression");

        var cursor = new Cursor { Source = source, Tokens = Tokenize(source), MaxNodes = maxNodes };
        var ast = ParseExpr(cursor);
        if (cursor.Peek.Type != TokenType.Eof)
            throw new ExpressionException(cursor.Peek.Pos, $"unexpected token '{cursor.Peek.Text}'");

        var kind = ast is Ast.Name ? ExpressionKind.Name : ExpressionKind.Expression;
        return new Expression(source, kind, ast, cursor.Names, cursor.Count);
    }

    public static bool TryParse(string source, out Expression? expression, out ExpressionException? error)
    {
        try
        {
            expression = Parse(source);
            error = null;
            return true;
        }
        catch (ExpressionException ex)
        {
            expression = null;
            error = ex;
            return false;
        }
    }

    private static Ast ParseExpr(Cursor c)
    {
        var test = ParseNullish(c);
        if (!c.Eat("?")) return test;
        var cons = ParseExpr(c);
        c.Expect(":");
        var alt = ParseExpr(c);
        return c.Node(new Ast.Cond(test, cons, alt));
    }

    private static Ast ParseNullish(Cursor c)
    {
        var left = ParseOr(c);
        while (c.At("??"))
        {
            c.Next();
            left = c.Node(new Ast.Logical(LogicalOp.Nullish, left, ParseOr(c)));
        }
        return left;
    }

    private static Ast ParseOr(Cursor c)
    {
        var left = ParseAnd(c);
        while (c.At("||"))
        {
            c.Next();
            left = c.Node(new Ast.Logical(LogicalOp.Or, left, ParseAnd(c)));
        }
        return left;
    }

    private static Ast ParseAnd(Cursor c)
    {
        var left = ParseEquality(c);
        while (c.At("&&"))
        {
            c.Next();
            left = c.Node(new Ast.Logical(LogicalOp.And, left, ParseEquality(c)));
        }
        return left;
    }

    private static Ast ParseEquality(Cursor c)
    {
        var left = ParseRelational(c);
        while (true)
        {
            BinaryOp op;
            if (c.At("==")) op = BinaryOp.Eq;
            else if (c.At("!=")) op = BinaryOp.Ne;
            else return left;
            c.Next();
            left = c.Node(new Ast.Binary(op, left, ParseRelational(c)));
        }
    }

    private static Ast ParseRelational(Cursor c)
    {
        var left = ParseAdditive(c);
        while (true)
        {
            BinaryOp op;
            if (c.At("<=")) op = BinaryOp.Le;
            else if (c.At(">=")) op = BinaryOp.Ge;
            else if (c.At("<")) op = BinaryOp.Lt;
            else if (c.At(">")) op = BinaryOp.Gt;
            else return left;
            c.Next();
            left = c.Node(new Ast.Binary(op, left, ParseAdditive(c)));
        }
    }

    private static Ast ParseAdditive(Cursor c)
    {
        var left = ParseMultiplicative(c);
        while (true)
        {
            BinaryOp op;
            if (c.At("+")) op = BinaryOp.Add;
            else if (c.At("-")) op = BinaryOp.Sub;
            else return left;
            c.Next();
            left = c.Node(new Ast.Binary(op, left, ParseMultiplicative(c)));
        }
    }

    private static Ast ParseMultiplicative(Cursor c)
    {
        var left = ParseUnary(c);
        while (true)
        {
            BinaryOp op;
            if (c.At("*")) op = BinaryOp.Mul;
            else if (c.At("/")) op = BinaryOp.Div;
            else if (c.At("%")) op = BinaryOp.Rem;
            else return left;
            c.Next();
            left = c.Node(new Ast.Binary(op, left, ParseUnary(c)));
        }
    }

    private static Ast ParseUnary(Cursor c)
    {
        UnaryOp op;
        if (c.At("!")) op = UnaryOp.Not;
        else if (c.At("-")) op = UnaryOp.Negate;
        else if (c.At("+")) op = UnaryOp.Plus;
        else return ParsePostfix(c);
        c.Next();
        return c.Node(new Ast.Unary(op, ParseUnary(c)));
    }

    private static Ast ParsePostfix(Cursor c)
    {
        var target = ParsePrimary(c);
        while (true)
        {
            if (c.Eat("."))
            {
                var token = c.Next();
                if (token.Type != TokenType.Name)
                    throw new ExpressionException(token.Pos, "expected a property name after '.'");
                target = c.Node(new Ast.Member(target, token.Text));
                continue;
            }
            if (c.Eat("["))
            {
                var key = ParseExpr(c);
                c.Expect("]");
                target = c.Node(new Ast.Index(target, key));
                continue;
            }
            if (c.At("("))
            {
                throw new ExpressionException(
                    c.Peek.Pos, "only builtin functions are callable; a binding value is not");
            }
            return target;
        }
    }

    private static Ast ParsePrimary(Cursor c)
    {
        var token = c.Peek;

        switch (token.Type)
        {
            case TokenType.Num:
                c.Next();
                return c.Node(new Ast.Num(token.Number));

            case TokenType.Str:
                c.Next();
                return c.Node(new Ast.Str(token.Text));

            case TokenType.Name:
            {
                c.Next();
                if (token.Text == "true") return c.Node(new Ast.Bool(true));
                if (token.Text == "false") return c.Node(new Ast.Bool(false));
                if (token.Text == "null") return c.Node(new Ast.Null());
                if (ReservedWords.Contains(token.Text))
                {
                    throw new ExpressionException(
                        token.Pos, $"'{token.Text}' is not part of the xript expression grammar");
                }

                if (c.At("("))
                {
                    var arity = Builtins.Arity(token.Text)
                        ?? throw new ExpressionException(
                            token.Pos,
                            $"unknown function '{token.Text}' -- only builtins are callable");
                    c.Next();
                    var args = new List<Ast>();
                    if (!c.At(")"))
                    {
                        args.Add(ParseExpr(c));
                        while (c.Eat(",")) args.Add(ParseExpr(c));
                    }
                    c.Expect(")");
                    if (args.Count < arity.Min || args.Count > arity.Max)
                    {
                        throw new ExpressionException(
                            token.Pos,
                            $"'{token.Text}' takes {arity.Min}-"
                            + (arity.Max == int.MaxValue ? "n" : arity.Max.ToString(CultureInfo.InvariantCulture))
                            + $" argument(s), got {args.Count}");
                    }
                    return c.Node(new Ast.Call(token.Text, args));
                }

                if (!c.Names.Contains(token.Text)) c.Names.Add(token.Text);
                return c.Node(new Ast.Name(token.Text));
            }

            case TokenType.Punct when token.Text == "(":
            {
                c.Next();
                var inner = ParseExpr(c);
                c.Expect(")");
                return inner;
            }

            case TokenType.Eof:
                throw new ExpressionException(token.Pos, "unexpected end of expression");

            default:
                throw new ExpressionException(token.Pos, $"unexpected token '{token.Text}'");
        }
    }
}
