namespace Xript.Runtime;

/// <summary>
/// Thrown when a value cannot cross the host boundary: it nests deeper than
/// <see cref="XriptValue.MaxDepth"/> levels, or, with <see cref="RuntimeOptions.ValueFidelity"/>
/// off, it holds a BigInt or a cycle, which JSON has no spelling for. The message is
/// <c>&lt;binding&gt;(): &lt;detail&gt;</c>. A script that meets the same failure in a binding call
/// catches a <c>BindingError</c> carrying that message.
/// </summary>
public sealed class ValueCrossingException : BindingException
{
    /// <summary>The reason, without the binding prefix.</summary>
    public string Detail { get; }

    internal ValueCrossingException(string binding, string detail)
        : base(binding, $"{binding}(): {detail}", composed: true)
    {
        Detail = detail;
    }
}
