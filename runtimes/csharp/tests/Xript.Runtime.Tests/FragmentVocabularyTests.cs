using System.Text.Json;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class FragmentVocabularyTests
{
    private const string HostWithFormats = """
        {
            "xript": "0.1",
            "name": "vocab-host",
            "slots": [
                { "id": "panel", "accepts": ["app/tui"] },
                { "id": "page", "accepts": ["text/html", "application/jsml+json"] },
                { "id": "mystery", "accepts": ["app/undeclared"] }
            ],
            "formats": {
                "app/tui": {
                    "syntax": "html",
                    "nodes": {
                        "Block": { "props": { "title": { "type": "string" }, "style": { "type": "object" } } },
                        "Gauge": {
                            "props": {
                                "percent": { "type": "number" },
                                "ratio": { "type": "string" },
                                "link": { "type": "string", "sink": "uri" }
                            },
                            "children": "none",
                            "bindTo": "ratio"
                        },
                        "Span": { "props": {}, "children": "text" }
                    }
                }
            }
        }
        """;

    private static string Mod(string slot, string format, string source) => $$"""
        {
            "xript": "0.1",
            "name": "vocab-mod",
            "version": "1.0.0",
            "fragments": [
                {
                    "id": "frag",
                    "slot": "{{slot}}",
                    "format": "{{format}}",
                    "inline": true,
                    "source": {{JsonSerializer.Serialize(source)}}
                }
            ]
        }
        """;

    // --- format dispatch ---

    [Fact]
    public void Unrecognized_Format_Is_A_Hard_Error()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        var ex = Assert.Throws<ModManifestValidationException>(
            () => rt.LoadMod(Mod("mystery", "app/undeclared", "<Block/>")));

        Assert.Contains("unknown fragment format 'app/undeclared'", ex.Message);
    }

    [Fact]
    public void Declared_Format_Produces_A_Tree_And_No_Html()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        var mod = rt.LoadMod(Mod("panel", "app/tui", """<Block title="Stats"><Span>hi</Span></Block>"""));
        var fragment = mod.Fragments[0];

        Assert.Equal(FragmentContentType.Tree, fragment.ContentType);
        var block = Assert.IsType<FragmentNode.Element>(Assert.Single(fragment.SanitizedTree));
        Assert.Equal("Block", block.Name);
        Assert.Equal("Stats", Assert.IsType<PropValue.Str>(block.Props.Get("title")).Value);

        var result = fragment.GetContent([]);
        Assert.Equal("", result.Html);
        Assert.Equal(FragmentContentType.Tree, result.ContentType);
        Assert.Single(result.Tree);
    }

    [Fact]
    public void Builtin_Format_Still_Produces_Html_And_Now_Also_A_Tree()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        var mod = rt.LoadMod(Mod("page", "text/html", """<div class="c"><span>hi</span></div>"""));
        var result = mod.Fragments[0].GetContent([]);

        Assert.Equal("""<div class="c"><span>hi</span></div>""", result.Html);
        Assert.Equal(FragmentContentType.Html, result.ContentType);
        Assert.Single(result.Tree);
    }

    [Fact]
    public void Jsml_Builtin_Format_Is_Parsed_As_Json_Not_Html()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        var mod = rt.LoadMod(Mod("page", "application/jsml+json", """["div",{"class":"c"},["span","hi"]]"""));
        var result = mod.Fragments[0].GetContent([]);

        Assert.Equal("""<div class="c"><span>hi</span></div>""", result.Html);
    }

    // --- default-deny ---

    [Fact]
    public void Undeclared_Node_Refuses_The_Fragment()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        var ex = Assert.Throws<FragmentSanitizeException>(
            () => rt.LoadMod(Mod("panel", "app/tui", "<Block><Bogus/></Block>")));

        var diagnostic = Assert.Single(ex.Diagnostics);
        Assert.Equal(DiagnosticCodes.UnknownNode, diagnostic.Code);
        Assert.Equal("Bogus", diagnostic.Node);
        Assert.Equal("/0/0", diagnostic.Path);
    }

    [Fact]
    public void Undeclared_Prop_Is_Dropped_With_A_Diagnostic()
    {
        var diagnostics = new List<FragmentDiagnosticEvent>();
        using var rt = XriptRuntime.Create(HostWithFormats, new RuntimeOptions
        {
            OnFragmentDiagnostic = diagnostics.Add,
        });

        var mod = rt.LoadMod(Mod("panel", "app/tui", """<Block title="ok" nope="1"/>"""));
        var block = Assert.IsType<FragmentNode.Element>(Assert.Single(mod.Fragments[0].SanitizedTree));

        Assert.False(block.Props.ContainsKey("nope"));
        var reported = Assert.Single(diagnostics);
        Assert.Equal("frag", reported.FragmentId);
        Assert.Equal(DiagnosticCodes.UnknownProp, reported.Diagnostic.Code);
        Assert.Equal("nope", reported.Diagnostic.Prop);
    }

    [Fact]
    public void Event_Handler_Props_Are_Refused_Even_When_Undeclared()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        var mod = rt.LoadMod(Mod("panel", "app/tui", """<Block onclick="steal()" title="t"/>"""));
        var block = Assert.IsType<FragmentNode.Element>(Assert.Single(mod.Fragments[0].SanitizedTree));

        Assert.False(block.Props.ContainsKey("onclick"));
        Assert.Equal(DiagnosticCodes.UnsafeProp, Assert.Single(mod.Fragments[0].Diagnostics).Code);
    }

    [Fact]
    public void Children_Constraint_Refuses_An_Illegal_Child()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        var ex = Assert.Throws<FragmentSanitizeException>(
            () => rt.LoadMod(Mod("panel", "app/tui", "<Gauge><Block/></Gauge>")));

        Assert.Equal(DiagnosticCodes.IllegalChild, Assert.Single(ex.Diagnostics).Code);
    }

    // --- typed values ---

    [Fact]
    public void A_Declared_Type_Mismatch_Drops_The_Prop_With_A_Diagnostic()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;

        // The HTML syntax carries every prop value as a string, so a prop declared
        // `object` cannot be satisfied from HTML source.
        var sanitized = FragmentSanitizer.Sanitize(
            """<Block style='{"fg":"Cyan"}' title="t"/>""", profile);

        var block = Assert.IsType<FragmentNode.Element>(Assert.Single(sanitized.Tree));
        Assert.False(block.Props.ContainsKey("style"));
        Assert.True(block.Props.ContainsKey("title"));

        var diagnostic = Assert.Single(sanitized.Diagnostics);
        Assert.Equal(DiagnosticCodes.InvalidProp, diagnostic.Code);
        Assert.Equal("prop \"style\" expects type \"object\"", diagnostic.Message);
    }

    [Fact]
    public void Jsml_Preserves_Object_Array_And_Number_Prop_Types()
    {
        var formats = ParseFormats("""
            {
                "app/json-tui": {
                    "syntax": "jsml",
                    "nodes": {
                        "Gauge": { "props": { "percent": { "type": "number" }, "style": { "type": "object" }, "pad": { "type": "array" } } }
                    }
                }
            }
            """);
        var profile = FormatProfiles.Resolve("app/json-tui", formats, null)!;

        var sanitized = FragmentSanitizer.Sanitize(
            """["Gauge",{"percent":62.5,"style":{"fg":"Cyan"},"pad":[1,2]}]""", profile);

        var gauge = Assert.IsType<FragmentNode.Element>(Assert.Single(sanitized.Tree));
        Assert.Equal(62.5, Assert.IsType<PropValue.Num>(gauge.Props.Get("percent")).Value);
        var style = Assert.IsType<PropValue.Obj>(gauge.Props.Get("style"));
        Assert.Equal("Cyan", Assert.IsType<PropValue.Str>(style.Entries.Get("fg")).Value);
        Assert.Equal(2, Assert.IsType<PropValue.Arr>(gauge.Props.Get("pad")).Items.Count);
    }

    [Fact]
    public void Node_And_Prop_Name_Case_Is_Preserved_For_Declared_Vocabularies()
    {
        var formats = ParseFormats("""
            {
                "app/case": {
                    "syntax": "html",
                    "nodes": { "MyWidget": { "props": { "ratio_bind": { "type": "string" } } } }
                }
            }
            """);
        var profile = FormatProfiles.Resolve("app/case", formats, null)!;

        var sanitized = FragmentSanitizer.Sanitize("""<MyWidget ratio_bind="hp"/>""", profile);
        var widget = Assert.IsType<FragmentNode.Element>(Assert.Single(sanitized.Tree));

        Assert.Equal("MyWidget", widget.Name);
        Assert.True(widget.Props.ContainsKey("ratio_bind"));
    }

    // --- sinks ---

    [Fact]
    public void Uri_Sink_Rejects_A_Javascript_Uri()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var sanitized = FragmentSanitizer.Sanitize("""<Gauge link="javascript:alert(1)"/>""", profile);

        var gauge = Assert.IsType<FragmentNode.Element>(Assert.Single(sanitized.Tree));
        Assert.False(gauge.Props.ContainsKey("link"));
        Assert.Equal(DiagnosticCodes.UnsafeProp, Assert.Single(sanitized.Diagnostics).Code);
    }

    [Fact]
    public void Text_Sink_Values_Are_Not_Sanitized_Because_They_Never_Become_Markup()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var sanitized = FragmentSanitizer.Sanitize("""<Block title="<script>alert(1)</script>"/>""", profile);

        var block = Assert.IsType<FragmentNode.Element>(Assert.Single(sanitized.Tree));
        Assert.Equal("<script>alert(1)</script>",
            Assert.IsType<PropValue.Str>(block.Props.Get("title")).Value);
    }

    [Fact]
    public void Html_Sink_Runs_The_Html_Sanitizer()
    {
        var formats = ParseFormats("""
            {
                "app/rich": {
                    "syntax": "jsml",
                    "nodes": { "Card": { "props": { "body": { "type": "string", "sink": "html" } } } }
                }
            }
            """);
        var profile = FormatProfiles.Resolve("app/rich", formats, null)!;

        var sanitized = FragmentSanitizer.Sanitize(
            """["Card",{"body":"<b>hi</b><script>alert(1)</script>"}]""", profile);

        var card = Assert.IsType<FragmentNode.Element>(Assert.Single(sanitized.Tree));
        Assert.Equal("<b>hi</b>", Assert.IsType<PropValue.Str>(card.Props.Get("body")).Value);
    }

    // --- strict mode ---

    [Fact]
    public void Strict_Html_Vocabulary_Promotes_An_Unknown_Tag_To_An_Error()
    {
        using var lenient = XriptRuntime.Create(HostWithFormats);
        Assert.NotNull(lenient.LoadMod(Mod("page", "text/html", "<div><mystery>x</mystery></div>")));

        using var strict = XriptRuntime.Create(HostWithFormats, new RuntimeOptions
        {
            StrictHtmlVocabulary = true,
        });
        Assert.Throws<FragmentSanitizeException>(
            () => strict.LoadMod(Mod("page", "text/html", "<div><mystery>x</mystery></div>")));
    }

    // --- binding through the vocabulary ---

    [Fact]
    public void Binding_Honors_BindTo_And_Routes_Through_The_Props_Sink()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var sanitized = FragmentSanitizer.Sanitize("""<Gauge data-bind="hp" percent="1"/>""", profile);

        var bound = FragmentBinder.Bind(
            sanitized.Tree,
            new Dictionary<string, object?> { ["hp"] = 0.75 },
            profile,
            _ => true);

        var gauge = Assert.IsType<FragmentNode.Element>(Assert.Single(bound.Tree));
        Assert.Equal("0.75", Assert.IsType<PropValue.Str>(gauge.Props.Get("ratio")).Value);
    }

    [Fact]
    public void DataIf_Records_Visibility_Without_Pruning_The_Node()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var sanitized = FragmentSanitizer.Sanitize("""<Block data-if="hp > 0" title="t"/>""", profile);

        var bound = FragmentBinder.Bind(sanitized.Tree, new Dictionary<string, object?>(), profile, _ => false);

        Assert.Single(bound.Tree);
        Assert.False(bound.Visibility["hp > 0"]);
    }

    // --- command buffer ---

    [Fact]
    public void Ops_Drop_Html_Sugar_For_A_Tree_Vocabulary()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("addClass", "#gauge", null, null, PropValue.Of("danger"))],
            profile, reported.Add);

        Assert.Empty(ops);
        Assert.Equal(DiagnosticCodes.UnsupportedOp, Assert.Single(reported).Code);
    }

    [Fact]
    public void Ops_Drop_A_Css_Selector_For_A_Tree_Vocabulary()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("setText", ".gauge", null, null, PropValue.Of("x"))],
            profile, reported.Add);

        Assert.Empty(ops);
        Assert.Equal(DiagnosticCodes.UnsupportedTarget, Assert.Single(reported).Code);
    }

    [Fact]
    public void Ops_Route_SetProp_Through_The_Declared_Sink()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
        [
            new RawFragmentOp("setProp", "#gauge", "link", null, PropValue.Of("javascript:alert(1)")),
            new RawFragmentOp("setProp", "#gauge", "link", null, PropValue.Of("https://ok.example")),
        ], profile, reported.Add);

        var kept = Assert.Single(ops);
        Assert.Equal("https://ok.example", Assert.IsType<PropValue.Str>(kept.Value).Value);
        Assert.Equal(DiagnosticCodes.UnsafeProp, Assert.Single(reported).Code);
    }

    [Fact]
    public void Ops_Reject_A_Prop_No_Node_Declares()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("setProp", "#gauge", "mystery", null, PropValue.Of("x"))],
            profile, reported.Add);

        Assert.Empty(ops);
        Assert.Equal(DiagnosticCodes.OpUnknownProp, Assert.Single(reported).Code);
    }

    [Fact]
    public void Ops_Reject_A_Prop_Declared_With_Conflicting_Sinks()
    {
        var formats = ParseFormats("""
            {
                "app/conflict": {
                    "syntax": "jsml",
                    "nodes": {
                        "A": { "props": { "v": { "type": "string", "sink": "uri" } } },
                        "B": { "props": { "v": { "type": "string", "sink": "css" } } }
                    }
                }
            }
            """);
        var profile = FormatProfiles.Resolve("app/conflict", formats, null)!;
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("setProp", "#a", "v", null, PropValue.Of("x"))],
            profile, reported.Add);

        Assert.Empty(ops);
        var diagnostic = Assert.Single(reported);
        Assert.Equal(DiagnosticCodes.PropSinkConflict, diagnostic.Code);
        Assert.Contains("css, uri", diagnostic.Message);
    }

    [Fact]
    public void Ops_On_A_Builtin_Profile_Route_Through_The_Html_Sink()
    {
        var profile = FormatProfiles.Builtins["text/html"];
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
        [
            new RawFragmentOp("setAttr", ".x", null, "href", PropValue.Of("javascript:alert(1)")),
            new RawFragmentOp("setAttr", ".x", null, "onclick", PropValue.Of("steal()")),
            new RawFragmentOp("setAttr", ".x", null, "href", PropValue.Of("/ok")),
        ], profile, reported.Add);

        var kept = Assert.Single(ops);
        Assert.Equal("/ok", Assert.IsType<PropValue.Str>(kept.Value).Value);
        Assert.Equal("href", kept.Prop);
        Assert.Equal("href", kept.Attr);
        Assert.Equal(2, reported.Count);
    }

    [Fact]
    public void ReplaceChildren_Sanitizes_Markup_Before_It_Reaches_The_Host()
    {
        var profile = FormatProfiles.Builtins["text/html"];

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("replaceChildren", ".x", null, null,
                PropValue.Of("<b>ok</b><script>alert(1)</script>"))],
            profile);

        Assert.Equal("<b>ok</b>", Assert.IsType<PropValue.Str>(Assert.Single(ops).Value).Value);
    }

    [Fact]
    public void ReplaceChildren_Sanitizes_A_Jsml_Payload_Against_The_Vocabulary()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("replaceChildren", "#panel", null, null, new PropValue.Arr(
            [
                new PropValue.Arr([PropValue.Of("Span"), PropValue.Of("kept")]),
                new PropValue.Arr([PropValue.Of("Bogus"), PropValue.Of("dropped")]),
            ]))],
            profile);

        var value = Assert.IsType<PropValue.Arr>(Assert.Single(ops).Value);
        var kept = Assert.IsType<PropValue.Arr>(Assert.Single(value.Items));
        Assert.Equal("Span", Assert.IsType<PropValue.Str>(kept.Items[0]).Value);
    }

    [Fact]
    public void Node_Refs_Parse_Ids_And_Selectors()
    {
        Assert.Equal("gauge", Assert.IsType<NodeRef.Id>(NodeRef.Parse("#gauge")).Value);
        Assert.Equal(".gauge", Assert.IsType<NodeRef.Selector>(NodeRef.Parse(".gauge")).Value);
    }

    // --- security ---

    [Theory]
    [InlineData("""<a href="javascript:alert(1)">x</a>""", "<a>x</a>")]
    [InlineData("""<a href="data:text/html,<script>alert(1)</script>">x</a>""", "<a>x</a>")]
    [InlineData("""<img src="data:text/html,<script>alert(1)</script>">""", "<img />")]
    [InlineData("""<img src="data:image/png;base64,AAA">""", """<img src="data:image/png;base64,AAA" />""")]
    [InlineData("""<div onclick="steal()" onmouseover="x()">t</div>""", "<div>t</div>")]
    [InlineData("""<div formaction="javascript:alert(1)">t</div>""", "<div>t</div>")]
    // the `url(...)` strip stops at the first paren, so a nested call leaves an inert
    // `background:)` residue rather than an empty value -- no URL survives either way
    [InlineData("""<div style="background:url(javascript:alert(1))">t</div>""", """<div style="background:)">t</div>""")]
    [InlineData("""<div style="url(javascript:alert)">t</div>""", "<div>t</div>")]
    [InlineData("<svg><foreignObject><script>alert(1)</script></foreignObject></svg>", "<svg></svg>")]
    public void Builtin_Html_Vocabulary_Closes_Known_Injection_Vectors(string input, string expected)
    {
        Assert.Equal(expected, FragmentProcessor.SanitizeHtml(input));

        var sanitized = FragmentSanitizer.Sanitize(input, FormatProfiles.Builtins["text/html"]);
        Assert.Equal(expected, sanitized.Html);
        Assert.Equal(expected, FragmentTree.ToHtml(sanitized.Tree));
    }

    [Fact]
    public void Prototype_Polluting_Prop_Names_Are_Refused_In_Every_Vocabulary()
    {
        var profile = FormatProfiles.Resolve("app/tui", Formats(), null)!;
        var declared = FragmentSanitizer.Sanitize("""<Block __proto__="x" title="t"/>""", profile);
        var block = Assert.IsType<FragmentNode.Element>(Assert.Single(declared.Tree));
        Assert.False(block.Props.ContainsKey("__proto__"));

        var builtin = FragmentSanitizer.Sanitize(
            """["div",{"__proto__":"x","constructor":"y"}]""",
            FormatProfiles.Builtins["application/jsml+json"]);
        Assert.Equal("<div></div>", builtin.Html);
    }

    [Fact]
    public void A_Prop_Name_Carrying_An_Attribute_Delimiter_Never_Reaches_Markup()
    {
        var sanitized = FragmentSanitizer.Sanitize(
            """["div",{"x\" onload=\"alert(1)":"y"}]""",
            FormatProfiles.Builtins["application/jsml+json"]);

        Assert.Equal("<div></div>", sanitized.Html);
        Assert.DoesNotContain("onload", sanitized.Html);
    }

    // --- profile resolution ---

    [Fact]
    public void Builtin_Format_Ids_Always_Win_Over_A_Host_Declaration()
    {
        var formats = ParseFormats("""
            { "text/html": { "syntax": "jsml", "nodes": { "X": {} } } }
            """);

        var profile = FormatProfiles.Resolve("text/html", formats, null)!;

        Assert.True(profile.Builtin);
        Assert.Equal(FragmentSyntax.Html, profile.Syntax);
        Assert.Equal([new ResolvedVocabulary.BuiltinHtml()], profile.Scope);
    }

    [Fact]
    public void A_Malformed_Format_Declaration_Is_Rejected()
    {
        var formats = ParseFormats("""{ "app/bad": { "syntax": "xml", "nodes": {} } }""");

        var ex = Assert.Throws<FormatProfileException>(() => FormatProfiles.Resolve("app/bad", formats, null));
        Assert.Contains("unknown syntax", ex.Message);
    }

    [Fact]
    public void Reserved_Format_Ids_Cover_Builtins_And_Non_Fragment_Slots()
    {
        Assert.Contains("text/html", FormatProfiles.ReservedFormatIds);
        Assert.Contains("application/x-xript-role", FormatProfiles.ReservedFormatIds);
        Assert.Contains("application/x-xript-hook", FormatProfiles.ReservedFormatIds);
    }

    [Fact]
    public void Manifest_Deserializes_The_Formats_Block()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);

        Assert.NotNull(rt.Manifest.Formats);
        Assert.True(rt.Manifest.Formats!.ContainsKey("app/tui"));
    }

    [Fact]
    public void Slot_Contributions_Report_Their_Content_Type()
    {
        using var rt = XriptRuntime.Create(HostWithFormats);
        rt.LoadMod(Mod("panel", "app/tui", "<Block/>"));

        Assert.Equal(FragmentContentType.Tree, rt.ResolveSlotSingle("panel")!.ContentType);
    }

    private static IReadOnlyDictionary<string, JsonElement> Formats() =>
        JsonSerializer.Deserialize<Manifest>(HostWithFormats)!.Formats!;

    private static IReadOnlyDictionary<string, JsonElement> ParseFormats(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;
}
