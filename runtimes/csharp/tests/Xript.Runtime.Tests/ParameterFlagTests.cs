using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// A host reading a parameter declaration sees every flag the schema defines. The flags are
/// descriptive: no runtime checks argument count.
/// </summary>
public class ParameterFlagTests
{
    [Theory]
    [InlineData("""{ "name": "a", "type": "string" }""", false, false)]
    [InlineData("""{ "name": "a", "type": "string", "optional": true }""", true, false)]
    [InlineData("""{ "name": "a", "type": "string", "required": false }""", true, false)]
    [InlineData("""{ "name": "a", "type": "string", "default": "x" }""", true, false)]
    [InlineData("""{ "name": "a", "type": "string", "variadic": true }""", true, true)]
    public void Reads_Optional_And_Variadic(string json, bool optional, bool variadic)
    {
        var param = JsonSerializer.Deserialize<ParameterDef>(json)!;
        Assert.Equal(optional, param.IsOptional);
        Assert.Equal(variadic, param.IsVariadic);
    }

    [Fact]
    public void A_Hook_Declaration_Carries_The_Flags()
    {
        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.10",
                "name": "params",
                "hooks": { "save": { "description": "saves", "params": [
                    { "name": "path", "type": "string", "optional": true },
                    { "name": "rest", "type": "string", "variadic": true }
                ] } }
            }
            """);
        var parameters = rt.Manifest.Hooks!["save"].Params!;
        Assert.True(parameters[0].Optional);
        Assert.True(parameters[1].IsVariadic);
    }
}
