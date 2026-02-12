using System.Text.Json;
using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class RuntimeTests
{
    [Fact]
    public void Creates_Runtime_From_Minimal_Manifest()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        Assert.Equal("test-app", rt.Manifest.Name);
        Assert.Equal("0.1", rt.Manifest.Xript);
    }

    [Fact]
    public void Rejects_Invalid_Json()
    {
        Assert.Throws<JsonException>(() => XriptRuntime.Create("not json"));
    }

    [Fact]
    public void Rejects_Empty_Xript_Field()
    {
        var ex = Assert.Throws<ManifestValidationException>(() =>
            XriptRuntime.Create("""{ "xript": "", "name": "test" }"""));

        Assert.Single(ex.Issues, i => i.Path == "/xript");
    }

    [Fact]
    public void Rejects_Empty_Name_Field()
    {
        var ex = Assert.Throws<ManifestValidationException>(() =>
            XriptRuntime.Create("""{ "xript": "0.1", "name": "" }"""));

        Assert.Single(ex.Issues, i => i.Path == "/name");
    }

    [Fact]
    public void Rejects_Missing_Xript_Field()
    {
        var ex = Assert.Throws<ManifestValidationException>(() =>
            XriptRuntime.Create("""{ "name": "test" }"""));

        Assert.Single(ex.Issues, i => i.Path == "/xript");
    }

    [Fact]
    public void Rejects_Missing_Name_Field()
    {
        var ex = Assert.Throws<ManifestValidationException>(() =>
            XriptRuntime.Create("""{ "xript": "0.1" }"""));

        Assert.Single(ex.Issues, i => i.Path == "/name");
    }

    [Fact]
    public void Reports_Multiple_Issues()
    {
        var ex = Assert.Throws<ManifestValidationException>(() =>
            XriptRuntime.Create("""{ "xript": "", "name": "" }"""));

        Assert.Equal(2, ex.Issues.Count);
    }

    [Fact]
    public void Rejects_Invalid_Timeout()
    {
        var ex = Assert.Throws<ManifestValidationException>(() =>
            XriptRuntime.Create("""{ "xript": "0.1", "name": "test", "limits": { "timeout_ms": -1 } }"""));

        Assert.Single(ex.Issues, i => i.Path == "/limits/timeout_ms");
    }

    [Fact]
    public void Rejects_Invalid_Memory()
    {
        var ex = Assert.Throws<ManifestValidationException>(() =>
            XriptRuntime.Create("""{ "xript": "0.1", "name": "test", "limits": { "memory_mb": 0 } }"""));

        Assert.Single(ex.Issues, i => i.Path == "/limits/memory_mb");
    }

    [Fact]
    public void Creates_Runtime_From_JsonDocument()
    {
        using var doc = JsonDocument.Parse(TestManifests.Minimal);
        using var rt = XriptRuntime.CreateFromValue(doc);

        Assert.Equal("test-app", rt.Manifest.Name);
    }

    [Fact]
    public void Creates_Runtime_From_File()
    {
        var tempFile = Path.GetTempFileName();
        try
        {
            File.WriteAllText(tempFile, TestManifests.Minimal);
            using var rt = XriptRuntime.CreateFromFile(tempFile);
            Assert.Equal("test-app", rt.Manifest.Name);
        }
        finally
        {
            File.Delete(tempFile);
        }
    }

    [Fact]
    public void Exposes_Manifest_Properties()
    {
        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.1",
                "name": "my-app",
                "version": "1.0.0",
                "title": "My App",
                "description": "A test app"
            }
            """);

        Assert.Equal("0.1", rt.Manifest.Xript);
        Assert.Equal("my-app", rt.Manifest.Name);
        Assert.Equal("1.0.0", rt.Manifest.Version);
        Assert.Equal("My App", rt.Manifest.Title);
        Assert.Equal("A test app", rt.Manifest.Description);
    }
}
