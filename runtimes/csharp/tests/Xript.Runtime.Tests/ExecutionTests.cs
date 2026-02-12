using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class ExecutionTests
{
    [Fact]
    public void Evaluates_Arithmetic()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("2 + 2");

        Assert.Equal(4, result.Value.GetInt64());
        Assert.True(result.DurationMs >= 0);
    }

    [Fact]
    public void Evaluates_String_Concatenation()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("'hello' + ' ' + 'world'");

        Assert.Equal("hello world", result.Value.GetString());
    }

    [Fact]
    public void Evaluates_Boolean()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("true");

        Assert.True(result.Value.GetBoolean());
    }

    [Fact]
    public void Returns_Null_For_Undefined()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("undefined");

        Assert.Equal(JsonValueKind.Null, result.Value.ValueKind);
    }

    [Fact]
    public void Evaluates_Objects()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("({ a: 1, b: 'two' })");

        Assert.Equal(JsonValueKind.Object, result.Value.ValueKind);
        Assert.Equal(1, result.Value.GetProperty("a").GetInt64());
        Assert.Equal("two", result.Value.GetProperty("b").GetString());
    }

    [Fact]
    public void Evaluates_Arrays()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var result = rt.Execute("[1, 2, 3]");

        Assert.Equal(JsonValueKind.Array, result.Value.ValueKind);
        Assert.Equal(3, result.Value.GetArrayLength());
    }

    [Fact]
    public void Supports_Standard_Builtins()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        var result = rt.Execute("Math.max(1, 5, 3)");
        Assert.Equal(5, result.Value.GetInt64());

        var jsonResult = rt.Execute("JSON.stringify({ a: 1 })");
        Assert.Equal("{\"a\":1}", jsonResult.Value.GetString());
    }

    [Fact]
    public void Script_Errors_Throw()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);

        Assert.ThrowsAny<Exception>(() => rt.Execute("throw new Error('boom')"));
    }
}
