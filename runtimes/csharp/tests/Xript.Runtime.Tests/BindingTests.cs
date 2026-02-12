using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class BindingTests
{
    [Fact]
    public void Calls_Host_Function()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("add", args =>
        {
            var a = args[0].GetDouble();
            var b = args[1].GetDouble();
            return JsonDocument.Parse((a + b).ToString()).RootElement.Clone();
        });

        using var rt = XriptRuntime.Create(TestManifests.WithBinding, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("add(3, 4)");
        Assert.Equal(7, result.Value.GetDouble());
    }

    [Fact]
    public void Host_Function_Receives_String_Args()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("add", args =>
        {
            var name = args[0].GetString();
            return JsonDocument.Parse($"\"{name}!\"").RootElement.Clone();
        });

        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.1",
                "name": "test",
                "bindings": {
                    "add": { "description": "echoes" }
                }
            }
            """, new RuntimeOptions { HostBindings = bindings });

        var result = rt.Execute("add('hello')");
        Assert.Equal("hello!", result.Value.GetString());
    }

    [Fact]
    public void Host_Function_Errors_Become_Exceptions()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("fail", _ => throw new Exception("intentional error"));

        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.1",
                "name": "test",
                "bindings": {
                    "fail": { "description": "always fails" }
                }
            }
            """, new RuntimeOptions { HostBindings = bindings });

        var result = rt.Execute("try { fail(); 'no error' } catch(e) { e.message }");
        Assert.Equal("intentional error", result.Value.GetString());
    }

    [Fact]
    public void Missing_Binding_Throws()
    {
        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.1",
                "name": "test",
                "bindings": {
                    "notProvided": { "description": "missing" }
                }
            }
            """);

        var result = rt.Execute("try { notProvided(); 'no error' } catch(e) { e.message }");
        Assert.Contains("not provided", result.Value.GetString());
    }

    [Fact]
    public void Namespace_Binding_Works()
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

        var name = rt.Execute("player.getName()");
        Assert.Equal("Hero", name.Value.GetString());

        var health = rt.Execute("player.getHealth()");
        Assert.Equal(100, health.Value.GetInt64());
    }

    [Fact]
    public void Missing_Namespace_Member_Throws()
    {
        using var rt = XriptRuntime.Create(TestManifests.WithNamespace);

        var result = rt.Execute("try { player.getName(); 'no error' } catch(e) { e.message }");
        Assert.Contains("not provided", result.Value.GetString());
    }

    [Fact]
    public void Namespace_Objects_Are_Frozen()
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

        var result = rt.Execute("Object.isFrozen(player)");
        Assert.True(result.Value.GetBoolean());
    }

    [Fact]
    public void Host_Function_Returns_Object()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("add", _ =>
            JsonDocument.Parse("""{"x": 1, "y": 2}""").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithBinding, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("var r = add(); r.x + r.y");
        Assert.Equal(3, result.Value.GetInt64());
    }

    [Fact]
    public void Host_Function_Returns_Array()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("add", _ =>
            JsonDocument.Parse("[1, 2, 3]").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithBinding, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("add().length");
        Assert.Equal(3, result.Value.GetInt64());
    }

    [Fact]
    public void Host_Function_Returns_Null()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("add", _ =>
            JsonDocument.Parse("null").RootElement.Clone());

        using var rt = XriptRuntime.Create(TestManifests.WithBinding, new RuntimeOptions
        {
            HostBindings = bindings
        });

        var result = rt.Execute("add()");
        Assert.Equal(JsonValueKind.Null, result.Value.ValueKind);
    }
}
