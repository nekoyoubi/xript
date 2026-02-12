namespace Xript.Runtime;

public class ExecutionLimitException : Exception
{
    public string Limit { get; }

    public ExecutionLimitException(string limit)
        : base($"execution limit exceeded: {limit}")
    {
        Limit = limit;
    }
}
