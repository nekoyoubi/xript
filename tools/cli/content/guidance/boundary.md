# The host/mod boundary

The hardest recurring question in an extensible app is where the line sits: what belongs *in the host* versus what belongs *in a mod*. The rule is short. **The host provides mechanism; mods provide policy and content. The host declares the surface; mods fill it.** Everything else is applying that rule to a specific case.

## What belongs in the host

- **The surface itself** — the manifest, and the bindings, slots, and capabilities it declares. A mod cannot declare the host's own surface; that is the host's job.
- **Mechanism** — the implementation behind each binding, and the host-side handling of each slot. The *how* of reaching real state, performing a real action, mounting a fragment, or firing an event lives in the host; mods call bindings and fill slots, they don't reimplement the host's side.
- **Security-critical enforcement** — capability gating, the sandbox boundary, anything a mod must not be able to reach around. If correctness depends on a mod *not* being able to bypass it, it is host code.
- **Genuinely hot paths** — a tight inner loop where crossing the runtime boundary per iteration costs too much. A real performance constraint is a legitimate reason to keep something in the host; name the constraint when you invoke it.

## What belongs in a mod

- **Policy and behavior** — the decisions, the rules, the *what to do*. The host exposes the levers; mods decide how to pull them.
- **Presentation, behavior, and reactions** — what the user sees, the roles the host needs satisfied, the moments mods react to: all contributed as fills into declared slots.
- **The app's own content** — built-in features authored as mod zero, through the same surface a third party would use.
- **Anything a third party could plausibly replace or extend** — if an outside author could reasonably want to do this differently, it is mod territory, even when the host ships the default.

## The deciding question

> Could a third party do this as a mod, through the declared surface?

- **Yes** → it is mod territory. Build it as mod zero even though it ships with the app. If the host *can't* currently let a mod do it, that gap is the signal: the surface is missing a binding, a slot, or a capability. Close the gap rather than keeping the feature as private host code.
- **No** → it is host code, because it *is* the surface, or a mechanism nothing can reach around, or a security boundary.

## The drift to watch, both directions

- **Policy creeping into the host**: the host grows a behavior that should have been a mod. The tell is a `switch` over named kinds, or a default that hardcodes one opinion where a slot would let mods fill their own.
- **A mod reaching for mechanism**: a mod reimplementing something the host should own, or wanting access the surface deliberately withholds. The tell is a mod that only works by reaching around the declared surface.

Both are the line moving the wrong way. Name which side a thing belongs on, and why, when it isn't obvious.

## Prefer the check to the reminder

This is doctrine, and doctrine is advisory; easy to forget mid-task. Where the boundary can be made *checkable*, prefer the check: a slot only the host can declare, a capability that gates access, a cross-validation that fails loudly when a mod's fills or requests don't match the host contract. A validator that fails on every commit holds the line in a way a remembered principle cannot. Use the doctrine to decide where the line is; use the contract to keep it there.
