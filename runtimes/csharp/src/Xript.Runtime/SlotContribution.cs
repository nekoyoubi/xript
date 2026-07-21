using Xript.Runtime.Fragments;

namespace Xript.Runtime;

public sealed record SlotContribution(
    string ModName,
    string FragmentId,
    string Slot,
    string Format,
    int Priority)
{
    /// <summary>
    /// Whether the host mounts an HTML string or the fragment tree. A host-declared
    /// vocabulary has no HTML projection, so its contributions are always trees.
    /// </summary>
    public FragmentContentType ContentType { get; init; } = FragmentContentType.Html;
}
