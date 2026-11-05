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
    /// <c>-Infinity</c>, <c>-0</c>, BigInts, strings holding a lone surrogate, cycles, and symbols
    /// that cross as a whole value (not nested) travel as marker objects (see <see cref="XriptValue"/>)
    /// instead of <c>null</c>, <c>0</c>, U+FFFD, or a refusal. A script value crossing out is
    /// encoded at any depth; a marker crossing in (a binding's return, a callback's arguments, a
    /// hook or event payload, an export's arguments) is decoded back to the real value. Integral
    /// numbers already reach a .NET host as integers on every path, with or without this option.
    /// Off by default: with it off, a BigInt or a cyclic value is refused with a
    /// <see cref="ValueCrossingException"/> naming the binding, a lone surrogate becomes U+FFFD,
    /// and every other value reaches the host as JSON would carry it.
    /// </summary>
    public bool ValueFidelity { get; set; }

    /// <summary>
    /// Host events mode, for a host that runs its own event bus. The manifest's top-level
    /// <c>events</c> binding is the script-visible <c>events</c> global in place of the built-in
    /// bus, installed, gated, and sealed like any other binding, so no mod can replace or delete
    /// it. Construction throws a <see cref="HostEventsException"/> when the manifest declares no
    /// such binding. A manifest <c>events</c> catalogue is allowed and is wired to no
    /// script-visible bus. The built-in bus's host API (<see cref="XriptRuntime.Emit"/>,
    /// <see cref="XriptRuntime.CancelOwned"/>, <see cref="XriptRuntime.DeclareEvent"/>) serves no
    /// script in this mode and throws the same exception. Off by default.
    /// </summary>
    public bool HostEvents { get; set; }

    /// <summary>
    /// Replaces the clock every call budget is measured on, in <see cref="System.Diagnostics.Stopwatch"/>
    /// ticks, so a test decides when time passes. With it set, that clock alone ends a call: the
    /// real-time timer and Jint's timeout interval behind the inline deadline are not armed.
    /// </summary>
    internal Func<long>? DeadlineClock { get; set; }
}
