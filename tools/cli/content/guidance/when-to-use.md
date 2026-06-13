# When to reach for xript

xript exists so that a user-facing surface can be **composed from a manifest, scripts, and fragments** instead of baked into the host. The default stance is simple: when something in an application could be contributed from outside rather than hardcoded inside, reach for xript first.

## The default

The framework provides primitives. The application's own content is its first mod. If the host cannot be replaced by a mod doing the same thing through the same surface, the surface is not yet extensible. It is hardcoded with a manifest sitting next to it. Proximity to a manifest is not the same as being manifest-driven.

## Three questions for any surface

Run every surface a host is about to build through these, in order:

1. **Could this live outside the host as a manifest + script + fragment instead of inside it as host code?** If yes, that is the default. The host implements primitives; behavior and presentation come from data and script.
2. **Is there already a canonical shape for this?** Slots and fragments compose UI. Bindings expose host calls. Hooks fire on lifecycle events. Capabilities gate access. Commands name invocable actions. When a surface fits one of these cleanly, use that name — do not invent new vocabulary.
3. **What does the manifest look like first?** The manifest is the contract. Sketch it before the implementation. Types, documentation, and validation all derive from it.

## Signals you should be using xript

- "We'll probably want users to customize this later."
- A renderer, editor, viewer, or panel that someone might want to replace or extend.
- A growing `switch` or `if/else` ladder over a closed set of kinds, where new kinds keep getting added by editing the host.
- A registry of behaviors that only the host can populate.
- Content the host ships that looks exactly like content a third party would contribute.

When any of these appear, the manifest-driven shape is almost always the better one. Name it explicitly so the trade-off is a decision rather than a default.

## When the hardcoded shape is genuinely right

xript is a compass, not a gate. A real constraint can rule out the extensible shape: a hot inner loop where the runtime boundary costs too much, a surface with exactly one possible implementation forever, a security boundary that must stay in host code. Name the constraint, name the fork, and choose deliberately. The goal is a visible decision, not a forced one.
