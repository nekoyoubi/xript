using System.Globalization;
using System.Text;
using System.Text.Json;
using Xript.Runtime.Expressions;

// The C# side of the XEG differential fuzzer (`npm run fuzz:xeg`). Reads one JSON case per
// line on stdin and writes one JSON result per line on stdout, in order.

var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

string? line;
while ((line = input.ReadLine()) is not null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;
    var json = new StringBuilder();
    try
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        var bindings = Bindings(root);
        switch (root.GetProperty("k").GetString())
        {
            case "e": RunEval(json, root.GetProperty("src").GetString()!, bindings); break;
            case "s": RunSegment(json, root.GetProperty("text").GetString()!, bindings); break;
            case "r": RunRepeat(json, root.GetProperty("src").GetString()!, bindings); break;
            default: json.Append("{\"harnessError\":\"unknown case kind\"}"); break;
        }
    }
    catch (Exception error)
    {
        json.Clear();
        json.Append("{\"crash\":");
        Writer.String(json, error.GetType().Name + ": " + error.Message);
        json.Append('}');
    }
    output.WriteLine(json.ToString());
}

static Dictionary<string, object?> Bindings(JsonElement root)
{
    var bindings = new Dictionary<string, object?>(StringComparer.Ordinal);
    if (root.TryGetProperty("b", out var b) && b.ValueKind == JsonValueKind.Object)
    {
        foreach (var property in b.EnumerateObject()) bindings[property.Name] = property.Value.Clone();
    }
    return bindings;
}

static void RunEval(StringBuilder json, string source, Dictionary<string, object?> bindings)
{
    json.Append("{\"parse\":");
    if (ExpressionParser.TryParse(source, out var expression, out _))
    {
        json.Append("{\"kind\":");
        Writer.String(json, expression!.Kind == ExpressionKind.Name ? "name" : "expression");
        json.Append(",\"names\":[");
        for (var i = 0; i < expression.Names.Count; i++)
        {
            if (i > 0) json.Append(',');
            Writer.String(json, expression.Names[i]);
        }
        json.Append("],\"nodes\":").Append(expression.NodeCount.ToString(CultureInfo.InvariantCulture)).Append('}');
    }
    else
    {
        json.Append("null");
    }
    var value = Xeg.Evaluate(source, bindings);
    json.Append(",\"value\":");
    Writer.Value(json, value);
    json.Append(",\"render\":");
    Writer.String(json, ExprValue.Render(value));
    json.Append(",\"truthy\":").Append(Xeg.EvaluateCondition(source, bindings) ? "true" : "false").Append('}');
}

static void RunSegment(StringBuilder json, string text, Dictionary<string, object?> bindings)
{
    var result = Interpolation.SegmentText(text);
    json.Append("{\"segments\":");
    if (result.Segments is null)
    {
        json.Append("null");
    }
    else
    {
        json.Append('[');
        for (var i = 0; i < result.Segments.Count; i++)
        {
            if (i > 0) json.Append(',');
            json.Append('[');
            switch (result.Segments[i])
            {
                case TextSegment.Literal literal:
                    Writer.String(json, "literal");
                    json.Append(',');
                    Writer.String(json, literal.Value);
                    break;
                case TextSegment.Expr expr:
                    Writer.String(json, "expr");
                    json.Append(',');
                    Writer.String(json, expr.Source);
                    break;
            }
            json.Append(']');
        }
        json.Append(']');
    }
    json.Append(",\"issues\":").Append(result.Issues.Count.ToString(CultureInfo.InvariantCulture));
    json.Append(",\"resolved\":");
    if (result.Segments is null) json.Append("null");
    else Writer.String(json, Interpolation.ResolveSegments(result.Segments, bindings));
    json.Append('}');
}

static void RunRepeat(StringBuilder json, string source, Dictionary<string, object?> bindings)
{
    if (!Repeat.TryParseHeader(source, out var header, out _))
    {
        json.Append("{\"ok\":false}");
        return;
    }
    json.Append("{\"ok\":true,\"item\":");
    Writer.String(json, header!.Item);
    json.Append(",\"index\":");
    if (header.Index is null) json.Append("null");
    else Writer.String(json, header.Index);
    json.Append(",\"source\":");
    Writer.String(json, header.Source);
    json.Append(",\"items\":");
    Writer.Value(json, Repeat.Items(header, bindings));
    json.Append('}');
}

/// <summary>
/// A JSON writer that escapes every non-ASCII UTF-16 code unit, so a lone surrogate an
/// implementation produced survives to the comparison instead of failing to encode.
/// </summary>
static class Writer
{
    public static void String(StringBuilder json, string text)
    {
        json.Append('"');
        foreach (var c in text)
        {
            if (c == '"') json.Append("\\\"");
            else if (c == '\\') json.Append("\\\\");
            else if (c < 0x20 || c > 0x7E) json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else json.Append(c);
        }
        json.Append('"');
    }

    public static void Value(StringBuilder json, object? value)
    {
        switch (value)
        {
            case null: json.Append("null"); break;
            case bool b: json.Append(b ? "true" : "false"); break;
            case double d when double.IsFinite(d):
                json.Append(d.ToString("R", CultureInfo.InvariantCulture).Replace("E+", "e+").Replace("E-", "e-"));
                break;
            case double d:
                json.Append("{\"$nonfinite\":");
                String(json, d.ToString(CultureInfo.InvariantCulture));
                json.Append('}');
                break;
            case string s: String(json, s); break;
            case List<object?> items:
                json.Append('[');
                for (var i = 0; i < items.Count; i++)
                {
                    if (i > 0) json.Append(',');
                    Value(json, items[i]);
                }
                json.Append(']');
                break;
            case Dictionary<string, object?> map:
                json.Append('{');
                var first = true;
                foreach (var (key, item) in map)
                {
                    if (!first) json.Append(',');
                    first = false;
                    String(json, key);
                    json.Append(':');
                    Value(json, item);
                }
                json.Append('}');
                break;
            default:
                json.Append("{\"$foreign\":");
                String(json, value.GetType().FullName ?? "unknown");
                json.Append('}');
                break;
        }
    }
}
