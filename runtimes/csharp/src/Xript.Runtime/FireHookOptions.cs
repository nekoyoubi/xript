using System.Text.Json;

namespace Xript.Runtime;

public record FireHookOptions
{
    public string? Phase { get; init; }
    public JsonElement? Data { get; init; }
}
