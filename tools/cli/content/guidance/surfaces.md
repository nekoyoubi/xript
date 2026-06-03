# Choosing an extensibility surface

xript has a small, fixed vocabulary of surfaces. Most "how should we make this extensible" questions resolve to picking the right one. Use the canonical name; do not coin a synonym.

The host offers exactly two surfaces. **Bindings** are points the mod *calls*. **Slots** are typed points the mod *fills*. Everything a mod contributes — a fragment, a role, a lifecycle handler — is a fill of a slot of a particular type. There is no separate top-level "fragment" or "hook" or "provides" primitive; each is just a fill, and the slot's `accepts` type governs what a valid fill looks like and what the host does with it.

## The vocabulary

- **Binding** — a function or namespace the host exposes for a mod to call. Use when a mod needs the host to *do* something: read state, perform an action, reach a host capability. Bindings are the mod-to-host direction. The mod calls; the host implements.
- **Slot** — a named, typed plug-point the host declares for a mod to fill. Use whenever a mod should *contribute* something the host then mounts, calls, resolves, or fires. A slot declares what it `accepts` (one or more format/kind names), whether it allows `multiple` fills, and an optional gating `capability`. The `accepts` type is the whole contract: it decides what a fill must look like and what the host does with it.
- **Fill** — the mod's contribution into a host slot, keyed by the slot's `id`. The host declares the slot; the mod declares the fill. The fill's inner shape is governed by the target slot's `accepts` type — the host owns that shape, and validation does not police it beyond "the slot exists and you hold its capability."
- **Capability** — a named permission that gates a binding or a slot. Default-deny. Use to make access explicit and grantable rather than ambient. A mod that fills a gated slot must hold the slot's capability.
- **Command** — a named, invocable action with typed inputs and outputs. Use when an action should be discoverable and callable by name, by a user or another mod.

## Slot types you will meet

A slot's `accepts` names the kind of fill it takes. The common kinds:

- **Fragment-format slot** — accepts an inert template (`text/html+jsml`, `application/jsml+json`, or another registered format). The fill names the `format`, a `source`, and its `bindings` / `handlers` (DOM event handlers; `events` is a deprecated alias). The host mounts it. Fragments carry no logic of their own: values flow through `data-bind`, visibility through `data-if`, and everything else through the sandbox fragment API.
- **Role slot** — accepts a set of functions the mod exports to satisfy a named role (`application/x-xript-role`). The fill maps role function names to the mod's exports; the host resolves and calls them.
- **Event slot** — accepts a lifecycle handler (`application/x-xript-hook`). The fill names the handler export; the host fires the slot, which calls every fill. This is what a "hook" is now: an event-typed slot, fired by calling its fills.
- **Code / data slots** — accept a registered renderer kind, a JSON payload, or another host-defined shape. The fill matches whatever the slot's `accepts` declares.

## How to pick

- Mod needs to call the host → **binding**.
- Mod contributes anything the host mounts, calls, resolves, or fires → **slot** (host side) + **fill** (mod side). Pick the slot whose `accepts` type matches the contribution: a fragment goes into a fragment-format slot, a role into a role slot, a lifecycle handler into an event slot.
- Access must be gated → **capability**.
- Action should be named and invocable → **command**.

## Anti-patterns

- **Reaching for a separate "fragment" or "hook" primitive.** There is one contribution surface: fills into slots. A fragment is a fill of a fragment-format slot; a lifecycle handler is a fill of an event slot. Don't model them as their own top-level things.
- **Inventing a manifest schema** where the existing manifest already has a place for this. Check the schema before defining new JSON. The answer is almost always a new slot, not a new concept.
- **A host-only registry** that mods can't populate, when a slot would let them fill it.
- **Vocabulary drift** — mixing *extension / plugin / add-on / mod* within one application. Pick one noun and hold it.
- **Modeling renderers as slots.** A format renderer (a DOM fragment processor, a terminal widget renderer, a future native renderer) is runtime infrastructure, not a manifest concept. It paints a fragment of format F onto a target; the slot's `accepts` type names the format the runtime must be able to render. Don't put renderers in the manifest.
- **Logic in fragments** — a fragment that tries to compute or branch beyond `data-bind` / `data-if`. That logic belongs in the sandbox, reached through the fragment API.
