# Hosting: firing hooks & events

A hook is an extension point the host *fires*; every mod that filled it runs. This is how a host lets mods react to lifecycle moments and state changes. **Firing a hook calls its fills; it is not the same as the `events` catalog, which only declares what the host broadcasts.**

## Firing a hook

`runtime.fireHook(hookName, { phase, data })` fires the named hook and returns the array of fill return values. `phase` and `data` are both optional — `data` is the payload handlers receive, `phase` names a sub-stage when a hook has more than one.

Hooks are modeled as **event-typed slots**: the host declares a slot whose `accepts` type is `application/x-xript-hook`, a mod fills it with a handler export, and firing the slot calls every fill. Resolving and firing go together — see [mounting slots](/guidance/host-slots/). There is no separate top-level "hook" primitive; a hook is an event slot the host fires.

## Hooks vs the events catalog

Two surfaces share the word "event" and point opposite directions:

- **An event-typed slot** is a plug-point a mod *fills* with a handler; the host *fires* it with `fireHook`, and the fills run. Use it when you want mods to *respond*.
- **The `events` catalog** (top-level `events` in the host manifest) declares *what the host emits* — a discovery list of named broadcasts and their payload types. Declaring an event wires up no listener and grants nothing; it only tells observers what the application broadcasts. See [choosing a surface](/guidance/surfaces/).

If you want mods to react to something, you need a slot to fire. If you only want to publish that something happened, audience open, declare it in the catalog. The two often pair.

## Fragment lifecycle is its own hook

Fragments have a dedicated firing path: `runtime.fireFragmentHook(fragmentId, lifecycle, bindings)` returns a `FragmentOp[]` command buffer the host applies. See [rendering fragments](/guidance/host-fragments/).

## Common mistakes

- **Conflating the `events` catalog with an event slot.** The catalog announces; a slot is fired. Listing an event grants no listener.
- **Expecting `fireHook` to do something with no fills.** It returns an empty array. A hook does nothing until a mod fills its slot.
- **Reaching for a top-level `hooks` field.** A standalone `hooks` block is deprecated; model a hook as an event-typed slot.
