namespace Xript.Runtime;

/// <summary>
/// Thrown on the host when a callback a script passed to a binding cannot produce a value.
/// <see cref="Reason"/> is <c>threw</c> (the script function threw; the message is the thrown
/// error's own message), <c>expired</c> (the binding call already returned, the callback was
/// called from another thread, or a retained callback's marker crossed into a runtime or mod it
/// does not belong to), <c>promise</c> (it returned a promise), <c>limit</c> (the script ran out
/// of budget inside it), or <c>released</c> (the host released this retained callback). Letting a
/// <c>threw</c> exception escape the binding rethrows the script's own error.
/// </summary>
public sealed class CallbackException : Exception
{
    internal const string OffThread = "off-thread";
    internal const string Foreign = "foreign";

    public string Binding { get; }

    public string Reason { get; }

    /// <summary>The thrown error's <c>name</c>, for <c>threw</c>.</summary>
    public string? ScriptErrorName { get; }

    internal CallbackException(
        string binding, string reason, string? scriptErrorName = null, string? scriptMessage = null, string? detail = null)
        : base(MessageFor(binding, reason, scriptMessage, detail))
    {
        Binding = binding;
        Reason = reason;
        ScriptErrorName = scriptErrorName;
    }

    private static string MessageFor(string binding, string reason, string? scriptMessage, string? detail) => reason switch
    {
        "threw" => scriptMessage ?? "callback threw",
        "expired" => detail switch
        {
            OffThread => $"{binding}(): callback expired; a retained callback can only be called on its runtime's thread",
            Foreign => $"{binding}(): callback expired; a retained callback crosses back only into the runtime and mod that supplied it",
            _ => $"{binding}(): callback expired; a callback passed to a binding can only be called while that binding call is running",
        },
        "promise" => $"{binding}(): callback returned a promise; callbacks passed to a binding are synchronous and must return a settled value",
        "released" => $"{binding}(): callback released; the host released this retained callback",
        _ => $"{binding}(): callback stopped by the calling script's execution limit",
    };
}
