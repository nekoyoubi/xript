# Adoption tiers

xript is adopted incrementally. A host does not have to expose everything at once; it picks the tier that matches what it needs today and grows later. Each tier is a superset of the one before.

## Tier 1 — expressions

The host evaluates user-supplied expressions in a sandbox. No bindings, no host calls — just safe evaluation of values. Use when the extensibility you need is "let users write a formula" and nothing more.

## Tier 2 — simple bindings

The host exposes a set of bindings and lets mods call them. Mods are scripts that read host state and invoke host actions through the declared surface. Use when mods need to *do* things in the host but do not yet contribute UI.

## Tier 3 — advanced scripting

Full scripting with hooks, capabilities, and lifecycle. Mods react to host events, request gated capabilities, and carry real behavior. Use when mods are first-class participants in how the application behaves.

## Tier 4 — full feature

Everything, including UI contribution: slots, fragments, contributions, and the fragment protocol. Mods add and replace presentation, not just behavior. Use when the application is fully moddable and its own content is authored as mod zero.

## Choosing a tier

Pick the lowest tier that covers what mods genuinely need now. Adding a higher tier later is additive — new bindings, hooks, slots, and capabilities extend the manifest without breaking existing mods. Do not expose tier 4 surfaces for a host whose mods only need tier 2; do not cap a host at tier 2 when its mods clearly want to contribute UI. The manifest grows with the need.
