namespace Xript.Runtime;

public class InvokeException : Exception
{
    public string Export { get; }

    public InvokeException(string export, string message)
        : base(message)
    {
        Export = export;
    }
}
