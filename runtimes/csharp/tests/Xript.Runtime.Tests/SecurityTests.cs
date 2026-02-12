using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class SecurityTests
{
    [Fact]
    public void Blocks_Eval()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var result = rt.Execute("typeof eval");
        Assert.Equal("undefined", result.Value.GetString());
    }

    [Fact]
    public void Blocks_Function_Constructor()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var result = rt.Execute("try { Function('return 1')(); 'no error' } catch(e) { 'blocked' }");
        Assert.Equal("blocked", result.Value.GetString());
    }

    [Fact]
    public void Process_Is_Undefined()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var result = rt.Execute("typeof process");
        Assert.Equal("undefined", result.Value.GetString());
    }

    [Fact]
    public void Require_Is_Undefined()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var result = rt.Execute("typeof require");
        Assert.Equal("undefined", result.Value.GetString());
    }

    [Fact]
    public void Cannot_Modify_Frozen_Namespace()
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("player", new Dictionary<string, HostFunction>
        {
            ["getName"] = _ => JsonDocument.Parse("\"Hero\"").RootElement.Clone(),
            ["getHealth"] = _ => JsonDocument.Parse("100").RootElement.Clone()
        });

        using var rt = XriptRuntime.Create(TestManifests.WithNamespace, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("""
            try { player.hack = function() {}; 'modified' } catch(e) { 'blocked' }
            """);
        Assert.Equal("blocked", result.Value.GetString());
    }

    [Fact]
    public void Cannot_Delete_Namespace_Member()
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("player", new Dictionary<string, HostFunction>
        {
            ["getName"] = _ => JsonDocument.Parse("\"Hero\"").RootElement.Clone(),
            ["getHealth"] = _ => JsonDocument.Parse("100").RootElement.Clone()
        });

        using var rt = XriptRuntime.Create(TestManifests.WithNamespace, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("""
            try { delete player.getName; 'deleted' } catch(e) { 'blocked' }
            """);
        Assert.Equal("blocked", result.Value.GetString());
    }

    [Fact]
    public void Standard_Builtins_Available()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        Assert.Equal(5L, rt.Execute("Math.max(1, 5, 3)").Value.GetInt64());
        Assert.Equal("{\"a\":1}", rt.Execute("JSON.stringify({a:1})").Value.GetString());
        Assert.True(rt.Execute("Array.isArray([1,2])").Value.GetBoolean());
        Assert.Equal("number", rt.Execute("typeof Date.now()").Value.GetString());
    }

    [Fact]
    public void Fetch_Not_Available()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var result = rt.Execute("typeof fetch");
        Assert.Equal("undefined", result.Value.GetString());
    }
}
