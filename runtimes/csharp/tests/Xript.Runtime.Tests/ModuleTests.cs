using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class ModuleTests
{
    private static JsonElement Str(string s) =>
        JsonDocument.Parse(JsonSerializer.Serialize(s)).RootElement.Clone();

    private static JsonElement Num(double n) =>
        JsonDocument.Parse(n.ToString("R")).RootElement.Clone();

    private const string ModuleMod = """
        {
            "xript": "0.3",
            "name": "transcriber",
            "version": "1.0.0",
            "entry": {
                "script": "mod.js",
                "format": "module",
                "exports": {
                    "transcribe": { "description": "uppercases input" }
                }
            }
        }
        """;

    [Fact]
    public void Module_Top_Level_Export_Is_Invokable()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "export function transcribe(s) { return s.toUpperCase(); }"
        });

        var result = rt.InvokeExport("transcribe", [Str("hello")]);
        Assert.Equal("HELLO", result.GetString());
    }

    [Fact]
    public void Module_Const_Function_Export_Is_Invokable()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "const fn = (s) => s.toUpperCase(); export { fn as transcribe };"
        });

        Assert.Equal("HI", rt.InvokeExport("transcribe", [Str("hi")]).GetString());
    }

    [Fact]
    public void Module_Non_Function_Export_Is_Not_Invokable()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "dataonly",
                "version": "1.0.0",
                "entry": { "script": "mod.js", "format": "module", "exports": {} }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["mod.js"] = "export const VERSION = '1.0';"
        });

        Assert.Throws<InvokeException>(() => rt.InvokeExport("VERSION", []));
    }

    [Fact]
    public void Module_Default_Export_Is_Not_Harvested()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "defaultmod",
                "version": "1.0.0",
                "entry": { "script": "mod.js", "format": "module", "exports": {} }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["mod.js"] = "export default function() { return 1; }"
        });

        Assert.Throws<InvokeException>(() => rt.InvokeExport("default", []));
    }

    [Fact]
    public void Module_Side_Effecting_Register_Still_Works()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "mixed",
                "version": "1.0.0",
                "entry": { "script": "mod.js", "format": "module", "exports": { "viaRegister": {} } }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["mod.js"] = "xript.exports.register('viaRegister', function() { return 'registered'; });"
        });

        Assert.Equal("registered", rt.InvokeExport("viaRegister", []).GetString());
    }

    [Fact]
    public void Module_Export_And_Register_Coexist()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "both",
                "version": "1.0.0",
                "entry": {
                    "script": "mod.js",
                    "format": "module",
                    "exports": { "fromExport": {}, "fromRegister": {} }
                }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["mod.js"] = """
                export function fromExport() { return 'export'; }
                xript.exports.register('fromRegister', function() { return 'register'; });
                """
        });

        Assert.Equal("export", rt.InvokeExport("fromExport", []).GetString());
        Assert.Equal("register", rt.InvokeExport("fromRegister", []).GetString());
    }

    [Fact]
    public void Collision_Register_Wins_Over_Export()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "collision",
                "version": "1.0.0",
                "entry": { "script": "mod.js", "format": "module", "exports": { "name": {} } }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["mod.js"] = """
                export function name() { return 'export-version'; }
                xript.exports.register('name', function() { return 'register-version'; });
                """
        });

        Assert.Equal("register-version", rt.InvokeExport("name", []).GetString());
    }

    [Fact]
    public void Module_Sees_Ambient_Globals()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = """
                let captured = typeof xript;
                export function transcribe() { return captured; }
                """
        });

        Assert.Equal("object", rt.InvokeExport("transcribe", []).GetString());
    }

    [Fact]
    public void Module_Top_Level_Await_Permitted()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = """
                const v = await Promise.resolve(99);
                export function transcribe() { return v; }
                """
        });

        Assert.Equal(99, rt.InvokeExport("transcribe", []).GetInt64());
    }

    [Fact]
    public void Module_Never_Settling_Await_Is_Load_Error()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        Assert.Throws<ModEntryException>(() => rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = """
                await new Promise(function() {});
                export function transcribe() { return 1; }
                """
        }));
    }

    [Fact]
    public void Module_Top_Level_Throw_Is_Load_Error()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<ModEntryException>(() => rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "throw new Error('boom'); export function transcribe() {}"
        }));
        Assert.Equal("transcriber", ex.ModName);
    }

    [Fact]
    public void Module_Syntax_Error_Is_Load_Error()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        Assert.Throws<ModEntryException>(() => rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "export function ("
        }));
    }

    [Fact]
    public void Module_Capability_Gating_Applies_To_Harvested_Export()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "secure",
                "version": "1.0.0",
                "entry": {
                    "script": "mod.js",
                    "format": "module",
                    "exports": { "secret": { "capability": "audio-read" } }
                }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["mod.js"] = "export function secret() { return 42; }"
        });

        Assert.Throws<CapabilityDeniedException>(() => rt.InvokeExport("secret", []));
    }

    [Fact]
    public void Module_Capability_Gated_Export_Allowed_With_Grant()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "secure",
                "version": "1.0.0",
                "entry": {
                    "script": "mod.js",
                    "format": "module",
                    "exports": { "secret": { "capability": "audio-read" } }
                }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Capabilities = ["audio-read"]
        });
        rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["mod.js"] = "export function secret() { return 42; }"
        });

        Assert.Equal(42, rt.InvokeExport("secret", []).GetInt64());
    }

    [Fact]
    public void Module_Bare_Import_Denied_At_Load()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<ImportDeniedException>(() => rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "import fs from 'fs'; export function transcribe() {}"
        }));
        Assert.Equal("fs", ex.Specifier);
    }

    [Fact]
    public void Module_Relative_Import_Denied_At_Load()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<ImportDeniedException>(() => rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "import { x } from './helper.js'; export function transcribe() { return x; }"
        }));
        Assert.Equal("./helper.js", ex.Specifier);
    }

    [Fact]
    public void Module_Url_Import_Denied_At_Load()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<ImportDeniedException>(() => rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "import x from 'https://evil.example/x.js'; export function transcribe() {}"
        }));
        Assert.Contains("evil.example", ex.Specifier);
    }

    [Fact]
    public void Module_Import_Denied_Message_Is_Stable()
    {
        var ex = new ImportDeniedException("lodash");
        Assert.Contains("import of \"lodash\" is not permitted", ex.Message);
        Assert.Contains("cannot import external modules", ex.Message);
    }

    [Fact]
    public void Module_With_No_Imports_Loads_Clean()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "export function transcribe(x) { return x + 1; }"
        });

        Assert.Equal(6, rt.InvokeExport("transcribe", [Num(5)]).GetInt64());
    }

    [Fact]
    public void CommonJs_Require_Detected_In_Module_Mode()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<CommonJsDetectedException>(() => rt.LoadMod(ModuleMod, new Dictionary<string, string>
        {
            ["mod.js"] = "const fs = require('fs'); export function transcribe() {}"
        }));
        Assert.Equal("require()", ex.Artifact);
    }

    [Fact]
    public void CommonJs_ModuleExports_Detected_In_Script_Mode()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "cjs",
                "version": "1.0.0",
                "entry": { "script": "main.js", "format": "script", "exports": {} }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<CommonJsDetectedException>(() => rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["main.js"] = "module.exports = { transcribe: function() {} };"
        }));
        Assert.Equal("module.exports", ex.Artifact);
    }

    [Fact]
    public void CommonJs_ExportsAssignment_Detected()
    {
        const string mod = """
            {
                "xript": "0.3",
                "name": "cjs2",
                "version": "1.0.0",
                "entry": { "script": "main.js", "format": "script", "exports": {} }
            }
            """;

        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var ex = Assert.Throws<CommonJsDetectedException>(() => rt.LoadMod(mod, new Dictionary<string, string>
        {
            ["main.js"] = "exports.transcribe = function() {};"
        }));
        Assert.Equal("exports.x", ex.Artifact);
    }

    [Fact]
    public void CommonJs_Message_Points_At_Tsconfig_Fix()
    {
        var ex = new CommonJsDetectedException("require()");
        Assert.Contains("tsconfig", ex.Message);
        Assert.Contains("esnext", ex.Message);
        Assert.Contains("authoring-mods-in-typescript", ex.Message);
    }

    [Fact]
    public void Script_Mode_Xript_Exports_Register_Not_Flagged_As_Cjs()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod("""
            { "xript": "0.3", "name": "clean", "version": "1.0.0", "entry": "main.js" }
            """, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('ping', function() { return 'pong'; });"
        });

        Assert.Equal("pong", rt.InvokeExport("ping", []).GetString());
    }

    [Fact]
    public void Script_Mode_Still_Works_Unchanged()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        rt.LoadMod("""
            {
                "xript": "0.3",
                "name": "classic",
                "version": "1.0.0",
                "entry": { "script": "main.js", "format": "script", "exports": { "shout": {} } }
            }
            """, new Dictionary<string, string>
        {
            ["main.js"] = "xript.exports.register('shout', function(s) { return s.toUpperCase(); });"
        });

        Assert.Equal("HELLO", rt.InvokeExport("shout", [Str("hello")]).GetString());
    }
}
