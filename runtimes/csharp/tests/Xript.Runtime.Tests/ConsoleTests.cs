using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

public class ConsoleTests
{
    [Fact]
    public void Routes_Console_Log()
    {
        var logs = new List<string>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler { Log = msg => logs.Add(msg) }
        });

        rt.Execute("console.log('hello from sandbox')");

        Assert.Single(logs);
        Assert.Equal("hello from sandbox", logs[0]);
    }

    [Fact]
    public void Routes_Console_Warn()
    {
        var warns = new List<string>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler { Warn = msg => warns.Add(msg) }
        });

        rt.Execute("console.warn('caution')");

        Assert.Single(warns);
        Assert.Equal("caution", warns[0]);
    }

    [Fact]
    public void Routes_Console_Error()
    {
        var errors = new List<string>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler { Error = msg => errors.Add(msg) }
        });

        rt.Execute("console.error('bad things')");

        Assert.Single(errors);
        Assert.Equal("bad things", errors[0]);
    }

    [Fact]
    public void Console_Joins_Multiple_Args()
    {
        var logs = new List<string>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler { Log = msg => logs.Add(msg) }
        });

        rt.Execute("console.log('hello', 'world', 42)");

        Assert.Single(logs);
        Assert.Equal("hello world 42", logs[0]);
    }
}
