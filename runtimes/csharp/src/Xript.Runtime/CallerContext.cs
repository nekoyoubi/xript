namespace Xript.Runtime;

/// <summary>
/// Which mod is running right now, for one runtime. Pushed while a mod's entry runs, while an
/// export a mod owns is invoked, while each hook and event handler a mod registered runs, and
/// while a retained callback runs on behalf of the mod that supplied it. <c>null</c> is code the
/// host ran directly.
/// </summary>
internal sealed class CallerContext
{
    private readonly List<string?> _stack = [];
    private readonly object _gate = new();

    /// <summary>The mod running right now, or <c>null</c> for host-run code.</summary>
    public string? Current
    {
        get
        {
            lock (_gate)
                return _stack.Count == 0 ? null : _stack[^1];
        }
    }

    /// <summary>Runs as <paramref name="modId"/> until the returned frame is disposed.</summary>
    public IDisposable Enter(string? modId)
    {
        Push(modId);
        return new Frame(this);
    }

    internal void Push(string? modId)
    {
        lock (_gate)
            _stack.Add(string.IsNullOrEmpty(modId) ? null : modId);
    }

    internal void Pop()
    {
        lock (_gate)
        {
            if (_stack.Count > 0)
                _stack.RemoveAt(_stack.Count - 1);
        }
    }

    /// <summary>How many frames are open, for <see cref="UnwindTo"/>.</summary>
    internal int Depth
    {
        get
        {
            lock (_gate)
                return _stack.Count;
        }
    }

    /// <summary>
    /// Drops every frame above <paramref name="depth"/>. An execution limit stops a script
    /// without running the <c>finally</c> blocks it was inside, so the outermost entry restores
    /// the stack rather than leave a frame that would misattribute later calls.
    /// </summary>
    internal void UnwindTo(int depth)
    {
        lock (_gate)
        {
            if (_stack.Count > depth)
                _stack.RemoveRange(depth, _stack.Count - depth);
        }
    }

    private sealed class Frame(CallerContext context) : IDisposable
    {
        private bool _popped;

        public void Dispose()
        {
            if (_popped) return;
            _popped = true;
            context.Pop();
        }
    }
}
