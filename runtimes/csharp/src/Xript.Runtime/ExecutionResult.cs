using System.Text.Json;

namespace Xript.Runtime;

public record ExecutionResult(JsonElement Value, double DurationMs);
