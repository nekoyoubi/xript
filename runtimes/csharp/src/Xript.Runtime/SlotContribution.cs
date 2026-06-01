namespace Xript.Runtime;

public sealed record SlotContribution(
    string ModName,
    string FragmentId,
    string Slot,
    string Format,
    int Priority);
