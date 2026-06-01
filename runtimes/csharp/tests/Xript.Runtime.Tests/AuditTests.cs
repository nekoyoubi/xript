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
}
