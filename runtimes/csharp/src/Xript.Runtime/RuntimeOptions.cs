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

    /// <summary>
    /// What <c>LoadMod</c> does when a mod's entry cannot run (a script that was not supplied,
    /// or one that throws). Defaults to <see cref="EntryErrorPolicy.Throw"/>.
    /// </summary>
    public EntryErrorPolicy EntryErrors { get; set; } = EntryErrorPolicy.Throw;

    /// <summary>
    /// Receives every load-time <see cref="ModDiagnostic"/>, under either entry error policy.
    /// The same findings land on <see cref="ModInstance.Diagnostics"/>. A throwing callback is
    /// contained and does not change whether a mod loads.
    /// </summary>
    public Action<ModDiagnostic>? OnModDiagnostic { get; set; }

    /// <summary>
    /// Receives each <see cref="Deprecation"/> the runtime raises, at most once per code per
    /// runtime. Without a handler each code is written once to <see cref="System.Console.Error"/>.
    /// A throwing handler is contained. The codes are listed in <c>spec/deprecations.md</c>.
    /// </summary>
    public Action<Deprecation>? OnDeprecation { get; set; }

    /// <summary>
    /// Values cross the host boundary the way the JavaScript runtimes pass them, instead of
    /// the way JSON flattens them: <c>undefined</c>, <c>NaN</c>, <c>Infinity</c>,
    /// <c>-Infinity</c> and <c>-0</c> travel as marker objects (see <see cref="XriptValue"/>)
    /// instead of <c>null</c> (or <c>0</c>, for <c>-0</c>). A script value crossing out is encoded at any depth; a marker crossing in
    /// (a binding's return, a hook or event payload, an export's arguments) is decoded back to
    /// the real value. Integral numbers already reach a .NET host as integers on every path,
    /// with or without this option. Off by default: with it off, every value reaches the host
    /// exactly as it always has.
    /// </summary>
    public bool ValueFidelity { get; set; }
}
