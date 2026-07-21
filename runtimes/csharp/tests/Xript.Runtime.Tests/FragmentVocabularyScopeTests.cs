using System.Text.Json;

namespace Xript.Runtime.Tests;

/// <summary>
/// The vocabularies surface beyond the shared corpus: how a scope is threaded from the host
/// manifest, how op-level prop routing unions across it, and the refusal codes a reporting
/// caller reads instead of the message text.
/// </summary>
public class FragmentVocabularyScopeTests
{
    private const string HostWithVocabularies = """
        {
            "xript": "0.1",
            "name": "vocab-scope-host",
            "slots": [
                { "id": "panel", "accepts": ["app/widgets"] }
            ],
            "vocabularies": {
                "app.widgets": {
                    "description": "The shared widget set.",
                    "nodes": {
                        "Panel": { "props": { "heading": { "type": "string" } } }
                    }
                }
            },
            "formats": {
                "app/widgets": {
                    "syntax": "j5ml",
                    "vocabularies": ["app.widgets"]
                }
            }
        }
        """;

    [Fact]
    public void A_Named_Vocabulary_Reaches_A_Fragment_Through_The_Host_Manifest()
    {
        using var rt = XriptRuntime.Create(HostWithVocabularies);

        var mod = rt.LoadMod("""
            {
                "xript": "0.1",
                "name": "widget-mod",
                "version": "1.0.0",
                "fragments": [
                    {
                        "id": "frag",
                        "slot": "panel",
                        "format": "app/widgets",
                        "inline": true,
                        "source": "[\"Panel\",{\"heading\":\"Stats\"}]"
                    }
                ]
            }
            """);

        var panel = Assert.IsType<FragmentNode.Element>(Assert.Single(mod.Fragments[0].SanitizedTree));
        Assert.Equal("Panel", panel.Name);
        Assert.Equal("Stats", Assert.IsType<PropValue.Str>(panel.Props.Get("heading")).Value);
    }

    [Fact]
    public void Manifest_Deserializes_The_Vocabularies_Block()
    {
        var manifest = JsonSerializer.Deserialize<Manifest>(HostWithVocabularies)!;

        Assert.NotNull(manifest.Vocabularies);
        Assert.True(manifest.Vocabularies!.ContainsKey("app.widgets"));
    }

    [Fact]
    public void Scope_Node_Order_Follows_Scope_Then_Declaration_Order()
    {
        var profile = Resolve("app/two", """
            {
                "app/two": {
                    "syntax": "j5ml",
                    "vocabularies": ["a.one", "a.two"],
                    "nodes": { "Inline": {} }
                }
            }
            """, """
            {
                "a.one": { "nodes": { "Alpha": {}, "Beta": {} } },
                "a.two": { "nodes": { "Gamma": {} } }
            }
            """);

        Assert.Equal(
            [(0, "Inline"), (1, "Alpha"), (1, "Beta"), (2, "Gamma")],
            profile.ScopeNodeOrder);
    }

    [Fact]
    public void Ops_Refuse_A_Prop_Two_Vocabularies_Declare_With_Conflicting_Sinks()
    {
        var profile = Resolve("app/conflict", """
            {
                "app/conflict": { "syntax": "j5ml", "vocabularies": ["a.one", "a.two"] }
            }
            """, """
            {
                "a.one": { "nodes": { "Alpha": { "props": { "v": { "type": "string", "sink": "uri" } } } } },
                "a.two": { "nodes": { "Beta": { "props": { "v": { "type": "string", "sink": "css" } } } } }
            }
            """);
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("setProp", "#a", "v", null, PropValue.Of("x"))], profile, reported.Add);

        Assert.Empty(ops);
        var diagnostic = Assert.Single(reported);
        Assert.Equal(DiagnosticCodes.PropSinkConflict, diagnostic.Code);
        Assert.Equal(
            "prop \"v\" is declared with conflicting sinks (css, uri) in format \"app/conflict\"",
            diagnostic.Message);
    }

    [Fact]
    public void Ops_Route_A_Prop_Only_The_Second_Vocabulary_Declares_Through_That_Declaration()
    {
        var profile = Resolve("app/late", """
            {
                "app/late": { "syntax": "j5ml", "vocabularies": ["a.one", "a.two", "html"] }
            }
            """, """
            {
                "a.one": { "nodes": { "Alpha": { "props": { "other": { "type": "string" } } } } },
                "a.two": { "nodes": { "Beta": { "props": { "href": { "type": "string" } } } } }
            }
            """);
        var reported = new List<FragmentDiagnostic>();

        var ops = FragmentOps.Finalize(
            [new RawFragmentOp("setProp", "#b", "href", null, PropValue.Of("javascript:alert(1)"))],
            profile, reported.Add);

        Assert.Empty(reported);
        Assert.Equal("javascript:alert(1)", Assert.IsType<PropValue.Str>(Assert.Single(ops).Value).Value);
    }

    [Theory]
    [InlineData(
        """{ "app/x": { "syntax": "j5ml", "vocabularies": ["nope.missing"] } }""",
        FormatProfileErrorCode.UnknownVocabulary)]
    [InlineData(
        """{ "app/x": { "syntax": "j5ml", "vocabularies": ["foo"] } }""",
        FormatProfileErrorCode.UnknownVocabulary)]
    [InlineData(
        """{ "app/x": { "syntax": "j5ml", "vocabularies": ["html", "a.one"] } }""",
        FormatProfileErrorCode.HtmlNotLast)]
    [InlineData(
        """{ "app/x": { "syntax": "j5ml", "vocabularies": [] } }""",
        FormatProfileErrorCode.EmptyScope)]
    [InlineData(
        """{ "app/x": { "syntax": "j5ml", "vocabularies": ["a.danger", "html"] } }""",
        FormatProfileErrorCode.StrippedNameShadowed)]
    [InlineData(
        """{ "app/x": { "syntax": "xml", "nodes": { "A": {} } } }""",
        FormatProfileErrorCode.UnknownSyntax)]
    public void A_Refused_Scope_Carries_The_Code_A_Reporting_Caller_Reads(
        string formats, FormatProfileErrorCode expected)
    {
        var vocabularies = """
            {
                "a.one": { "nodes": { "Alpha": {} } },
                "a.danger": { "nodes": { "script": {} } }
            }
            """;

        var ex = Assert.Throws<FormatProfileException>(
            () => FormatProfiles.Resolve("app/x", Parse(formats), Parse(vocabularies)));

        Assert.Equal(expected, ex.Code);
    }

    private static FormatProfile Resolve(string format, string formats, string vocabularies) =>
        FormatProfiles.Resolve(format, Parse(formats), Parse(vocabularies))!;

    private static IReadOnlyDictionary<string, JsonElement> Parse(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;
}
