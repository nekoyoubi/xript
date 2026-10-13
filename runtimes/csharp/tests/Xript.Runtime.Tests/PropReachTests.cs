using System.Text.Json;

namespace Xript.Runtime.Tests;

/// <summary>
/// Which props a bound value can reach, and how structured props project to HTML.
/// </summary>
public class PropReachTests
{
    private const string TreeFormat = "application/x-probe+json";
    private const string HtmlFormat = "application/x-probe-html+json";

    private const string FormatsJson = """
        {
          "application/x-probe+json": {
            "syntax": "j5ml",
            "nodes": {
              "Gauge": { "props": { "max": { "type": "number" } }, "children": "none" },
              "Meter": { "props": { "level": { "type": "string" } }, "children": "none", "bindTo": "level" },
              "Anchor": { "props": { "href": { "type": "string", "sink": "uri" } }, "children": "none", "bindTo": "href" }
            }
          },
          "application/x-probe-html+json": { "syntax": "j5ml", "vocabularies": ["probe.charts", "html"] }
        }
        """;

    private const string VocabulariesJson = """
        {
          "probe.charts": {
            "nodes": {
              "x-chart": { "props": { "series": { "type": "array" }, "config": { "type": "object" } } }
            }
          }
        }
        """;

    private static Dictionary<string, JsonElement> Block(string json) =>
        JsonDocument.Parse(json).RootElement.EnumerateObject()
            .ToDictionary(property => property.Name, property => property.Value.Clone());

    private static FragmentResult Content(string format, string source, object? value = null)
    {
        var declaration = new FragmentDeclaration
        {
            Id = "probe",
            Slot = "s",
            Format = format,
            Source = source,
            Inline = true,
            Bindings = [new FragmentBinding { Name = "v", Path = "v" }],
        };
        var instance = FragmentInstance.Create(
            declaration, source, Block(FormatsJson), Block(VocabulariesJson), false, null);
        return instance.GetContent(new Dictionary<string, object?> { ["v"] = value });
    }

    [Fact]
    public void A_Bind_Into_An_Undeclared_Prop_Is_Reported()
    {
        var result = Content(TreeFormat, """["Gauge",{"data-bind":"v","max":10}]""", 7.0);
        var gauge = Assert.IsType<FragmentNode.Element>(result.Tree[0]);
        Assert.Null(gauge.Props.Get("value"));
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal(DiagnosticCodes.UnknownProp, diagnostic.Code);
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity);
        Assert.Equal("/0", diagnostic.Path);
        Assert.Equal("Gauge", diagnostic.Node);
        Assert.Equal("value", diagnostic.Prop);
        Assert.Equal(
            "data-bind target \"value\" is not declared on node \"Gauge\"; the bound value was dropped",
            diagnostic.Message);
    }

    [Fact]
    public void A_Bind_Into_A_Declared_Target_Is_Silent()
    {
        var result = Content(TreeFormat, """["Meter",{"data-bind":"v"}]""", "high");
        var meter = Assert.IsType<FragmentNode.Element>(result.Tree[0]);
        Assert.Equal(PropValue.Of("high"), meter.Props.Get("level"));
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void A_Bind_Its_Sink_Rejects_Is_Reported()
    {
        var result = Content(TreeFormat, """["Anchor",{"data-bind":"v"}]""", "javascript:alert(1)");
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal(DiagnosticCodes.UnsafeProp, diagnostic.Code);
        Assert.Equal("href", diagnostic.Prop);
    }

    [Fact]
    public void Sanitizer_Diagnostics_Precede_Bind_Diagnostics()
    {
        var result = Content(TreeFormat, """["Gauge",{"data-bind":"v","bogus":1}]""", 1.0);
        Assert.Equal(["bogus", "value"], result.Diagnostics.Select(d => d.Prop).ToArray());
    }

    [Fact]
    public void GetContent_Projects_Html_For_Custom_Element_Formats()
    {
        var result = Content(HtmlFormat, """["x-chart",{"series":[1,2],"config":{"b":1,"a":2},"data-tags":["x","y"]}]""");
        Assert.Equal(FragmentContentType.Tree, result.ContentType);
        Assert.Equal(
            "<x-chart series=\"[1,2]\" config=\"{&quot;a&quot;:2,&quot;b&quot;:1}\" data-tags=\"x,y\"></x-chart>",
            result.Html);
    }

    [Fact]
    public void GetContent_Html_Stays_Empty_Without_A_Projection()
    {
        Assert.Equal("", Content(TreeFormat, """["Gauge",{"max":3}]""").Html);
    }

    [Theory]
    [InlineData(0.0, "0")]
    [InlineData(-5.0, "-5")]
    [InlineData(0.1, "0.1")]
    [InlineData(123.456, "123.456")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(0.0000001, "1e-7")]
    [InlineData(1.5e-7, "1.5e-7")]
    [InlineData(-2.5e-10, "-2.5e-10")]
    [InlineData(1e15, "1000000000000000")]
    [InlineData(1e16, "10000000000000000")]
    [InlineData(123456789012345680000.0, "123456789012345680000")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1.2345e22, "1.2345e+22")]
    public void Numbers_Render_As_JavaScript_Does(double value, string expected)
    {
        Assert.Equal(expected, PropValue.NumberToString(value));
    }

    [Fact]
    public void Structured_Values_Encode_Canonically()
    {
        var map = new PropMap();
        map.Set("\U0001F600", PropValue.Of(1));
        var privateUse = ((char)0xE000).ToString();
        var lineSeparator = ((char)0x2028).ToString();
        var loneSurrogate = ((char)0xD800).ToString();
        map.Set(privateUse, PropValue.Of(2));
        map.Set("s", PropValue.Of("q\"\\\b\f\n\r\t\u0001" + lineSeparator + "/<" + loneSurrogate));
        Assert.Equal(
            "{\"s\":\"q\\\"\\\\\\b\\f\\n\\r\\t\\u0001" + lineSeparator + "/<\\ud800\",\""
                + privateUse + "\":2,\"\U0001F600\":1}",
            PropValue.CanonicalJson(new PropValue.Obj(map)));

        var inner = new PropMap();
        inner.Set("a", PropValue.Of(1));
        var obj = new PropValue.Obj(inner);
        Assert.Equal("{\"a\":1}", PropValue.AttributeValue(obj));
        Assert.Equal("[[1,{\"a\":1}]]",
            PropValue.AttributeValue(new PropValue.Arr([new PropValue.Arr([PropValue.Of(1), obj])])));
        var scalars = new PropValue.Arr([PropValue.Of(1), PropValue.Null, PropValue.Of("x")]);
        Assert.Equal("1,,x", PropValue.AttributeValue(scalars));
        Assert.Equal("[1,null,\"x\"]", PropValue.AttributeValue(scalars, ["array"]));
    }
}
