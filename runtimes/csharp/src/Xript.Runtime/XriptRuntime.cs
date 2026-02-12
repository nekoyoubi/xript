using System.Text.Json;

namespace Xript.Runtime;

public sealed class XriptRuntime : IDisposable
{
    private readonly Sandbox _sandbox;

    public Manifest Manifest { get; }

    private XriptRuntime(Manifest manifest, Sandbox sandbox)
    {
        Manifest = manifest;
        _sandbox = sandbox;
    }

    public static XriptRuntime Create(string manifestJson, RuntimeOptions? options = null)
    {
        var manifest = JsonSerializer.Deserialize<Manifest>(manifestJson)
            ?? throw new ManifestValidationException([new("/", "manifest deserialized to null")]);
        return Build(manifest, options ?? new());
    }

    public static XriptRuntime CreateFromFile(string path, RuntimeOptions? options = null)
    {
        var json = File.ReadAllText(path);
        return Create(json, options);
    }

    public static XriptRuntime CreateFromValue(JsonDocument doc, RuntimeOptions? options = null)
    {
        var manifest = doc.RootElement.Deserialize<Manifest>()
            ?? throw new ManifestValidationException([new("/", "manifest deserialized to null")]);
        return Build(manifest, options ?? new());
    }

    public ExecutionResult Execute(string code) =>
        _sandbox.Execute(code);

    public JsonElement[] FireHook(string hookName, FireHookOptions? options = null) =>
        _sandbox.FireHook(hookName, options);

    public void Dispose() =>
        _sandbox.Dispose();

    private static XriptRuntime Build(Manifest manifest, RuntimeOptions options)
    {
        ManifestValidator.Validate(manifest);
        var sandbox = new Sandbox(manifest, options);
        return new XriptRuntime(manifest, sandbox);
    }
}
