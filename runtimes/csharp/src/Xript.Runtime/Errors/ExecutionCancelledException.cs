namespace Xript.Runtime;

public class ExecutionCancelledException : Exception
{
    public ExecutionCancelledException()
        : base("execution was cancelled by the host")
    {
    }
}
