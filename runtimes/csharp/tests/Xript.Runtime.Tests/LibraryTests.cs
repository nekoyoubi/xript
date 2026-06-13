using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class LibraryTests
{
    private static JsonElement Str(string s) =>
        JsonDocument.Parse(JsonSerializer.Serialize(s)).RootElement.Clone();

    private const string DocLib = """
        export function shout(s){ return s.toUpperCase() + "!"; }
        export const NAME = "doc-lib";
        """;

    private const string HostManifest = """
        {
            "xript": "0.7",
            "name": "library-host",
            "capabilities": {
                "lib": { "description": "shared libraries" }
            },
            "libraries": {
                "@example/doc": { "description": "doc helpers", "capability": "lib.doc", "version": "^1.0.0" },
                "open-lib": { "description": "ungated helpers" }
            }
        }
        """;

    private const string ConsumerMod = """
        {
            "xript": "0.7",
            "name": "lib-consumer",
            "version": "1.0.0",
            "entry": { "script": "mod.js", "format": "module", "exports": { "use": { "description": "uses the lib" } } }
        }
        """;

    private static Dictionary<string, string> Entry(string source) => new() { ["mod.js"] = source };

    private static RuntimeOptions Opts(List<string>? capabilities = null, Dictionary<string, string>? libraries = null) => new()
    {
        Capabilities = capabilities ?? [],
        Libraries = libraries ?? new Dictionary<string, string>(),
    };

    private static Dictionary<string, string> DocLibraries() => new() { ["@example/doc"] = DocLib };

    [Fact]
    public void Links_An_Approved_Library_With_Full_Fidelity_Calls()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(["lib.doc"], DocLibraries()));
        rt.LoadMod(ConsumerMod, Entry("""import { shout, NAME } from "@example/doc"; export function use(s){ return NAME + ": " + shout(s); }"""));
        Assert.Equal("doc-lib: HI!", rt.InvokeExport("use", [Str("hi")]).GetString());
    }

    [Fact]
    public void Satisfies_The_Gate_Through_Capability_Subsumption()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(["lib"], DocLibraries()));
        rt.LoadMod(ConsumerMod, Entry("""import { shout } from "@example/doc"; export function use(s){ return shout(s); }"""));
        Assert.Equal("OK!", rt.InvokeExport("use", [Str("ok")]).GetString());
    }

    [Fact]
    public void Denies_An_Undeclared_Specifier()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(["lib"], DocLibraries()));
        var ex = Assert.Throws<ImportDeniedException>(() =>
            rt.LoadMod(ConsumerMod, Entry("""import _ from "lodash"; export function use(){ return 1; }""")));
        Assert.Equal("lodash", ex.Specifier);
    }

    [Fact]
    public void Denies_An_Ungranted_Library()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(libraries: DocLibraries()));
        var ex = Assert.Throws<CapabilityDeniedException>(() =>
            rt.LoadMod(ConsumerMod, Entry("""import { shout } from "@example/doc"; export function use(){ return 1; }""")));
        Assert.Equal("lib.doc", ex.Capability);
    }

    [Fact]
    public void Allows_An_Ungated_Library_With_No_Grants()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(libraries: new Dictionary<string, string>
        {
            ["open-lib"] = "export function id(x){ return x; }",
        }));
        rt.LoadMod(ConsumerMod, Entry("""import { id } from "open-lib"; export function use(x){ return id(x); }"""));
        Assert.Equal("echo", rt.InvokeExport("use", [Str("echo")]).GetString());
    }

    [Fact]
    public void Names_The_Host_Bug_When_Declared_But_Unregistered()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(["lib"]));
        var ex = Assert.Throws<LibraryUnavailableException>(() =>
            rt.LoadMod(ConsumerMod, Entry("""import { shout } from "@example/doc"; export function use(){ return 1; }""")));
        Assert.Equal("@example/doc", ex.Specifier);
    }

    [Fact]
    public void Rejects_Registering_An_Undeclared_Specifier()
    {
        var ex = Assert.Throws<LibraryRegistrationException>(() =>
            XriptRuntime.Create(HostManifest, Opts(libraries: new Dictionary<string, string>
            {
                ["rogue"] = "export const x = 1;",
            })));
        Assert.Equal("rogue", ex.Specifier);
    }

    [Fact]
    public void Rejects_A_Library_That_Is_Not_Import_Clean()
    {
        var ex = Assert.Throws<LibraryRegistrationException>(() =>
            XriptRuntime.Create(HostManifest, Opts(libraries: new Dictionary<string, string>
            {
                ["@example/doc"] = """import _ from "lodash"; export function shout(){}""",
            })));
        Assert.Contains("import-clean", ex.Message);
    }

    [Fact]
    public void Rejects_A_Library_Carrying_CommonJs()
    {
        var ex = Assert.Throws<LibraryRegistrationException>(() =>
            XriptRuntime.Create(HostManifest, Opts(libraries: new Dictionary<string, string>
            {
                ["@example/doc"] = """const _ = require("lodash"); module.exports = {};""",
            })));
        Assert.Contains("CommonJS", ex.Message);
    }

    [Fact]
    public void Still_Denies_Dynamic_Import_Of_An_Approved_Specifier()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(["lib"], DocLibraries()));
        var ex = Assert.Throws<ImportDeniedException>(() =>
            rt.LoadMod(ConsumerMod, Entry("""export async function use(){ const m = await import("@example/doc"); return m.NAME; }""")));
        Assert.Equal("@example/doc", ex.Specifier);
    }

    [Fact]
    public void Shares_One_Library_Instance_Across_Imports()
    {
        using var rt = XriptRuntime.Create(HostManifest, Opts(libraries: new Dictionary<string, string>
        {
            ["open-lib"] = "export const bag = []; export function push(x){ bag.push(x); return bag.length; }",
        }));
        rt.LoadMod(ConsumerMod, Entry("""import { push } from "open-lib"; export function use(x){ return push(x); }"""));
        Assert.Equal(1, rt.InvokeExport("use", [Str("a")]).GetInt32());
        Assert.Equal(2, rt.InvokeExport("use", [Str("b")]).GetInt32());
    }
}
