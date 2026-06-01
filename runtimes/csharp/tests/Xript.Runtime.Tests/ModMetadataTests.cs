using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class ModMetadataTests
{
    [Fact]
    public void Family_Field_Round_Trips()
    {
        const string json = """
            {
                "xript": "0.3",
                "name": "acme-tools",
                "version": "1.0.0",
                "family": "acme"
            }
            """;

        var mod = JsonSerializer.Deserialize<ModManifest>(json);
        Assert.NotNull(mod);
        Assert.Equal("acme", mod!.Family);
    }

    [Fact]
    public void Family_Absent_Is_Null()
    {
        const string json = """
            { "xript": "0.3", "name": "plain", "version": "1.0.0" }
            """;

        var mod = JsonSerializer.Deserialize<ModManifest>(json);
        Assert.NotNull(mod);
        Assert.Null(mod!.Family);
    }

    [Fact]
    public void Family_Survives_Validation()
    {
        const string json = """
            {
                "xript": "0.3",
                "name": "acme-core",
                "version": "1.0.0",
                "family": "acme"
            }
            """;

        var mod = FragmentProcessor.ValidateModManifest(json);
        Assert.Equal("acme", mod.Family);
    }
}
