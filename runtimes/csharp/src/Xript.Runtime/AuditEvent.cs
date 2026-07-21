namespace Xript.Runtime;

/// <summary>
/// Whether an audit record describes an allowed invocation or a refusal on capability grounds.
/// </summary>
public enum AuditDecision
{
    Invoke,
    Denied,
}

/// <summary>
/// A single capability-decision audit record. <c>Mod</c> and <c>Hook</c> are set only on
/// <see cref="AuditDecision.Denied"/> records raised for a mod's hook fill.
/// </summary>
public sealed record AuditEvent(
    string Binding,
    string? Capability,
    double AtMs,
    AuditDecision Decision = AuditDecision.Invoke,
    string? Mod = null,
    string? Hook = null);
