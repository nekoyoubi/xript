namespace Xript.Runtime;

public class BindingException : Exception
{
    public string Binding { get; }

    public BindingException(string binding, string message)
        : base($"binding error in `{binding}`: {message}")
    {
        Binding = binding;
    }
}
