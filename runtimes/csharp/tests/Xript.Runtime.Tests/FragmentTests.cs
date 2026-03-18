using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class FragmentTests
{
    [Fact]
    public void ValidateModManifest_Parses_Valid_Manifest()
    {
        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "health-panel",
                "version": "1.0.0",
                "title": "Health Panel",
                "description": "Shows player health",
                "author": "testauthor",
                "capabilities": ["ui-mount"],
                "fragments": [
                    {
                        "id": "hp-bar",
                        "slot": "sidebar.left",
                        "format": "text/html",
                        "source": "<div data-bind=\"health\">0</div>",
                        "inline": true,
                        "priority": 10,
                        "bindings": [
                            { "name": "health", "path": "player.health" }
                        ],
                        "events": [
                            { "selector": "[data-action='heal']", "on": "click", "handler": "onHeal" }
                        ]
                    }
                ]
            }
            """);

        Assert.Equal("0.3", mod.Xript);
        Assert.Equal("health-panel", mod.Name);
        Assert.Equal("1.0.0", mod.Version);
        Assert.Equal("Health Panel", mod.Title);
        Assert.Equal("Shows player health", mod.Description);
        Assert.Equal("testauthor", mod.Author);
        Assert.Single(mod.Capabilities!);
        Assert.Single(mod.Fragments!);
        Assert.Equal("hp-bar", mod.Fragments![0].Id);
        Assert.Equal("sidebar.left", mod.Fragments[0].Slot);
        Assert.Equal("text/html", mod.Fragments[0].Format);
        Assert.True(mod.Fragments[0].Inline);
        Assert.Equal(10, mod.Fragments[0].Priority);
        Assert.Single(mod.Fragments[0].Bindings!);
        Assert.Single(mod.Fragments[0].Events!);
    }

    [Fact]
    public void ValidateModManifest_Rejects_Missing_Xript()
    {
        var ex = Assert.Throws<ModManifestValidationException>(() =>
            FragmentProcessor.ValidateModManifest("""{ "name": "test", "version": "1.0.0" }"""));

        Assert.Single(ex.Issues, i => i.Path == "/xript");
    }

    [Fact]
    public void ValidateModManifest_Rejects_Missing_Name()
    {
        var ex = Assert.Throws<ModManifestValidationException>(() =>
            FragmentProcessor.ValidateModManifest("""{ "xript": "0.3", "version": "1.0.0" }"""));

        Assert.Single(ex.Issues, i => i.Path == "/name");
    }

    [Fact]
    public void ValidateModManifest_Rejects_Missing_Version()
    {
        var ex = Assert.Throws<ModManifestValidationException>(() =>
            FragmentProcessor.ValidateModManifest("""{ "xript": "0.3", "name": "test" }"""));

        Assert.Single(ex.Issues, i => i.Path == "/version");
    }

    [Fact]
    public void ValidateModManifest_Reports_Multiple_Issues()
    {
        var ex = Assert.Throws<ModManifestValidationException>(() =>
            FragmentProcessor.ValidateModManifest("""{ "xript": "", "name": "", "version": "" }"""));

        Assert.Equal(3, ex.Issues.Count);
    }

    [Fact]
    public void ValidateModManifest_Rejects_Invalid_Json()
    {
        Assert.Throws<ModManifestValidationException>(() =>
            FragmentProcessor.ValidateModManifest("not json"));
    }

    [Fact]
    public void ValidateModManifest_Validates_Fragment_Required_Fields()
    {
        var ex = Assert.Throws<ModManifestValidationException>(() =>
            FragmentProcessor.ValidateModManifest("""
                {
                    "xript": "0.3",
                    "name": "test",
                    "version": "1.0.0",
                    "fragments": [
                        { "id": "", "slot": "", "format": "", "source": "<p>ok</p>" }
                    ]
                }
                """));

        Assert.Contains(ex.Issues, i => i.Path == "/fragments/0/id");
        Assert.Contains(ex.Issues, i => i.Path == "/fragments/0/slot");
        Assert.Contains(ex.Issues, i => i.Path == "/fragments/0/format");
    }

    [Fact]
    public void CrossValidate_Returns_Empty_For_Valid_Mod()
    {
        var app = JsonSerializer.Deserialize<Manifest>("""
            {
                "xript": "0.3",
                "name": "test-app",
                "slots": [
                    { "id": "sidebar.left", "accepts": ["text/html"] }
                ]
            }
            """)!;

        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
                ]
            }
            """);

        var issues = FragmentProcessor.CrossValidate(mod, app, new HashSet<string>());
        Assert.Empty(issues);
    }

    [Fact]
    public void CrossValidate_Detects_Missing_Slot()
    {
        var app = JsonSerializer.Deserialize<Manifest>("""
            {
                "xript": "0.3",
                "name": "test-app",
                "slots": [
                    { "id": "sidebar.left", "accepts": ["text/html"] }
                ]
            }
            """)!;

        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "panel", "slot": "nonexistent", "format": "text/html", "source": "<p>hi</p>", "inline": true }
                ]
            }
            """);

        var issues = FragmentProcessor.CrossValidate(mod, app, new HashSet<string>());
        Assert.Single(issues);
        Assert.Contains("nonexistent", issues[0]);
    }

    [Fact]
    public void CrossValidate_Detects_Unsupported_Format()
    {
        var app = JsonSerializer.Deserialize<Manifest>("""
            {
                "xript": "0.3",
                "name": "test-app",
                "slots": [
                    { "id": "sidebar.left", "accepts": ["text/html"] }
                ]
            }
            """)!;

        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "panel", "slot": "sidebar.left", "format": "text/plain", "source": "hello", "inline": true }
                ]
            }
            """);

        var issues = FragmentProcessor.CrossValidate(mod, app, new HashSet<string>());
        Assert.Single(issues);
        Assert.Contains("text/plain", issues[0]);
    }

    [Fact]
    public void CrossValidate_Detects_Missing_Capability()
    {
        var app = JsonSerializer.Deserialize<Manifest>("""
            {
                "xript": "0.3",
                "name": "test-app",
                "slots": [
                    { "id": "main.overlay", "accepts": ["text/html"], "capability": "ui-mount" }
                ]
            }
            """)!;

        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "overlay", "slot": "main.overlay", "format": "text/html", "source": "<p>hi</p>", "inline": true }
                ]
            }
            """);

        var issues = FragmentProcessor.CrossValidate(mod, app, new HashSet<string>());
        Assert.Single(issues);
        Assert.Contains("ui-mount", issues[0]);
    }

    [Fact]
    public void CrossValidate_Passes_When_Capability_Granted()
    {
        var app = JsonSerializer.Deserialize<Manifest>("""
            {
                "xript": "0.3",
                "name": "test-app",
                "slots": [
                    { "id": "main.overlay", "accepts": ["text/html"], "capability": "ui-mount" }
                ]
            }
            """)!;

        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "overlay", "slot": "main.overlay", "format": "text/html", "source": "<p>hi</p>", "inline": true }
                ]
            }
            """);

        var issues = FragmentProcessor.CrossValidate(mod, app, new HashSet<string>(["ui-mount"]));
        Assert.Empty(issues);
    }

    [Fact]
    public void SanitizeHtml_Strips_Script_Tags()
    {
        var result = FragmentProcessor.SanitizeHtml("<script>alert('xss')</script><p>safe</p>");
        Assert.Equal("<p>safe</p>", result);
    }

    [Fact]
    public void SanitizeHtml_Strips_Iframe_Tags()
    {
        var result = FragmentProcessor.SanitizeHtml("<iframe src=\"evil.com\"></iframe><p>ok</p>");
        Assert.Equal("<p>ok</p>", result);
    }

    [Fact]
    public void SanitizeHtml_Strips_OnClick_Attribute()
    {
        var result = FragmentProcessor.SanitizeHtml("<div onclick=\"alert('xss')\">test</div>");
        Assert.Equal("<div>test</div>", result);
    }

    [Fact]
    public void SanitizeHtml_Strips_Javascript_Uri()
    {
        var result = FragmentProcessor.SanitizeHtml("<a href=\"javascript:alert('xss')\">click</a>");
        Assert.Equal("<a>click</a>", result);
    }

    [Fact]
    public void SanitizeHtml_Preserves_Safe_Content()
    {
        var input = "<div class=\"panel\"><span data-bind=\"health\">0</span></div>";
        var result = FragmentProcessor.SanitizeHtml(input);
        Assert.Equal(input, result);
    }

    [Fact]
    public void SanitizeHtml_Preserves_Aria_And_Role()
    {
        var input = "<div aria-label=\"health\" role=\"progressbar\">bar</div>";
        var result = FragmentProcessor.SanitizeHtml(input);
        Assert.Equal(input, result);
    }

    [Fact]
    public void SanitizeHtml_Preserves_DataIf()
    {
        var input = "<div data-if=\"health < 50\" class=\"warning\">low!</div>";
        var result = FragmentProcessor.SanitizeHtml(input);
        Assert.Equal(input, result);
    }

    [Fact]
    public void SanitizeHtml_Strips_Document_Wrappers()
    {
        var result = FragmentProcessor.SanitizeHtml(
            "<html><head><title>x</title></head><body><p>content</p></body></html>");
        Assert.Equal("<p>content</p>", result);
    }

    [Fact]
    public void SanitizeHtml_Handles_Empty_Input()
    {
        Assert.Equal("", FragmentProcessor.SanitizeHtml(""));
    }

    [Fact]
    public void SanitizeHtml_Preserves_Plain_Text()
    {
        Assert.Equal("plain text with no tags", FragmentProcessor.SanitizeHtml("plain text with no tags"));
    }

    [Fact]
    public void SanitizeHtml_Strips_Form_Elements()
    {
        var result = FragmentProcessor.SanitizeHtml(
            "<form action=\"/steal\"><input name=\"token\" /></form><p>safe</p>");
        Assert.Equal("<p>safe</p>", result);
    }

    [Fact]
    public void SanitizeHtml_Preserves_Safe_Data_Image_Uri()
    {
        var input = "<img src=\"data:image/png;base64,abc123\" />";
        var result = FragmentProcessor.SanitizeHtml(input);
        Assert.Equal(input, result);
    }

    [Fact]
    public void SanitizeHtml_Strips_Dangerous_Data_Uri()
    {
        var result = FragmentProcessor.SanitizeHtml(
            "<img src=\"data:text/html,<script>alert('xss')</script>\" />");
        Assert.Equal("<img />", result);
    }

    [Fact]
    public void ProcessFragment_Resolves_DataBind()
    {
        var bindings = new Dictionary<string, object?> { ["health"] = 75 };
        var result = FragmentProcessor.ProcessFragment(
            "test", "<span data-bind=\"health\">0</span>", bindings);
        Assert.Equal("<span data-bind=\"health\">75</span>", result.Html);
    }

    [Fact]
    public void ProcessFragment_Leaves_Unbound_Values()
    {
        var bindings = new Dictionary<string, object?>();
        var result = FragmentProcessor.ProcessFragment(
            "test", "<span data-bind=\"missing\">default</span>", bindings);
        Assert.Equal("<span data-bind=\"missing\">default</span>", result.Html);
    }

    [Fact]
    public void ProcessFragment_Evaluates_DataIf_True()
    {
        var bindings = new Dictionary<string, object?> { ["health"] = 25 };
        var result = FragmentProcessor.ProcessFragment(
            "test", "<div data-if=\"health < 50\">warning</div>", bindings);
        Assert.True(result.Visibility["health < 50"]);
    }

    [Fact]
    public void ProcessFragment_Evaluates_DataIf_False()
    {
        var bindings = new Dictionary<string, object?> { ["health"] = 75 };
        var result = FragmentProcessor.ProcessFragment(
            "test", "<div data-if=\"health < 50\">warning</div>", bindings);
        Assert.False(result.Visibility["health < 50"]);
    }

    [Fact]
    public void ResolveBindingPath_Resolves_Nested_Paths()
    {
        var data = new Dictionary<string, object?>
        {
            ["player"] = new Dictionary<string, object?>
            {
                ["health"] = new Dictionary<string, object?>
                {
                    ["current"] = 42
                }
            }
        };

        var result = FragmentProcessor.ResolveBindingPath(data, "player.health.current");
        Assert.Equal(42, result);
    }

    [Fact]
    public void ResolveBindingPath_Returns_Null_For_Missing()
    {
        var data = new Dictionary<string, object?> { ["x"] = 1 };
        var result = FragmentProcessor.ResolveBindingPath(data, "y.z");
        Assert.Null(result);
    }

    [Fact]
    public void ModInstance_UpdateBindings_Returns_Results_For_All_Fragments()
    {
        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    {
                        "id": "panel-a",
                        "slot": "sidebar.left",
                        "format": "text/html",
                        "source": "<span data-bind=\"val\">0</span>",
                        "inline": true,
                        "bindings": [{ "name": "val", "path": "value" }]
                    },
                    {
                        "id": "panel-b",
                        "slot": "sidebar.right",
                        "format": "text/html",
                        "source": "<p>static</p>",
                        "inline": true
                    }
                ]
            }
            """);

        var instance = new ModInstance(mod, null);
        Assert.Equal(2, instance.Fragments.Count);

        var results = instance.UpdateBindings(new Dictionary<string, object?> { ["value"] = 99 });
        Assert.Equal(2, results.Count);
        Assert.Contains("99", results[0].Html);
    }

    [Fact]
    public void FragmentInstance_GetEvents_Returns_Declared_Events()
    {
        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    {
                        "id": "panel",
                        "slot": "sidebar.left",
                        "format": "text/html",
                        "source": "<button data-action=\"heal\">Heal</button>",
                        "inline": true,
                        "events": [
                            { "selector": "[data-action='heal']", "on": "click", "handler": "onHeal" }
                        ]
                    }
                ]
            }
            """);

        var instance = new ModInstance(mod, null);
        var events = instance.Fragments[0].GetEvents();
        Assert.Single(events);
        Assert.Equal("[data-action='heal']", events[0].Selector);
        Assert.Equal("click", events[0].On);
        Assert.Equal("onHeal", events[0].Handler);
    }

    [Fact]
    public void FragmentInstance_Priority_Defaults_To_Zero()
    {
        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "<p>hi</p>", "inline": true }
                ]
            }
            """);

        var instance = new ModInstance(mod, null);
        Assert.Equal(0, instance.Fragments[0].Priority);
    }

    [Fact]
    public void FragmentInstance_Uses_External_Source()
    {
        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "panel", "slot": "sidebar.left", "format": "text/html", "source": "fragments/panel.html" }
                ]
            }
            """);

        var sources = new Dictionary<string, string>
        {
            ["fragments/panel.html"] = "<div data-bind=\"name\">nobody</div>"
        };

        var instance = new ModInstance(mod, sources);
        var result = instance.Fragments[0].GetContent(new Dictionary<string, object?>
        {
            ["name"] = "Player1"
        });

        Assert.Contains("nobody", result.Html);
    }

    [Fact]
    public void FragmentInstance_Uses_External_Source_With_Bindings()
    {
        var mod = FragmentProcessor.ValidateModManifest("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    {
                        "id": "panel",
                        "slot": "sidebar.left",
                        "format": "text/html",
                        "source": "fragments/panel.html",
                        "bindings": [{ "name": "name", "path": "playerName" }]
                    }
                ]
            }
            """);

        var sources = new Dictionary<string, string>
        {
            ["fragments/panel.html"] = "<div data-bind=\"name\">nobody</div>"
        };

        var instance = new ModInstance(mod, sources);
        var result = instance.Fragments[0].GetContent(new Dictionary<string, object?>
        {
            ["playerName"] = "Player1"
        });

        Assert.Contains("Player1", result.Html);
    }

    [Fact]
    public void LoadMod_Integration_Creates_ModInstance()
    {
        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.3",
                "name": "test-app",
                "slots": [
                    { "id": "sidebar.left", "accepts": ["text/html"] }
                ]
            }
            """);

        var mod = rt.LoadMod("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    {
                        "id": "panel",
                        "slot": "sidebar.left",
                        "format": "text/html",
                        "source": "<span data-bind=\"hp\">0</span>",
                        "inline": true,
                        "bindings": [{ "name": "hp", "path": "health" }]
                    }
                ]
            }
            """);

        Assert.Equal("test-mod", mod.Name);
        Assert.Single(mod.Fragments);

        var results = mod.UpdateBindings(new Dictionary<string, object?> { ["health"] = 42 });
        Assert.Single(results);
        Assert.Contains("42", results[0].Html);
    }

    [Fact]
    public void LoadMod_Rejects_Invalid_Slot()
    {
        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.3",
                "name": "test-app",
                "slots": [
                    { "id": "sidebar.left", "accepts": ["text/html"] }
                ]
            }
            """);

        Assert.Throws<ModManifestValidationException>(() => rt.LoadMod("""
            {
                "xript": "0.3",
                "name": "test-mod",
                "version": "1.0.0",
                "fragments": [
                    { "id": "panel", "slot": "nonexistent", "format": "text/html", "source": "<p>hi</p>", "inline": true }
                ]
            }
            """));
    }

    [Fact]
    public void FragmentHook_Mount_Fires_And_Returns_Ops()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        rt.Execute("""
            hooks.fragment.update('hp-bar', function(data, fragment) {
                fragment.setText('.health-value', 'HP: ' + data.health);
                fragment.addClass('.health-bar', 'danger');
            });
            """);

        var ops = rt.FireFragmentHook("hp-bar", "update",
            new Dictionary<string, object?> { ["health"] = 25 });

        Assert.Equal(2, ops.Length);
        Assert.Equal("setText", ops[0].Op);
        Assert.Equal(".health-value", ops[0].Selector);
        Assert.Equal("addClass", ops[1].Op);
        Assert.Equal(".health-bar", ops[1].Selector);
        Assert.Equal("danger", ops[1].Value?.ToString());
    }

    [Fact]
    public void FragmentHook_Returns_Empty_For_No_Handlers()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ops = rt.FireFragmentHook("nonexistent", "mount");
        Assert.Empty(ops);
    }

    [Fact]
    public void FragmentHook_Namespace_Is_Frozen()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var result = rt.Execute("Object.isFrozen(hooks.fragment)");
        Assert.True(result.Value.GetBoolean());
    }

    [Fact]
    public void SanitizeHtml_Strips_Multiple_OnEvent_Attrs()
    {
        var result = FragmentProcessor.SanitizeHtml(
            "<div onmouseover=\"steal()\" onload=\"steal()\" onfocus=\"steal()\">test</div>");
        Assert.Equal("<div>test</div>", result);
    }

    [Fact]
    public void SanitizeHtml_Strips_Embed_Elements()
    {
        var result = FragmentProcessor.SanitizeHtml("<embed src=\"plugin.swf\" /><p>safe</p>");
        Assert.Equal("<p>safe</p>", result);
    }

    [Fact]
    public void SanitizeHtml_Strips_Object_Elements()
    {
        var result = FragmentProcessor.SanitizeHtml(
            "<object data=\"flash.swf\"><param name=\"movie\" value=\"flash.swf\"></object><p>safe</p>");
        Assert.Equal("<p>safe</p>", result);
    }
}
