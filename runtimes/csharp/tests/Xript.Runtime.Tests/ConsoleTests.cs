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

    [Fact]
    public void Console_Info_Routes_To_Log_When_Info_Unset()
    {
        var logs = new List<string>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler { Log = msg => logs.Add(msg) }
        });

        rt.Execute("console.info('an info line')");

        Assert.Single(logs);
        Assert.Equal("an info line", logs[0]);
    }

    [Fact]
    public void Console_Debug_And_Trace_Default_NoOp()
    {
        var logs = new List<string>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler { Log = msg => logs.Add(msg) }
        });

        rt.Execute("console.debug('d'); console.trace('t')");

        Assert.Empty(logs);
    }

    [Fact]
    public void Console_Debug_And_Trace_Route_When_Set()
    {
        var debugs = new List<string>();
        var traces = new List<string>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler
            {
                Debug = msg => debugs.Add(msg),
                Trace = msg => traces.Add(msg)
            }
        });

        rt.Execute("console.debug('d'); console.trace('t')");

        Assert.Equal("d", Assert.Single(debugs));
        Assert.Equal("t", Assert.Single(traces));
    }

    [Fact]
    public void Console_OnLog_Receives_All_Severities()
    {
        var events = new List<(LogSeverity, string)>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            Console = new ConsoleHandler { OnLog = (sev, msg) => events.Add((sev, msg)) }
        });

        rt.Execute("console.trace('a'); console.debug('b'); console.log('c'); console.info('d'); console.warn('e'); console.error('f')");

        Assert.Equal(6, events.Count);
        Assert.Equal((LogSeverity.Trace, "a"), events[0]);
        Assert.Equal((LogSeverity.Debug, "b"), events[1]);
        Assert.Equal((LogSeverity.Info, "c"), events[2]);
        Assert.Equal((LogSeverity.Info, "d"), events[3]);
        Assert.Equal((LogSeverity.Warn, "e"), events[4]);
        Assert.Equal((LogSeverity.Error, "f"), events[5]);
    }
}
