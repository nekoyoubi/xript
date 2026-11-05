namespace Xript.Runtime;

public class BindingException : Exception
{
    public string Binding { get; }

    public BindingException(string binding, string message)
        : base($"binding error in `{binding}`: {message}")
    {
        Binding = binding;
    }

    /// <summary>For a subclass that composes its own complete message.</summary>
    private protected BindingException(string binding, string message, bool composed)
        : base(composed ? message : $"binding error in `{binding}`: {message}")
    {
        Binding = binding;
    }
}
