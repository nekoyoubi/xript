# More extensible, not less

xript is an extensibility substrate. Its whole reason to exist is to let things be reached, replaced, and extended from outside the host. So its default has to lean the same way the project does: **more extensible, not less.** When a design choice could go either way — expose it or hide it, accept the unknown shape or reject it, allow the reach or wall it off — the open option is the one that matches what xript is for. Closing a door is the exception, and an exception has to argue for itself.

## The rule

The framework defaults toward openness. A restriction is permitted only when it genuinely buys convenience or security the framework could not otherwise provide — and the restriction has to justify itself plainly, in the moment it's added, in terms a reader can check. "It felt safer" is not a justification. "This is the security boundary, and here is what it stops" is.

Reflexive lockdown is off-brand for an extensibility substrate. A framework whose first instinct is to forbid is a framework working against its own grain. The instinct to add a guard, narrow an input, or reject an unfamiliar shape is worth having — but it has to clear a bar, not ride in for free.

## When a restriction earns its place

A restriction belongs when it buys something the open shape can't:

- **It is the security boundary.** The capability model is xript's real wall: default-deny, explicit grants, gated surfaces. Restrictions that *are* that boundary — or that close a genuine hole in it — are not lockdown; they're the product. Schema validation, by contrast, is not a security boundary, so tightening a schema is rarely a security argument.
- **It buys real convenience or a real guarantee.** A constraint that makes the common case simpler, the error clearer, or a result reproducible can pay for itself. Name the payoff.
- **The alternative is genuinely unsafe or unworkable**, not merely unfamiliar. An unrecognized shape is not automatically a threat.

When none of these holds, the open shape wins by default. The burden is on the restriction, never on the openness.

## Opt out of openness, not into it

Where a feature could be open or guarded, ship it open and let the host *opt out*. Remote schema resolution is the worked example: it is allowed by default, and a host that wants a tighter posture sets an explicit restriction (an allowlist, or disabling remote resolution outright). The dial exists; it just starts at open. Inverting that — making every host opt *in* to a capability that's safe by default — taxes the common case to soothe an instinct, and that is exactly the reflexive lockdown this doctrine exists to resist.

## Openness over brittleness

An open default also means failing soft where failing hard would buy nothing. When an optional reach can't complete — a remote schema is unreachable, an uncached fetch fails offline — fall back to what's bundled and surface a warning, rather than hard-failing the whole operation. A brittle "all or nothing" path is a quiet form of lockdown: it turns a recoverable gap into a wall. Degrade, warn, and keep going.

## The drift to watch

- **A guard with no stated cost it prevents.** If a restriction can't name what it buys, it's reflex, not design. Strip it or justify it.
- **Opt-in where opt-out would do.** A safe-by-default capability hidden behind a flag the host must find and enable. Flip the default.
- **Hard-fail where fallback would do.** An optional path that takes the whole operation down with it when it can't complete.
- **A schema treated as a security wall.** Tightening validation to "lock something down" confuses the schema with the capability model. The schema describes shape; the capability model holds the line.

Use this doctrine the way you'd use the boundary doctrine: to decide which way a close call leans. When in doubt, lean open, and make any door you close explain itself.
