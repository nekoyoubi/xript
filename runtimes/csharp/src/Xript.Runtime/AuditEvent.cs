namespace Xript.Runtime;

public sealed record AuditEvent(string Binding, string? Capability, double AtMs);
