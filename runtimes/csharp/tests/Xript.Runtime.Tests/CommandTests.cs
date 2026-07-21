using System.Text.Json.Nodes;
using Xript.Runtime;
using Xript.Runtime.Fragments;

namespace Xript.Runtime.Tests;

public class CommandTests
{
    private const string HostManifest = """
        {
            "xript": "0.7",
            "name": "command-host",
            "capabilities": {
                "editor": { "description": "editor surface" },
                "editor.text": { "description": "document text" },
                "editor-destructive": { "description": "irreversible edits" }
            },
            "slots": [
                {
                    "id": "palette.commands",
                    "accepts": ["application/x-xript-command"],
                    "description": "command palette",
                    "multiple": true
                },
                {
                    "id": "gated.commands",
                    "accepts": ["application/x-xript-command"],
                    "description": "gated palette",
                    "capability": "write:editor.text",
                    "multiple": true
                },
                {
                    "id": "one.command",
                    "accepts": ["application/x-xript-command"],
                    "description": "single-command surface"
                },
                { "id": "transcriber", "accepts": ["application/x-xript-role"], "description": "transcription provider" }
            ]
        }
        """;

    private const string WrapMod = """
        {
            "xript": "0.7", "name": "quote-tools", "version": "1.0.0",
            "entry": { "script": "main.js", "format": "script", "exports": {
                "wrapSelection": { "description": "wrap the selection" }
            }},
            "fills": { "palette.commands": [
                { "id": "wrap.double", "handler": "wrapSelection", "args": { "open": "\"", "close": "\"" } },
                { "id": "wrap.paren", "handler": "wrapSelection", "args": { "open": "(", "close": ")" } }
            ]}
        }
        """;

    private const string WrapSource =
        "xript.exports.register('wrapSelection', function(args) { return (args.open || '') + 'sel' + (args.close || ''); });";

    private static XriptRuntime MakeRuntime(List<string>? capabilities = null) =>
        XriptRuntime.Create(HostManifest, new RuntimeOptions { Capabilities = capabilities ?? [] });

    private static Dictionary<string, string> WrapSources() => new() { ["main.js"] = WrapSource };

    [Fact]
    public void Invokes_A_Command_With_Its_Bound_Arguments()
    {
        using var rt = MakeRuntime();
        rt.LoadMod(WrapMod, WrapSources());

        var command = rt.ResolveCommand("wrap.paren");
        Assert.NotNull(command);
        Assert.Equal("quote-tools:wrap.paren", command!.QualifiedId);
        Assert.Equal("(sel)", rt.InvokeCommand(command).GetString());
    }

    [Fact]
    public void Call_Time_Arguments_Win_Over_Bound_Ones()
    {
        using var rt = MakeRuntime();
        rt.LoadMod(WrapMod, WrapSources());

        var result = rt.InvokeCommand("wrap.double", new JsonObject { ["open"] = "[" });
        Assert.Equal("[sel\"", result.GetString());
    }

    [Fact]
    public void A_Command_Runs_In_Its_Own_Mods_Export_Namespace()
    {
        using var rt = MakeRuntime();
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "alpha-tools", "version": "1.0.0",
                "entry": { "script": "a.js", "format": "script", "exports": { "run": { "description": "alpha" } } },
                "fills": { "palette.commands": [{ "id": "go", "handler": "run" }] }
            }
            """, new Dictionary<string, string> { ["a.js"] = "xript.exports.register('run', function() { return 'ALPHA'; });" });
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "zeta-tools", "version": "1.0.0",
                "entry": { "script": "z.js", "format": "script", "exports": { "run": { "description": "zeta" } } },
                "fills": { "palette.commands": [{ "id": "go", "handler": "run" }] }
            }
            """, new Dictionary<string, string> { ["z.js"] = "xript.exports.register('run', function() { return 'ZETA'; });" });

        Assert.Equal("ALPHA", rt.InvokeCommand("alpha-tools:go").GetString());
        Assert.Equal("ZETA", rt.InvokeCommand("zeta-tools:go").GetString());
        Assert.Throws<AmbiguousExportException>(() => rt.InvokeExport("run", []));
    }

    [Fact]
    public void An_Ungranted_Export_Gate_Denies_The_Command_At_Invoke()
    {
        using var rt = MakeRuntime();
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "strip-tools", "version": "1.0.0",
                "entry": { "script": "s.js", "format": "script", "exports": {
                    "stripFormatting": { "description": "irreversible", "capability": "write:editor-destructive" }
                }},
                "fills": { "palette.commands": [{ "id": "strip.formatting", "handler": "stripFormatting" }] }
            }
            """, new Dictionary<string, string> { ["s.js"] = "xript.exports.register('stripFormatting', function() { return 'RAN'; });" });

        var command = rt.ResolveCommand("strip.formatting")!;
        Assert.Equal("write:editor-destructive", command.Capability);
        Assert.Equal(["write:editor-destructive"], command.Capabilities);
        var error = Assert.Throws<CapabilityDeniedException>(() => rt.InvokeCommand(command));
        Assert.Equal("stripFormatting", error.Binding);
    }

    [Fact]
    public void The_Slot_Gate_Refuses_A_Command_Contribution()
    {
        using var rt = MakeRuntime();
        var error = Assert.Throws<ModManifestValidationException>(() => rt.LoadMod("""
            {
                "xript": "0.7", "name": "quote-tools", "version": "1.0.0",
                "fills": { "gated.commands": [{ "id": "wrap.double", "handler": "wrapSelection" }] }
            }
            """));
        Assert.Contains(error.Issues, issue => issue.Message.Contains("requires capability 'write:editor.text'"));
    }

    [Fact]
    public void A_Granted_Slot_Reports_Its_Gate_As_The_Commands_Capability()
    {
        using var rt = MakeRuntime(["write:editor"]);
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "quote-tools", "version": "1.0.0",
                "capabilities": ["write:editor"],
                "entry": { "script": "main.js", "format": "script", "exports": {
                    "wrapSelection": { "description": "wrap the selection" },
                    "stripFormatting": { "description": "irreversible", "capability": "write:editor-destructive" }
                }},
                "fills": { "gated.commands": [
                    { "id": "wrap.double", "handler": "wrapSelection" },
                    { "id": "strip.formatting", "handler": "stripFormatting" }
                ]}
            }
            """, WrapSources());

        var wrap = rt.ResolveCommand("wrap.double")!;
        Assert.Equal("write:editor.text", wrap.Capability);
        Assert.Equal(["write:editor.text"], wrap.Capabilities);

        var strip = rt.ResolveCommand("strip.formatting")!;
        Assert.Equal("write:editor-destructive", strip.Capability);
        Assert.Equal(["write:editor.text", "write:editor-destructive"], strip.Capabilities);
    }

    [Fact]
    public void Command_Fills_No_Longer_Arrive_As_Untyped_Fills()
    {
        using var rt = MakeRuntime();
        var mod = rt.LoadMod(WrapMod, WrapSources());

        Assert.Empty(mod.Fragments);
        Assert.Equal(["wrap.double", "wrap.paren"], mod.CommandFills.Select(fill => fill.Id));
        Assert.Empty(rt.ResolveSlot("palette.commands"));
    }

    [Fact]
    public void A_Slot_Without_Multiple_Resolves_A_Single_Command()
    {
        using var rt = MakeRuntime();
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "quote-tools", "version": "1.0.0",
                "fills": { "one.command": [
                    { "id": "beta", "handler": "run" },
                    { "id": "alpha", "handler": "run" }
                ]}
            }
            """);
        Assert.Equal(2, rt.ResolveCommandsAll("one.command").Count);
        var only = Assert.Single(rt.ResolveCommands("one.command"));
        Assert.Equal("alpha", only.Id);
    }

    [Fact]
    public void Resolves_Commands_Independently_Of_Mod_Load_Order()
    {
        Assert.Equal(Palette(loadAlphaFirst: true), Palette(loadAlphaFirst: false));

        static List<string> Palette(bool loadAlphaFirst)
        {
            const string Alpha = """
                {
                    "xript": "0.7", "name": "alpha-tools", "version": "1.0.0",
                    "fills": { "palette.commands": [{ "id": "wrap", "handler": "run" }] }
                }
                """;
            const string Zeta = """
                {
                    "xript": "0.7", "name": "zeta-tools", "version": "1.0.0",
                    "fills": { "palette.commands": [{ "id": "wrap", "handler": "run" }] }
                }
                """;
            using var rt = MakeRuntime();
            rt.LoadMod(loadAlphaFirst ? Alpha : Zeta);
            rt.LoadMod(loadAlphaFirst ? Zeta : Alpha);
            var resolved = rt.ResolveCommands("palette.commands");
            Assert.All(resolved, command => Assert.True(command.Collides));
            return [.. resolved.Select(command => command.QualifiedId)];
        }
    }

    [Fact]
    public void Resolves_A_Role_Independently_Of_Mod_Load_Order()
    {
        Assert.Equal("alpha-transcriber", Provider(loadAlphaFirst: true));
        Assert.Equal("alpha-transcriber", Provider(loadAlphaFirst: false));

        static string Provider(bool loadAlphaFirst)
        {
            const string Alpha = """
                {
                    "xript": "0.7", "name": "alpha-transcriber", "version": "1.0.0",
                    "fills": { "transcriber": [{ "fns": { "transcribe": "doAlpha" } }] }
                }
                """;
            const string Zeta = """
                {
                    "xript": "0.7", "name": "zeta-transcriber", "version": "1.0.0",
                    "fills": { "transcriber": [{ "fns": { "transcribe": "doZeta" } }] }
                }
                """;
            using var rt = MakeRuntime();
            rt.LoadMod(loadAlphaFirst ? Alpha : Zeta);
            rt.LoadMod(loadAlphaFirst ? Zeta : Alpha);
            Assert.Equal(
                ["alpha-transcriber", "zeta-transcriber"],
                rt.ResolveRoleAll("transcriber").Select(resolution => resolution.Addon));
            return rt.ResolveRole("transcriber")!.Addon;
        }
    }

    [Fact]
    public void A_Role_Preference_Still_Outranks_The_Tiebreak()
    {
        using var rt = XriptRuntime.Create(HostManifest, new RuntimeOptions
        {
            RolePreferences = new Dictionary<string, string> { ["transcriber"] = "zeta-transcriber" },
        });
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "alpha-transcriber", "version": "1.0.0",
                "fills": { "transcriber": [{ "fns": { "transcribe": "doAlpha" } }] }
            }
            """);
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "zeta-transcriber", "version": "1.0.0",
                "fills": { "transcriber": [{ "fns": { "transcribe": "doZeta" } }] }
            }
            """);
        Assert.Equal("zeta-transcriber", rt.ResolveRole("transcriber")!.Addon);
    }

    [Fact]
    public void An_Unknown_Command_Reference_Refuses_To_Guess()
    {
        using var rt = MakeRuntime();
        rt.LoadMod(WrapMod, WrapSources());

        Assert.Null(rt.ResolveCommand("nope"));
        Assert.Throws<InvokeException>(() => rt.InvokeCommand("nope"));
    }

    [Fact]
    public void The_Command_Accept_Is_A_Reserved_Format_Id()
    {
        Assert.Contains("application/x-xript-command", FormatProfiles.ReservedFormatIds);
        Assert.Contains("application/x-xript-command", FormatProfiles.NonFragmentFormatIds);
    }
}
