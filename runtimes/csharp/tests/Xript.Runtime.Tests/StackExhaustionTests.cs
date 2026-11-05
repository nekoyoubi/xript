using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Plain script code that exhausts the stack throws a catchable error inside the sandbox; it
/// never overflows the native stack and ends the host process.
/// </summary>
public class StackExhaustionTests
{
    public static TheoryData<int, string> CorpusCases()
    {
        var data = new TheoryData<int, string>();
        var cases = Corpus()["cases"]!.AsArray();
        for (var i = 0; i < cases.Count; i++)
            data.Add(i, cases[i]!["name"]!.GetValue<string>());
        return data;
    }

    /// <summary><c>spec/stack-tests.json</c>: each case ends caught or ok, and the runtime stays usable and disposes.</summary>
    [Theory]
    [MemberData(nameof(CorpusCases))]
    public void Matches_The_Shared_Stack_Corpus(int index, string name)
    {
        var corpus = Corpus();
        var script = corpus["cases"]!.AsArray()[index]!["script"]!.GetValue<string>();
        var rt = XriptRuntime.Create(corpus["manifest"]!.ToJsonString());
        var outcome = rt.Execute(corpus["template"]!.GetValue<string>().Replace("SCRIPT", script)).Value.GetString();
        Assert.True(outcome is "caught" or "ok", $"{name}: got {outcome}");
        Assert.Equal(corpus["afterExpected"]!.GetValue<int>(), rt.Execute(corpus["after"]!.GetValue<string>()).Value.GetInt32());
        rt.Dispose();
    }

    private static System.Text.Json.Nodes.JsonObject Corpus()
    {
        var dir = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(dir, "spec", "stack-tests.json")))
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                ?? throw new FileNotFoundException("could not locate spec/stack-tests.json from the test output directory");
        return System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "spec", "stack-tests.json")))!.AsObject();
    }

    [Theory]
    [InlineData("function f(n) { return f(n + 1) + 1; } f(0);", "RangeError")]
    [InlineData("var o = { get g() { return this.g + 1; } }; o.g;", "RangeError")]
    [InlineData("function C() { new C(); } new C();", "RangeError")]
    [InlineData("var v = 0; for (var i = 0; i < 100000; i++) v = { d: v }; JSON.stringify(v);", "RangeError")]
    [InlineData("var v = 0; for (var i = 0; i < 100000; i++) v = [v]; String(v);", "RangeError")]
    [InlineData("JSON.parse('['.repeat(100000) + ']'.repeat(100000));", "SyntaxError")]
    public void Exhausting_The_Stack_Throws_A_Catchable_Error(string body, string errorName)
    {
        using var rt = XriptRuntime.Create("""{ "xript": "0.10", "name": "stack-probe", "limits": { "timeout_ms": 60000 } }""");
        var caught = rt.Execute($"(function () {{ try {{ {body} return 'returned'; }} catch (e) {{ return e.name; }} }})()").Value.GetString();
        Assert.Equal(errorName, caught);
        Assert.Equal(2, rt.Execute("1 + 1").Value.GetInt32());
    }

    [Fact]
    public void Exhausting_The_Stack_Inside_A_Crossing_Value_Fails_The_Call_Catchably()
    {
        var bindings = new HostBindings();
        bindings.AddFunction("sink", _ => XriptValue.Undefined);
        using var rt = XriptRuntime.Create(
            """{ "xript": "0.10", "name": "stack-probe", "bindings": { "sink": { "description": "Takes a value." } } }""",
            new RuntimeOptions { HostBindings = bindings, ValueFidelity = true });
        var caught = rt.Execute("(function () { function f(n) { return f(n + 1) + 1; } try { sink({ get g() { return f(0); } }); return 'crossed'; } catch (e) { return e.name; } })()").Value.GetString();
        Assert.Equal("RangeError", caught);
    }
}
