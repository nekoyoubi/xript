using System.Text.Json.Serialization;

namespace Xript.Runtime;

public sealed record SourceBreakpoint(
    [property: JsonPropertyName("line")] int Line,
    [property: JsonPropertyName("column")] int? Column = null,
    [property: JsonPropertyName("condition")] string? Condition = null);

public sealed record Breakpoint(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("verified")] bool Verified,
    [property: JsonPropertyName("line")] int Line,
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("column")] int? Column = null);

public sealed record StackFrame(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("line")] int Line,
    [property: JsonPropertyName("column")] int Column,
    [property: JsonPropertyName("source")] string Source);

public sealed record Scope(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("variablesReference")] int VariablesReference,
    [property: JsonPropertyName("expensive")] bool Expensive);

public sealed record Variable(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("value")] string Value,
    [property: JsonPropertyName("variablesReference")] int VariablesReference,
    [property: JsonPropertyName("type")] string? Type = null);

public sealed record StoppedEvent(
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("threadId")] int ThreadId,
    [property: JsonPropertyName("hitBreakpointIds")] int[]? HitBreakpointIds = null,
    [property: JsonPropertyName("description")] string? Description = null);

public sealed class DebugOptions
{
    public Action<StoppedEvent>? OnStopped { get; set; }
    public Action<int>? OnContinued { get; set; }
    public Action? OnTerminated { get; set; }
    public Action<Breakpoint>? OnBreakpointChanged { get; set; }

    public bool StopOnEntry { get; set; }

    public DebugFidelity Fidelity => DebugFidelity.Native;
}

public enum DebugFidelity
{
    Native,
    Instrumented,
}
