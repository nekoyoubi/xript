using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class ManifestExtendsTests : IDisposable
{
    private readonly string _dir;

    public ManifestExtendsTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "xript-extends-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    private string Write(string name, string content)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllText(path, content);
        return path;
    }

    [Fact]
    public void Merges_Base_Bindings_Into_Child()
    {
        Write("base.json", """
            {
                "xript": "0.1",
                "name": "base-app",
                "bindings": { "baseFn": { "description": "from base" } }
            }
            """);

        var childPath = Write("child.json", """
            {
                "xript": "0.1",
                "extends": "./base.json",
                "name": "child-app",
                "bindings": { "childFn": { "description": "from child" } }
            }
            """);

        var bindings = new HostBindings();
        bindings.AddFunction("baseFn", _ => System.Text.Json.JsonDocument.Parse("\"base\"").RootElement.Clone());
        bindings.AddFunction("childFn", _ => System.Text.Json.JsonDocument.Parse("\"child\"").RootElement.Clone());

        using var rt = XriptRuntime.CreateFromFile(childPath, new RuntimeOptions { HostBindings = bindings });

        Assert.Equal("child-app", rt.Manifest.Name);
        Assert.Equal("base", rt.Execute("baseFn()").Value.GetString());
        Assert.Equal("child", rt.Execute("childFn()").Value.GetString());
    }

    [Fact]
    public void Conflicting_Binding_Id_Errors()
    {
        Write("base.json", """
            {
                "xript": "0.1",
                "name": "base-app",
                "bindings": { "shared": { "description": "from base" } }
            }
            """);

        var childPath = Write("child.json", """
            {
                "xript": "0.1",
                "extends": "./base.json",
                "name": "child-app",
                "bindings": { "shared": { "description": "from child" } }
            }
            """);

        var ex = Assert.Throws<ManifestValidationException>(() => XriptRuntime.CreateFromFile(childPath));
        Assert.Contains("conflicts with extended base", ex.Message);
    }

    [Fact]
    public void Transitive_Extends_Resolves()
    {
        Write("grand.json", """
            {
                "xript": "0.1",
                "name": "grand",
                "bindings": { "grandFn": { "description": "g" } }
            }
            """);

        Write("base.json", """
            {
                "xript": "0.1",
                "extends": "./grand.json",
                "name": "base",
                "bindings": { "baseFn": { "description": "b" } }
            }
            """);

        var childPath = Write("child.json", """
            {
                "xript": "0.1",
                "extends": "./base.json",
                "name": "child",
                "bindings": { "childFn": { "description": "c" } }
            }
            """);

        var resolved = ManifestResolver.Resolve(File.ReadAllText(childPath), _dir);
        Assert.Contains("grandFn", resolved);
        Assert.Contains("baseFn", resolved);
        Assert.Contains("childFn", resolved);
    }

    [Fact]
    public void Cycle_Detection_Errors()
    {
        Write("a.json", """
            { "xript": "0.1", "extends": "./b.json", "name": "a" }
            """);
        var bPath = Write("b.json", """
            { "xript": "0.1", "extends": "./a.json", "name": "b" }
            """);

        var ex = Assert.Throws<ManifestValidationException>(
            () => ManifestResolver.Resolve(File.ReadAllText(bPath), _dir));
        Assert.Contains("circular", ex.Message);
    }

    [Fact]
    public void Slots_Append_From_Base()
    {
        Write("base.json", """
            {
                "xript": "0.1",
                "name": "base",
                "slots": [{ "id": "base-slot", "accepts": ["text/html"] }]
            }
            """);

        var childPath = Write("child.json", """
            {
                "xript": "0.1",
                "extends": "./base.json",
                "name": "child",
                "slots": [{ "id": "child-slot", "accepts": ["text/html"] }]
            }
            """);

        using var rt = XriptRuntime.CreateFromFile(childPath);

        Assert.Equal(2, rt.Manifest.Slots!.Count);
        Assert.Contains(rt.Manifest.Slots, s => s.Id == "base-slot");
        Assert.Contains(rt.Manifest.Slots, s => s.Id == "child-slot");
    }

    [Fact]
    public void Missing_Base_Path_Errors()
    {
        var childPath = Write("child.json", """
            { "xript": "0.1", "extends": "./nope.json", "name": "child" }
            """);

        var ex = Assert.Throws<ManifestValidationException>(() => XriptRuntime.CreateFromFile(childPath));
        Assert.Contains("not found", ex.Message);
    }
}
