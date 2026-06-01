using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class DebugProtocolTests
{
    private const string App = """{ "xript": "0.3", "name": "host" }""";

    [Fact]
    public void Debug_Session_Null_When_Not_Configured()
    {
        using var rt = XriptRuntime.Create(App);
        Assert.Null(rt.DebugSession);
    }

    [Fact]
    public void Debug_Session_Present_When_Configured()
    {
        var options = new RuntimeOptions { Debug = new DebugOptions() };
        using var rt = XriptRuntime.Create(App, options);
        Assert.NotNull(rt.DebugSession);
        Assert.Equal(DebugFidelity.Native, rt.DebugSession!.Fidelity);
    }

    [Fact]
    public void Set_Breakpoints_Returns_Verified_Breakpoints()
    {
        var options = new RuntimeOptions { Debug = new DebugOptions() };
        using var rt = XriptRuntime.Create(App, options);

        var bps = rt.DebugSession!.SetBreakpoints("main.js", new[]
        {
            new SourceBreakpoint(2),
            new SourceBreakpoint(4, 1),
        });

        Assert.Equal(2, bps.Count);
        Assert.True(bps[0].Verified);
        Assert.Equal(2, bps[0].Line);
        Assert.Equal("main.js", bps[0].Source);
        Assert.NotEqual(bps[0].Id, bps[1].Id);
        Assert.Equal(1, bps[1].Column);
    }

    [Fact]
    public void Breakpoint_Pauses_And_Emits_Stopped_Event()
    {
        StoppedEvent? stopped = null;
        var options = new RuntimeOptions
        {
            Debug = new DebugOptions
            {
                OnStopped = e =>
                {
                    stopped = e;
                },
            },
        };
        using var rt = XriptRuntime.Create(App, options);
        var session = rt.DebugSession!;
        session.SetBreakpoints("prog.js", new[] { new SourceBreakpoint(3) });

        options.Debug.OnStopped = e =>
        {
            stopped = e;
            session.Continue();
        };

        rt.Execute("var a = 1;\nvar b = 2;\nvar c = a + b;\nvar d = c * 2;", "prog.js");

        Assert.NotNull(stopped);
        Assert.Equal("breakpoint", stopped!.Reason);
        Assert.Equal(DebugSession.ThreadId, stopped.ThreadId);
        Assert.NotNull(stopped.HitBreakpointIds);
        Assert.Single(stopped.HitBreakpointIds!);
    }

    [Fact]
    public void Paused_State_Exposes_Stack_Scopes_And_Variables()
    {
        var seenVars = new List<Variable>();
        IReadOnlyList<StackFrame> frames = [];

        var options = new RuntimeOptions { Debug = new DebugOptions() };
        using var rt = XriptRuntime.Create(App, options);
        var session = rt.DebugSession!;
        session.SetBreakpoints("vars.js", new[] { new SourceBreakpoint(4) });

        options.Debug.OnStopped = _ =>
        {
            frames = session.StackTrace();
            if (frames.Count > 0)
            {
                var scopes = session.Scopes(frames[0].Id);
                Assert.NotEmpty(scopes);
                var globalScope = scopes.FirstOrDefault(s => s.Name == "Global");
                if (globalScope is not null)
                    seenVars.AddRange(session.Variables(globalScope.VariablesReference));
            }
            session.Continue();
        };

        rt.Execute("var x = 10;\nvar y = 20;\nvar z = x + y;\nvar done = true;", "vars.js");

        Assert.NotEmpty(frames);
        Assert.Equal(4, frames[0].Line);
        var x = seenVars.FirstOrDefault(v => v.Name == "x");
        Assert.NotNull(x);
        Assert.Equal("number", x!.Type);
        Assert.Equal("10", x.Value);
    }

    [Fact]
    public void Stop_On_Entry_Pauses_At_First_Statement()
    {
        StoppedEvent? first = null;
        var options = new RuntimeOptions { Debug = new DebugOptions { StopOnEntry = true } };
        using var rt = XriptRuntime.Create(App, options);
        var session = rt.DebugSession!;

        options.Debug.OnStopped = e =>
        {
            first ??= e;
            session.Continue();
        };

        rt.Execute("var a = 1;\nvar b = 2;", "entry.js");

        Assert.NotNull(first);
        Assert.Equal("entry", first!.Reason);
    }

    [Fact]
    public void Step_Over_Advances_Statement_By_Statement()
    {
        var lines = new List<int>();
        var options = new RuntimeOptions { Debug = new DebugOptions { StopOnEntry = true } };
        using var rt = XriptRuntime.Create(App, options);
        var session = rt.DebugSession!;

        options.Debug.OnStopped = _ =>
        {
            var frames = session.StackTrace();
            if (frames.Count > 0)
                lines.Add(frames[0].Line);
            session.StepOver();
        };

        rt.Execute("var a = 1;\nvar b = 2;\nvar c = 3;", "step.js");

        Assert.True(lines.Count >= 3);
        Assert.Equal(1, lines[0]);
    }

    [Fact]
    public void Continued_Event_Fires_On_Resume()
    {
        var continued = 0;
        var options = new RuntimeOptions
        {
            Debug = new DebugOptions { OnContinued = _ => continued++ },
        };
        using var rt = XriptRuntime.Create(App, options);
        var session = rt.DebugSession!;
        session.SetBreakpoints("c.js", new[] { new SourceBreakpoint(2) });

        options.Debug.OnStopped = _ => session.Continue();

        rt.Execute("var a = 1;\nvar b = 2;\nvar c = 3;", "c.js");

        Assert.True(continued >= 1);
    }

    [Fact]
    public void Terminated_Event_Fires_On_Completion()
    {
        var terminated = false;
        var options = new RuntimeOptions
        {
            Debug = new DebugOptions { OnTerminated = () => terminated = true },
        };
        using var rt = XriptRuntime.Create(App, options);

        rt.Execute("var a = 1 + 1;", "t.js");

        Assert.True(terminated);
    }

    [Fact]
    public void Clear_Breakpoints_Removes_Pause()
    {
        var stops = 0;
        var options = new RuntimeOptions { Debug = new DebugOptions() };
        using var rt = XriptRuntime.Create(App, options);
        var session = rt.DebugSession!;
        session.SetBreakpoints("clr.js", new[] { new SourceBreakpoint(2) });
        session.ClearBreakpoints("clr.js");

        options.Debug.OnStopped = _ => { stops++; session.Continue(); };

        rt.Execute("var a = 1;\nvar b = 2;\nvar c = 3;", "clr.js");

        Assert.Equal(0, stops);
    }

    [Fact]
    public void Evaluate_While_Paused_Inspects_Frame()
    {
        Variable? result = null;
        var options = new RuntimeOptions { Debug = new DebugOptions() };
        using var rt = XriptRuntime.Create(App, options);
        var session = rt.DebugSession!;
        session.SetBreakpoints("eval.js", new[] { new SourceBreakpoint(3) });

        options.Debug.OnStopped = _ =>
        {
            result = session.Evaluate("x + 5");
            session.Continue();
        };

        rt.Execute("var x = 7;\nvar y = 8;\nvar z = x + y;", "eval.js");

        Assert.NotNull(result);
        Assert.Equal("12", result!.Value);
    }

    [Fact]
    public void Breakpoint_Changed_Event_Fires_On_Set()
    {
        var changed = new List<Breakpoint>();
        var options = new RuntimeOptions
        {
            Debug = new DebugOptions { OnBreakpointChanged = bp => changed.Add(bp) },
        };
        using var rt = XriptRuntime.Create(App, options);

        rt.DebugSession!.SetBreakpoints("bc.js", new[] { new SourceBreakpoint(1), new SourceBreakpoint(2) });

        Assert.Equal(2, changed.Count);
    }
}
