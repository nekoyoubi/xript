using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class CapabilityTests
{
    [Fact]
    public void Denies_Ungranted_Capability()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("dangerousOp", _ =>
            JsonDocument.Parse("\"should not reach\"").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithCapability, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("try { dangerousOp(); 'no error' } catch(e) { e.message }");
        Assert.Contains("capability", result.Value.GetString());
    }

    [Fact]
    public void Grants_Capability()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("dangerousOp", _ =>
            JsonDocument.Parse("\"access granted\"").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithCapability, new RuntimeOptions
        {
            HostBindings = bindings,
            Capabilities = ["dangerous"]
        });

        var result = rt.Execute("dangerousOp()");
        Assert.Equal("access granted", result.Value.GetString());
    }

    [Fact]
    public void Denies_Ungranted_Namespace_Capability()
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("admin", new Dictionary<string, HostFunction>
        {
            ["reset"] = _ => JsonDocument.Parse("\"reset done\"").RootElement.Clone(),
            ["status"] = _ => JsonDocument.Parse("\"ok\"").RootElement.Clone()
        });

        using var rt = XriptRuntime.Create(TestManifests.WithNamespaceCapability, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("try { admin.reset(); 'no error' } catch(e) { e.message }");
        Assert.Contains("capability", result.Value.GetString());
    }

    [Fact]
    public void Allows_Ungated_Namespace_Member()
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("admin", new Dictionary<string, HostFunction>
        {
            ["reset"] = _ => JsonDocument.Parse("\"reset done\"").RootElement.Clone(),
            ["status"] = _ => JsonDocument.Parse("\"ok\"").RootElement.Clone()
        });

        using var rt = XriptRuntime.Create(TestManifests.WithNamespaceCapability, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("admin.status()");
        Assert.Equal("ok", result.Value.GetString());
    }

    [Fact]
    public void Grants_Namespace_Capability()
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("admin", new Dictionary<string, HostFunction>
        {
            ["reset"] = _ => JsonDocument.Parse("\"reset done\"").RootElement.Clone(),
            ["status"] = _ => JsonDocument.Parse("\"ok\"").RootElement.Clone()
        });

        using var rt = XriptRuntime.Create(TestManifests.WithNamespaceCapability, new RuntimeOptions
        {
            HostBindings = bindings,
            Capabilities = ["admin-access"]
        });

        var result = rt.Execute("admin.reset()");
        Assert.Equal("reset done", result.Value.GetString());
    }

    [Fact]
    public void Capability_Denial_Message_Format()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("dangerousOp", _ =>
            JsonDocument.Parse("null").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithCapability, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("try { dangerousOp(); '' } catch(e) { e.message }");
        var msg = result.Value.GetString()!;
        Assert.Contains("dangerousOp()", msg);
        Assert.Contains("\"dangerous\"", msg);
        Assert.Contains("hasn't been granted", msg);
    }

    [Fact]
    public void Empty_Capabilities_List_Denies_All()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("dangerousOp", _ =>
            JsonDocument.Parse("\"ok\"").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithCapability, new RuntimeOptions
        {
            HostBindings = bindings,
            Capabilities = []
        });

        var result = rt.Execute("try { dangerousOp(); 'no error' } catch(e) { 'denied' }");
        Assert.Equal("denied", result.Value.GetString());
    }

    [Fact]
    public void Wrong_Capability_Still_Denied()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("dangerousOp", _ =>
            JsonDocument.Parse("\"ok\"").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithCapability, new RuntimeOptions
        {
            HostBindings = bindings,
            Capabilities = ["wrong-capability"]
        });

        var result = rt.Execute("try { dangerousOp(); 'no error' } catch(e) { 'denied' }");
        Assert.Equal("denied", result.Value.GetString());
    }
}
