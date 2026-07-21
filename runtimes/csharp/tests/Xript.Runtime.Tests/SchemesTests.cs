using System.Text.Json;

namespace Xript.Runtime.Tests;

/// <summary>
/// The URI scheme allow-list: what a format's <c>schemes</c> admits, what it can never admit,
/// and the shapes it must leave alone. Mirrors the JavaScript suite case for case, since the
/// four runtimes have to agree on which URIs survive a fragment.
/// </summary>
public class SchemesTests : IDisposable
{
    private const string FormatId = "application/x-schemed+json";

    private readonly string _dir;

    public SchemesTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "xript-schemes-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    private const char Tab = '\t';
    private const char Lf = '\n';
    private const char Cr = '\r';

    private static IReadOnlyDictionary<string, JsonElement> Formats(string? schemes)
    {
        var declared = schemes is null ? "" : $"\"schemes\": {schemes},";
        return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>($$"""
            {
                "{{FormatId}}": {
                    "syntax": "j5ml",
                    {{declared}}
                    "nodes": {
                        "Link": {
                            "props": { "href": { "type": "string", "sink": "uri" } },
                            "children": "none"
                        },
                        "Avatar": {
                            "props": { "src": { "type": "string", "sink": "image-uri" } },
                            "children": "none"
                        }
                    }
                }
            }
            """)!;
    }

    private static FormatProfile ProfileFor(string? schemes) =>
        FormatProfiles.Resolve(FormatId, Formats(schemes), null)!;

    private static string? PropAfterSanitize(string? schemes, string node, string prop, string value)
    {
        var source = JsonSerializer.Serialize(new object[]
        {
            node,
            new Dictionary<string, string> { [prop] = value },
        });
        var result = FragmentSanitizer.Sanitize(source, ProfileFor(schemes));
        var element = (FragmentNode.Element)result.Tree[0];
        return element.Props.Get(prop) is PropValue.Str str ? str.Value : null;
    }

    private static string? LinkHref(string? schemes, string href) =>
        PropAfterSanitize(schemes, "Link", "href", href);

    private static string? AvatarSrc(string? schemes, string src) =>
        PropAfterSanitize(schemes, "Avatar", "src", src);

    [Fact]
    public void Defaults_To_Http_Https_Mailto_And_Data()
    {
        Assert.Equal(["http", "https", "mailto", "data"], HtmlRules.DefaultUriSchemes);
        Assert.Equal(
            ["data", "http", "https", "mailto"],
            ProfileFor(null).Schemes.OrderBy(name => name, StringComparer.Ordinal));
    }

    [Fact]
    public void Carries_A_Declared_Set_Onto_The_Profile_Lowercased()
    {
        Assert.Equal(
            ["https", "tauri"],
            ProfileFor("""["HTTPS", "tauri"]""").Schemes.OrderBy(name => name, StringComparer.Ordinal));
    }

    [Fact]
    public void Replaces_The_Default_Rather_Than_Extending_It()
    {
        Assert.Equal("tauri://localhost/api", LinkHref("""["tauri"]""", "tauri://localhost/api"));
        Assert.Null(LinkHref("""["tauri"]""", "https://example.com"));
    }

    [Fact]
    public void Narrows_To_A_Single_Scheme_When_Asked()
    {
        Assert.Equal("https://example.com", LinkHref("""["https"]""", "https://example.com"));
        Assert.Null(LinkHref("""["https"]""", "http://example.com"));
    }

    [Fact]
    public void Reads_An_Empty_List_As_Deliberate_Closure()
    {
        Assert.Empty(ProfileFor("[]").Schemes);
        Assert.Null(LinkHref("[]", "https://example.com"));
        Assert.Null(LinkHref("[]", "mailto:someone@example.com"));
    }

    [Fact]
    public void Matches_A_Declared_Scheme_Case_Insensitively()
    {
        Assert.Equal("TAURI://localhost/api", LinkHref("""["tauri"]""", "TAURI://localhost/api"));
    }

    [Theory]
    [InlineData("file:///etc/passwd")]
    [InlineData("blob:https://example.com/uuid")]
    [InlineData("filesystem:https://example.com/temporary/a")]
    [InlineData("view-source:https://example.com")]
    [InlineData("chrome://settings")]
    [InlineData("tauri://localhost/api")]
    [InlineData("jar:http://example.com/a.jar!/b")]
    [InlineData("about:blank")]
    public void Refuses_The_Schemes_The_Default_Set_Never_Admitted(string href)
    {
        Assert.Null(LinkHref(null, href));
    }

    [Theory]
    [InlineData("javascript")]
    [InlineData("VBScript")]
    public void Refuses_A_Prohibited_Scheme_At_Declaration_Time(string declared)
    {
        var ex = Assert.Throws<FormatProfileException>(
            () => FormatProfiles.Resolve(FormatId, Formats($"[\"{declared}\"]"), null));

        Assert.Equal(FormatProfileErrorCode.ProhibitedScheme, ex.Code);
    }

    [Fact]
    public void Refuses_Javascript_And_Vbscript_Whatever_The_Set_Says()
    {
        Assert.Null(HtmlRules.SanitizeUri(
            "javascript:alert(1)", "href", new HashSet<string>(["javascript"], StringComparer.Ordinal)));
        Assert.Null(HtmlRules.SanitizeUri(
            "vbscript:MsgBox(1)", "href", new HashSet<string>(["vbscript"], StringComparer.Ordinal)));
    }

    [Theory]
    [InlineData("\"https\"")]
    [InlineData("[7]")]
    [InlineData("[\"https:\"]")]
    [InlineData("[\"ht tp\"]")]
    [InlineData("[\"\"]")]
    public void Refuses_A_Malformed_Scheme_List(string schemes)
    {
        var ex = Assert.Throws<FormatProfileException>(
            () => FormatProfiles.Resolve(FormatId, Formats(schemes), null));

        Assert.Equal(FormatProfileErrorCode.InvalidSchemes, ex.Code);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    [InlineData("""["https"]""")]
    [InlineData("""["tauri"]""")]
    public void Leaves_Every_Relative_Shape_Alone_Whatever_The_Set_Says(string? schemes)
    {
        foreach (var href in new[]
                 {
                     "about.html", "/abs/path", "//cdn.example.com/a.css", "#anchor", "?q=1",
                 })
        {
            Assert.Equal(href, LinkHref(schemes, href));
        }

        Assert.Equal("nested/dir/icon.png", AvatarSrc(schemes, "nested/dir/icon.png"));
    }

    /// <summary>
    /// The scheme has to be read from the same normalized value the refusal has always been
    /// read from. Reading it from anything less normalized would put the allow-list behind the
    /// exact reassembly trick the normalization exists to defeat.
    /// </summary>
    [Fact]
    public void Reads_The_Scheme_From_The_Normalized_Value()
    {
        Assert.Null(LinkHref("""["https"]""", $"fi{Tab}le:///etc/passwd"));
        Assert.Null(LinkHref("""["https"]""", $"ta{Lf}uri://localhost/api"));
        Assert.Null(LinkHref("[]", $"ht{Cr}tps://example.com"));
        Assert.Null(LinkHref("""["https"]""", $"java{Tab}script:alert(1)"));
        Assert.Null(LinkHref("""["https"]""", "file:///etc/passwd"));
    }

    [Fact]
    public void Gates_Data_By_Subtype_And_Sink_Exactly_As_Before()
    {
        Assert.Equal(
            "data:image/png;base64,abc", AvatarSrc("""["data"]""", "data:image/png;base64,abc"));
        Assert.Null(AvatarSrc("""["data"]""", "data:text/html,<script>x</script>"));
        Assert.Null(LinkHref("""["data"]""", "data:image/png;base64,abc"));
    }

    [Fact]
    public void Refuses_Data_Outright_When_The_List_Omits_It()
    {
        Assert.Null(AvatarSrc("""["https"]""", "data:image/png;base64,abc"));
        Assert.Null(AvatarSrc("[]", "data:image/png;base64,abc"));
    }

    [Fact]
    public void Defaults_SanitizeUri_To_The_Safe_Set_When_No_Set_Is_Passed()
    {
        Assert.Equal("https://example.com", HtmlRules.SanitizeUri("https://example.com", "href"));
        Assert.Null(HtmlRules.SanitizeUri("file:///etc/passwd", "href"));
        Assert.Equal("./relative", HtmlRules.SanitizeUri("./relative", "href"));
    }

    /// <summary>
    /// <c>schemes</c> follows <c>vocabularies</c> through an <c>extends</c> chain: absent
    /// inherits, present replaces wholesale, and <c>[]</c> is closure. A union would make
    /// narrowing impossible.
    /// </summary>
    [Fact]
    public void An_Absent_Child_Schemes_Inherits_The_Base_Set()
    {
        var resolved = ResolveExtends("""["tauri"]""", null);
        Assert.Equal(["tauri"], SchemesOf(resolved));
    }

    [Fact]
    public void A_Present_Child_Schemes_Replaces_The_Base_Set_Wholesale()
    {
        var resolved = ResolveExtends("""["tauri", "https"]""", """["https"]""");
        Assert.Equal(["https"], SchemesOf(resolved));
    }

    [Fact]
    public void An_Empty_Child_Schemes_Closes_The_Base_Set()
    {
        var resolved = ResolveExtends("""["tauri", "https"]""", "[]");
        Assert.Empty(SchemesOf(resolved));
    }

    /// <summary>
    /// The built-in HTML <c>href</c>/<c>src</c> path reads the same set the declared-node
    /// sinks do. A format that widens its schemes and also speaks HTML would otherwise keep
    /// enforcing the default set on every plain anchor it carries.
    /// </summary>
    [Theory]
    [InlineData("""["tauri"]""", "tauri://localhost/api", "<a href=\"tauri://localhost/api\">x</a>")]
    [InlineData("""["tauri"]""", "https://example.com", "<a>x</a>")]
    [InlineData("[]", "https://example.com", "<a>x</a>")]
    [InlineData("""["https"]""", "https://example.com", "<a href=\"https://example.com\">x</a>")]
    public void The_Builtin_Html_Attribute_Sink_Reads_The_Formats_Set(
        string schemes, string href, string expected)
    {
        var formats = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>($$"""
            {
                "text/schemed": {
                    "syntax": "html",
                    "schemes": {{schemes}},
                    "vocabularies": ["html"]
                }
            }
            """)!;

        var profile = FormatProfiles.Resolve("text/schemed", formats, null)!;
        var sanitized = FragmentSanitizer.Sanitize($"<a href=\"{href}\">x</a>", profile);

        Assert.Equal(expected, FragmentTree.ToHtml(sanitized.Tree));
    }

    private static IEnumerable<string> SchemesOf(FormatProfile profile) =>
        profile.Schemes.OrderBy(name => name, StringComparer.Ordinal);

    private FormatProfile ResolveExtends(string baseSchemes, string? childSchemes)
    {
        File.WriteAllText(Path.Combine(_dir, "base.json"), $$"""
            {
                "xript": "0.1",
                "name": "base-host",
                "formats": {
                    "{{FormatId}}": {
                        "syntax": "j5ml",
                        "schemes": {{baseSchemes}},
                        "nodes": { "Link": { "props": { "href": { "sink": "uri" } } } }
                    }
                }
            }
            """);

        var childFormat = childSchemes is null
            ? ""
            : $$"""
                ,
                "formats": {
                    "{{FormatId}}": { "refines": true, "schemes": {{childSchemes}} }
                }
                """;

        var resolved = ManifestResolver.Resolve($$"""
            {
                "xript": "0.1",
                "name": "child-host",
                "extends": "./base.json"{{childFormat}}
            }
            """, _dir);

        var formats = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(
            JsonDocument.Parse(resolved).RootElement.GetProperty("formats").GetRawText())!;

        return FormatProfiles.Resolve(FormatId, formats, null)!;
    }
}
