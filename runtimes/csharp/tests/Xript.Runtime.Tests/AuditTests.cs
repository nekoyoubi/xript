using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class AuditTests
{
    private static JsonElement Num(double n) =>
        JsonDocument.Parse(n.ToString("R")).RootElement.Clone();

    [Fact]
    public void Audit_Fires_On_Allowed_Invocation()
    {
        var events = new List<AuditEvent>();
        var bindings = new HostBindings();
        bindings.AddFunction("add", args => Num(args[0].GetDouble() + args[1].GetDouble()));

        using var rt = XriptRuntime.Create(TestManifests.WithBinding, new RuntimeOptions
        {
            HostBindings = bindings,
            Audit = events.Add
        });

        rt.Execute("add(2, 3)");

        var ev = Assert.Single(events);
        Assert.Equal("add", ev.Binding);
        Assert.Null(ev.Capability);
        Assert.True(ev.AtMs > 0);
    }

    [Fact]
    public void Audit_Carries_Capability_For_Gated_Binding()
    {
        var events = new List<AuditEvent>();
        var bindings = new HostBindings();
        bindings.AddFunction("dangerousOp", _ => Num(1));

        using var rt = XriptRuntime.Create(TestManifests.WithCapability, new RuntimeOptions
        {
            HostBindings = bindings,
            Capabilities = ["dangerous"],
            Audit = events.Add
        });

        rt.Execute("dangerousOp()");

        var ev = Assert.Single(events);
        Assert.Equal("dangerousOp", ev.Binding);
        Assert.Equal("dangerous", ev.Capability);
    }

    [Fact]
    public void Audit_Does_Not_Fire_On_Denied_Invocation()
    {
        var events = new List<AuditEvent>();

        using var rt = XriptRuntime.Create(TestManifests.WithCapability, new RuntimeOptions
        {
            Audit = events.Add
        });

        rt.Execute("try { dangerousOp(); } catch (e) {}");

        Assert.Empty(events);
    }

    [Fact]
    public void Audit_Uses_Qualified_Name_For_Namespace_Members()
    {
        var events = new List<AuditEvent>();
        var bindings = new HostBindings();
        bindings.AddNamespace("player", new Dictionary<string, HostFunction>
        {
            ["getName"] = _ => JsonDocument.Parse("\"Hero\"").RootElement.Clone()
        });

        using var rt = XriptRuntime.Create(TestManifests.WithNamespace, new RuntimeOptions
        {
            HostBindings = bindings,
            Audit = events.Add
        });

        rt.Execute("player.getName()");

        var ev = Assert.Single(events);
        Assert.Equal("player.getName", ev.Binding);
    }

    [Fact]
    public void Audit_Emit_Failure_Does_Not_Break_Execution()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("add", args => Num(args[0].GetDouble() + args[1].GetDouble()));

        using var rt = XriptRuntime.Create(TestManifests.WithBinding, new RuntimeOptions
        {
            HostBindings = bindings,
            Audit = _ => throw new Exception("sink blew up")
        });

        var result = rt.Execute("add(4, 5)");
        Assert.Equal(9, result.Value.GetDouble());
    }

    private const string HookHost = """
        {
            "xript": "0.7",
            "name": "audit-host",
            "capabilities": { "persistence": { "description": "storage" } },
            "slots": [
                { "id": "on-save", "accepts": ["application/x-xript-hook"], "description": "save event" }
            ]
        }
        """;

    private static XriptRuntime HookRuntime(List<AuditEvent> events, params string[] capabilities) =>
        XriptRuntime.Create(HookHost, new RuntimeOptions
        {
            HostBindings = new HostBindings(),
            Capabilities = [.. capabilities],
            Audit = events.Add
        });

    private static void LoadGatedHookMod(XriptRuntime rt, string name) =>
        rt.LoadMod($$"""
            {
                "xript": "0.7", "name": "{{name}}", "version": "1.0.0",
                "entry": {
                    "script": "mod.js",
                    "exports": { "onSave": { "description": "h", "capability": "persistence.disk" } }
                },
                "fills": { "on-save": [ { "handler": "onSave" } ] }
            }
            """, new Dictionary<string, string>
        {
            ["mod.js"] = """xript.exports.register("onSave", function() { return "saved"; });""",
        });

    [Fact]
    public void Audit_Reports_A_Capability_Denied_Hook_Fill()
    {
        var events = new List<AuditEvent>();
        using var rt = HookRuntime(events);
        LoadGatedHookMod(rt, "gated-mod");

        var results = rt.FireHook("on-save");
        Assert.Single(results);
        Assert.Equal(JsonValueKind.Null, results[0].ValueKind);

        var denial = Assert.Single(events.Where(e => e.Decision == AuditDecision.Denied));
        Assert.Equal("gated-mod", denial.Mod);
        Assert.Equal("onSave", denial.Binding);
        Assert.Equal("on-save", denial.Hook);
        Assert.Equal("persistence.disk", denial.Capability);
        Assert.True(denial.AtMs > 0);
    }

    [Fact]
    public void Audit_Reports_A_Denied_Hook_Fill_Once_Per_Mod_Handler_Hook()
    {
        var events = new List<AuditEvent>();
        using var rt = HookRuntime(events);
        LoadGatedHookMod(rt, "gated-mod");

        for (var i = 0; i < 25; i++) rt.FireHook("on-save");

        Assert.Single(events.Where(e => e.Decision == AuditDecision.Denied));
    }

    [Fact]
    public void Audit_Reports_Each_Denied_Mod_Separately()
    {
        var events = new List<AuditEvent>();
        using var rt = HookRuntime(events);
        LoadGatedHookMod(rt, "mod-a");
        LoadGatedHookMod(rt, "mod-b");

        rt.FireHook("on-save");
        rt.FireHook("on-save");

        var mods = events.Where(e => e.Decision == AuditDecision.Denied).Select(e => e.Mod).Order().ToList();
        Assert.Equal(["mod-a", "mod-b"], mods);
    }

    [Fact]
    public void Audit_Stays_Silent_When_A_Hook_Handler_Throws_On_Its_Own()
    {
        var events = new List<AuditEvent>();
        using var rt = HookRuntime(events);
        rt.LoadMod("""
            {
                "xript": "0.7", "name": "throwing-mod", "version": "1.0.0",
                "entry": { "script": "mod.js", "exports": { "onSave": { "description": "h" } } },
                "fills": { "on-save": [ { "handler": "onSave" } ] }
            }
            """, new Dictionary<string, string>
        {
            ["mod.js"] = """xript.exports.register("onSave", function() { throw new Error("mod bug"); });""",
        });

        var results = rt.FireHook("on-save");
        Assert.Single(results);
        Assert.Empty(events.Where(e => e.Decision == AuditDecision.Denied));
    }

    [Fact]
    public void Audit_Stays_Silent_When_The_Grant_Subsumes_The_Export_Capability()
    {
        var events = new List<AuditEvent>();
        using var rt = HookRuntime(events, "persistence");
        LoadGatedHookMod(rt, "gated-mod");

        var results = rt.FireHook("on-save");
        Assert.Equal("saved", results[0].GetString());
        Assert.Empty(events.Where(e => e.Decision == AuditDecision.Denied));
    }
}
