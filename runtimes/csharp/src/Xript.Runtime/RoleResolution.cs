namespace Xript.Runtime;

public sealed record RoleResolution(string Addon, string Role, IReadOnlyDictionary<string, string> Fns);
