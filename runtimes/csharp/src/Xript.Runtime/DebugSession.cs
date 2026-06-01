using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime.Debugger;

namespace Xript.Runtime;

public sealed class DebugSession
{
    public const int ThreadId = 1;

    private readonly Engine _engine;
    private readonly DebugHandler _handler;
    private readonly DebugOptions _options;

    private readonly Dictionary<string, List<Breakpoint>> _breakpointsBySource = new();
    private int _breakpointIdCounter;

    private readonly object _gate = new();
    private DebugInformation? _current;
    private StepMode _pendingResume = StepMode.None;
    private bool _paused;

    private int _variablesRefCounter;
    private readonly Dictionary<int, VariableNode> _variableRegistry = new();

    public DebugFidelity Fidelity => DebugFidelity.Native;

    internal DebugSession(Engine engine, DebugOptions options)
    {
        _engine = engine;
        _options = options;
        _handler = engine.Debugger;
        _handler.BreakPoints.Active = true;
        _handler.Break += OnBreak;
        _handler.Step += OnStep;
    }

    public IReadOnlyList<Breakpoint> SetBreakpoints(string source, IReadOnlyList<SourceBreakpoint> breakpoints)
    {
        lock (_gate)
        {
            ClearBreakpointsInternal(source);

            var created = new List<Breakpoint>();
            foreach (var sb in breakpoints)
            {
                var column = sb.Column ?? 0;
                _handler.BreakPoints.Set(new BreakPoint(source, sb.Line, column, sb.Condition));

                var bp = new Breakpoint(
                    ++_breakpointIdCounter,
                    Verified: true,
                    Line: sb.Line,
                    Source: source,
                    Column: sb.Column);
                created.Add(bp);
            }

            _breakpointsBySource[source] = created;

            foreach (var bp in created)
                _options.OnBreakpointChanged?.Invoke(bp);

            return created;
        }
    }

    public void ClearBreakpoints(string source)
    {
        lock (_gate)
        {
            ClearBreakpointsInternal(source);
            _breakpointsBySource.Remove(source);
        }
    }

    private void ClearBreakpointsInternal(string source)
    {
        if (!_breakpointsBySource.TryGetValue(source, out var existing))
            return;

        foreach (var bp in existing)
            _handler.BreakPoints.RemoveAt(new BreakLocation(source, bp.Line, bp.Column ?? 0));
    }

    public void Pause()
    {
        lock (_gate)
            _pausePending = true;
    }

    private bool _pausePending;

    public void Continue() => Resume(StepMode.None);

    public void Resume() => Resume(StepMode.None);

    public void StepIn() => Resume(StepMode.Into);

    public void StepOver() => Resume(StepMode.Over);

    public void StepOut() => Resume(StepMode.Out);

    private void Resume(StepMode mode)
    {
        lock (_gate)
        {
            if (!_paused)
                return;
            _pendingResume = mode;
            _stepActive = mode != StepMode.None;
            _paused = false;
        }

        _options.OnContinued?.Invoke(ThreadId);
    }

    private bool _stepActive;

    public IReadOnlyList<StackFrame> StackTrace()
    {
        lock (_gate)
        {
            if (_current is null)
                return [];

            var frames = new List<StackFrame>();
            var stack = _current.CallStack;
            for (var i = 0; i < stack.Count; i++)
            {
                var frame = stack[i];
                var loc = frame.Location;
                var name = string.IsNullOrEmpty(frame.FunctionName) ? "(anonymous)" : frame.FunctionName;
                frames.Add(new StackFrame(
                    Id: i,
                    Name: name,
                    Line: loc.Start.Line,
                    Column: loc.Start.Column + 1,
                    Source: loc.SourceFile ?? ""));
            }

            return frames;
        }
    }

    public IReadOnlyList<Scope> Scopes(int frameId)
    {
        lock (_gate)
        {
            if (_current is null || frameId < 0 || frameId >= _current.CallStack.Count)
                return [];

            var frame = _current.CallStack[frameId];
            var chain = frame.ScopeChain;
            var scopes = new List<Scope>();

            foreach (var scope in chain)
            {
                var name = MapScopeName(scope.ScopeType);
                var node = new VariableNode(ScopeChainNode: scope);
                var reference = ++_variablesRefCounter;
                _variableRegistry[reference] = node;
                scopes.Add(new Scope(name, reference, Expensive: scope.ScopeType == DebugScopeType.Global));
            }

            return scopes;
        }
    }

    public IReadOnlyList<Variable> Variables(int variablesReference)
    {
        lock (_gate)
        {
            if (!_variableRegistry.TryGetValue(variablesReference, out var node))
                return [];

            if (node.ScopeChainNode is { } scope)
                return EnumerateScope(scope);

            if (node.ObjectValue is { } obj)
                return EnumerateObject(obj);

            return [];
        }
    }

    public Variable Evaluate(string expression, int? frameId = null)
    {
        lock (_gate)
        {
            if (_current is null)
                return new Variable("error", "evaluate is only available while paused", 0, "unsupported");

            try
            {
                var value = _handler.Evaluate(expression);
                return ToVariable("result", value);
            }
            catch (Exception ex)
            {
                return new Variable("error", ex.Message, 0, "unsupported");
            }
        }
    }

    internal void NotifyTerminated()
    {
        _options.OnTerminated?.Invoke();
    }

    private StepMode OnBreak(object sender, DebugInformation info)
    {
        var hit = ResolveHitBreakpoints(info);
        var reason = info.PauseType == PauseType.DebuggerStatement ? "breakpoint"
            : hit.Length > 0 ? "breakpoint"
            : "pause";
        return EnterPause(info, reason, hit.Length > 0 ? hit : null);
    }

    private StepMode OnStep(object sender, DebugInformation info)
    {
        if (_firstStep)
        {
            _firstStep = false;
            if (_options.StopOnEntry)
                return EnterPause(info, "entry", null);
        }

        bool pauseRequested;
        lock (_gate)
        {
            pauseRequested = _pausePending;
            _pausePending = false;
        }

        if (pauseRequested)
            return EnterPause(info, "pause", null);

        var hit = ResolveHitBreakpoints(info);
        if (hit.Length > 0)
            return EnterPause(info, "breakpoint", hit);

        bool stepActive;
        lock (_gate)
        {
            stepActive = _stepActive;
            _stepActive = false;
        }

        if (stepActive)
            return EnterPause(info, "step", null);

        return StepMode.None;
    }

    private bool _firstStep = true;

    private StepMode EnterPause(DebugInformation info, string reason, int[]? hitBreakpointIds)
    {
        lock (_gate)
        {
            _current = info;
            _paused = true;
            _pendingResume = StepMode.None;
            ResetRegistries();
        }

        _options.OnStopped?.Invoke(new StoppedEvent(reason, ThreadId, hitBreakpointIds));

        StepMode resume;
        lock (_gate)
        {
            resume = _pendingResume;
            _paused = false;
            _current = null;
            ResetRegistries();
        }

        return resume;
    }

    private int[] ResolveHitBreakpoints(DebugInformation info)
    {
        if (info.BreakPoint is null)
            return [];

        var loc = info.BreakPoint.Location;
        if (loc.Source is null || !_breakpointsBySource.TryGetValue(loc.Source, out var bps))
            return [];

        return bps
            .Where(b => b.Line == loc.Line)
            .Select(b => b.Id)
            .ToArray();
    }

    private void ResetRegistries()
    {
        _variablesRefCounter = 0;
        _variableRegistry.Clear();
    }

    private List<Variable> EnumerateScope(DebugScope scope)
    {
        var vars = new List<Variable>();
        foreach (var name in scope.BindingNames)
        {
            JsValue? value;
            try
            {
                value = scope.GetBindingValue(name);
            }
            catch
            {
                continue;
            }
            if (value is null) continue;
            vars.Add(ToVariable(name, value));
        }
        return vars;
    }

    private List<Variable> EnumerateObject(ObjectInstance obj)
    {
        var vars = new List<Variable>();
        foreach (var key in obj.GetOwnPropertyKeys())
        {
            var name = key.ToString();
            if (name is null) continue;
            JsValue? value;
            try
            {
                value = obj.Get(name);
            }
            catch
            {
                continue;
            }
            if (value is null) continue;
            vars.Add(ToVariable(name, value));
        }
        return vars;
    }

    private Variable ToVariable(string name, JsValue value)
    {
        var (display, type, expandable) = Describe(value);
        var reference = 0;
        if (expandable && value is ObjectInstance objInstance)
        {
            reference = ++_variablesRefCounter;
            _variableRegistry[reference] = new VariableNode(ObjectValue: objInstance);
        }
        return new Variable(name, display, reference, type);
    }

    private static (string Display, string Type, bool Expandable) Describe(JsValue value)
    {
        if (value.IsUndefined())
            return ("undefined", "undefined", false);
        if (value.IsNull())
            return ("null", "object", false);
        if (value.IsBoolean())
            return (value.AsBoolean() ? "true" : "false", "boolean", false);
        if (value.IsNumber())
            return (value.AsNumber().ToString("R"), "number", false);
        if (value.IsString())
            return ($"\"{value.AsString()}\"", "string", false);

        if (value.IsCallable())
            return ("function", "function", false);

        if (value.IsArray())
            return ("Array", "array", true);

        if (value is ObjectInstance)
            return ("Object", "object", true);

        return (value.ToString(), "object", false);
    }

    private static string MapScopeName(DebugScopeType type) => type switch
    {
        DebugScopeType.Global => "Global",
        DebugScopeType.Closure => "Closure",
        _ => "Local",
    };

    private readonly record struct VariableNode(
        DebugScope? ScopeChainNode = null,
        ObjectInstance? ObjectValue = null);
}
