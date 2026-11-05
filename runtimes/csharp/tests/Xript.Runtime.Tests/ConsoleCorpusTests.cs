using System.Text.Json.Nodes;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// <c>spec/console-tests.json</c>: a console call never throws, and the message the host's
/// handler receives is each argument rendered the shared way, joined by single spaces.
/// </summary>
public class ConsoleCorpusTests
{
    public static TheoryData<int, string> Cases()
    {
        var data = new TheoryData<int, string>();
        var cases = Corpus()["cases"]!.AsArray();
        for (var i = 0; i < cases.Count; i++)
            data.Add(i, cases[i]!["name"]!.GetValue<string>());
        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Matches_The_Shared_Console_Corpus(int index, string name)
    {
        var corpus = Corpus();
        var testCase = corpus["cases"]!.AsArray()[index]!;
        var logs = new List<(LogSeverity Severity, string Message)>();
        var options = new RuntimeOptions { Console = new ConsoleHandler { OnLog = (severity, message) => logs.Add((severity, message)) } };
        using var rt = XriptRuntime.Create(corpus["manifest"]!.ToJsonString(), options);

        Assert.Equal(corpus["sentinel"]!.GetValue<string>(), rt.Execute(testCase["script"]!.GetValue<string>()).Value.GetString());

        var expected = testCase["logs"]!.AsArray();
        Assert.True(expected.Count == logs.Count, $"{name}: expected {expected.Count} calls, got {logs.Count}");
        for (var i = 0; i < logs.Count; i++)
        {
            Assert.Equal(expected[i]!["severity"]!.GetValue<string>(), Severity(logs[i].Severity));
            Assert.True(Matches(expected[i]!["message"], logs[i].Message), $"{name}: call {i} got {logs[i].Message}");
        }
    }

    [Fact]
    public void A_Timeout_While_Reading_An_Argument_Still_Ends_The_Script()
    {
        var clock = new Helpers.TestClock();
        var bindings = new HostBindings();
        bindings.AddFunction("elapse", clock.ElapseBinding);
        var logs = new List<string>();
        var options = clock.Drive(new RuntimeOptions
        {
            HostBindings = bindings,
            Console = new ConsoleHandler { OnLog = (_, message) => logs.Add(message) },
        });
        using var rt = XriptRuntime.Create(
            $$"""{ "xript": "0.10", "name": "console-limit", "limits": { "timeout_ms": 100 }, "bindings": { {{Helpers.TestClock.ElapseDeclaration}} } }""",
            options);
        var error = Assert.Throws<ExecutionLimitException>(() =>
            rt.Execute("try { console.log({ get g() { while (true) { elapse(10); } } }); } catch (e) {} 'continued'"));
        Assert.Equal("timeout_ms", error.Limit);
        Assert.Empty(logs);
    }

    [Fact]
    public void A_Cancellation_While_Reading_An_Argument_Still_Ends_The_Script()
    {
        using var cancellation = new CancellationTokenSource();
        var bindings = new HostBindings();
        bindings.AddFunction("cancel", _ =>
        {
            cancellation.Cancel();
            return XriptValue.Undefined;
        });
        using var rt = XriptRuntime.Create(
            """{ "xript": "0.10", "name": "console-cancel", "limits": { "timeout_ms": 600000 }, "bindings": { "cancel": { "description": "Cancels the run." } } }""",
            new RuntimeOptions { HostBindings = bindings, Cancellation = cancellation.Token });
        Assert.Throws<ExecutionCancelledException>(() =>
            rt.Execute("try { console.log({ get g() { cancel(); while (true) {} } }); } catch (e) {} 'continued'"));
    }

    [Fact]
    public void A_Throwing_Host_Handler_Is_Contained()
    {
        var options = new RuntimeOptions { Console = new ConsoleHandler { OnLog = (_, _) => throw new InvalidOperationException("sink down") } };
        using var rt = XriptRuntime.Create("""{ "xript": "0.10", "name": "console-sink" }""", options);
        Assert.Equal("continued", rt.Execute("console.error('x'); 'continued'").Value.GetString());
    }

    private static string Severity(LogSeverity severity) => severity switch
    {
        LogSeverity.Trace => "trace",
        LogSeverity.Debug => "debug",
        LogSeverity.Info => "info",
        LogSeverity.Warn => "warn",
        _ => "error",
    };

    /// <summary>An exact string, or a <c>{ "$expect": "string" }</c> matcher with an optional <c>prefix</c> and <c>suffix</c>.</summary>
    private static bool Matches(JsonNode? expected, string actual)
    {
        if (expected is JsonObject matcher && matcher["$expect"]?.GetValue<string>() == "string")
            return (matcher["prefix"] is not { } prefix || actual.StartsWith(prefix.GetValue<string>(), StringComparison.Ordinal))
                && (matcher["suffix"] is not { } suffix || actual.EndsWith(suffix.GetValue<string>(), StringComparison.Ordinal));
        return expected?.GetValue<string>() == actual;
    }

    private static JsonObject Corpus()
    {
        var dir = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(dir, "spec", "console-tests.json")))
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                ?? throw new FileNotFoundException("could not locate spec/console-tests.json from the test output directory");
        return JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "spec", "console-tests.json")))!.AsObject();
    }
}
