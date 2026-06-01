using System.Threading;

namespace Xript.Runtime;

public class RuntimeOptions
{
    public HostBindings HostBindings { get; set; } = new();
    public List<string> Capabilities { get; set; } = [];
    public ConsoleHandler Console { get; set; } = new();
    public CancellationToken Cancellation { get; set; } = CancellationToken.None;
    public Action<AuditEvent>? Audit { get; set; }
    public ExecutionLimits? HardLimits { get; set; }
    public IReadOnlyDictionary<string, string> RolePreferences { get; set; } = new Dictionary<string, string>();
    public DebugOptions? Debug { get; set; }
}
