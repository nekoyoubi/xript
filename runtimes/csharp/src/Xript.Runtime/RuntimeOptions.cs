using System.Threading;
using Xript.Runtime.Fragments;

namespace Xript.Runtime;

/// <summary>A vocabulary finding carrying the fragment that produced it.</summary>
public sealed record FragmentDiagnosticEvent(string FragmentId, FragmentDiagnostic Diagnostic);

public class RuntimeOptions
{
    public HostBindings HostBindings { get; set; } = new();
    public List<string> Capabilities { get; set; } = [];
    public IReadOnlyDictionary<string, string> Libraries { get; set; } = new Dictionary<string, string>();
    public ConsoleHandler Console { get; set; } = new();
    public CancellationToken Cancellation { get; set; } = CancellationToken.None;
    public Action<AuditEvent>? Audit { get; set; }
    public ExecutionLimits? HardLimits { get; set; }
    public IReadOnlyDictionary<string, string> RolePreferences { get; set; } = new Dictionary<string, string>();

    /// <summary>
    /// Which mod wins a bare-id command lookup, keyed by command id or by slot id. A
    /// qualified lookup (<c>mod:id</c>) is an address and ignores these.
    /// </summary>
    public IReadOnlyDictionary<string, string> CommandPreferences { get; set; } = new Dictionary<string, string>();
    public DebugOptions? Debug { get; set; }

    /// <summary>
    /// Promotes an unknown node under a built-in HTML vocabulary from a warning to an
    /// error, refusing the fragment. HTML's tag surface is open and externally defined, so
    /// the allowlist drops unknown tags by default; a host wanting the stricter contract opts in.
    /// </summary>
    public bool StrictHtmlVocabulary { get; set; }

    /// <summary>
    /// Refuse to construct the runtime when the manifest declares a binding the host did not
    /// supply, instead of installing a stub that throws only once a mod calls it. Off by
    /// default: a host may under-supply deliberately. The missing set is available from
    /// <c>XriptRuntime.MissingBindings</c> either way.
    /// </summary>
    public bool StrictBindings { get; set; }

    /// <summary>Receives every vocabulary finding from fragment sanitization and from the command buffer.</summary>
    public Action<FragmentDiagnosticEvent>? OnFragmentDiagnostic { get; set; }
}
