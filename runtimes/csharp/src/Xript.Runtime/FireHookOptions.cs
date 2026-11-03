using System.Text.Json;

namespace Xript.Runtime;

public record FireHookOptions
{
    /// <summary>
    /// The one phase to fire. <c>null</c> and <c>""</c> both mean no phase: the fire runs the
    /// unphased handlers and then the hook fills.
    /// </summary>
    public string? Phase { get; init; }
    public JsonElement? Data { get; init; }
}
