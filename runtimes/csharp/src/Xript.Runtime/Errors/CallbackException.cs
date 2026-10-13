namespace Xript.Runtime;

/// <summary>
/// Thrown on the host when a callback a script passed to a binding cannot produce a value.
/// <see cref="Reason"/> is <c>threw</c> (the script function threw; the message is the thrown
/// error's own message), <c>expired</c> (the binding call already returned, or the callback was
/// called from another thread), <c>promise</c> (it returned a promise), or <c>limit</c> (the
/// calling script ran out of budget inside it). Letting a <c>threw</c> exception escape the
/// binding rethrows the script's own error.
/// </summary>
public sealed class CallbackException : Exception
{
    public string Binding { get; }

    public string Reason { get; }

    /// <summary>The thrown error's <c>name</c>, for <c>threw</c>.</summary>
    public string? ScriptErrorName { get; }

    internal CallbackException(string binding, string reason, string? scriptErrorName = null, string? scriptMessage = null)
        : base(MessageFor(binding, reason, scriptMessage))
    {
        Binding = binding;
        Reason = reason;
        ScriptErrorName = scriptErrorName;
    }

    private static string MessageFor(string binding, string reason, string? scriptMessage) => reason switch
    {
        "threw" => scriptMessage ?? "callback threw",
        "expired" => $"{binding}(): callback expired; a callback passed to a binding can only be called while that binding call is running",
        "promise" => $"{binding}(): callback returned a promise; callbacks passed to a binding are synchronous and must return a settled value",
        _ => $"{binding}(): callback stopped by the calling script's execution limit",
    };
}
