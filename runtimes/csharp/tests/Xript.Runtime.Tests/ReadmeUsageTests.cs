using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

// Mirrors the Usage example in runtimes/csharp/README.md so the front-page snippet cannot drift
// from the real API. Keep this in step with the README block.
public class ReadmeUsageTests
{
    [Fact]
    public void Readme_Usage_Example_Runs()
    {
        var manifest = """
        {
            "xript": "0.8",
            "name": "my-app",
            "bindings": {
                "greet": {
                    "description": "Returns a greeting.",
                    "params": [{ "name": "name", "type": "string" }],
                    "returns": "string"
                }
            }
        }
        """;

        var bindings = new HostBindings();
        bindings.AddFunction("greet", args =>
        {
            var name = args.Length > 0 ? args[0].GetString() : "World";
            return JsonSerializer.SerializeToElement($"Hello, {name}!");
        });

        using var runtime = XriptRuntime.Create(manifest, new RuntimeOptions
        {
            HostBindings = bindings,
            Capabilities = [],
            Console = new ConsoleHandler
            {
                Log = msg => Console.WriteLine(msg),
                Warn = msg => Console.WriteLine($"WARN: {msg}"),
                Error = msg => Console.Error.WriteLine(msg),
            },
        });

        var result = runtime.Execute("greet(\"World\")");
        Assert.Equal("Hello, World!", result.Value.GetString());
    }
}
