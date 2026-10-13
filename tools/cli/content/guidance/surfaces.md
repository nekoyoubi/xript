# Choosing an extensibility surface

xript has a small, fixed vocabulary of surfaces. Most "how should we make this extensible" questions resolve to picking the right one. Use the canonical name; do not coin a synonym.

The host offers exactly two surfaces. **Bindings** are points the mod *calls*. **Slots** are typed points the mod *fills*. Everything a mod contributes is a fill of a slot of a particular type: a fragment, a role, a lifecycle handler, a command. There is no separate top-level "fragment" or "hook" or "provides" or "commands" primitive; each is just a fill, and the slot's `accepts` type governs what a valid fill looks like and what the host does with it. This is the whole extensibility surface.

Two things people reach for as third surfaces are not. A **format** is the vocabulary the fills of a fragment-format slot speak: the node names, prop schemas, and safety annotations a host declares so the runtime knows what a legal fill of that media type looks like. A **command** is a fill of a slot whose `accepts` is `application/x-xript-command`, exactly the way a lifecycle handler is a fill of a slot whose `accepts` is `application/x-xript-hook`. Both ride on the two surfaces; neither adds one.

## The vocabulary

- **Binding**: a function or namespace the host exposes for a mod to call. Use when a mod needs the host to *do* something: read state, perform an action, reach a host capability. Bindings are the mod-to-host direction. The mod calls; the host implements.
- **Slot**: a named, typed plug-point the host declares for a mod to fill. Use whenever a mod should *contribute* something the host then mounts, calls, resolves, or fires. A slot declares what it `accepts` (one or more format/kind names), whether it allows `multiple` fills, and an optional gating `capability`. The `accepts` type is the whole contract: it decides what a fill must look like and what the host does with it.
- **Fill**: the mod's contribution into a host slot, keyed by the slot's `id`. The host declares the slot; the mod declares the fill. The fill's inner shape is governed by the target slot's `accepts` type. The host owns that shape, and validation does not police it beyond "the slot exists and you hold its capability."
- **Capability**: a named permission that gates a binding or a slot. Default-deny. Use to make access explicit and grantable rather than ambient. A mod that fills a gated slot must hold the slot's capability.
- **Command**: a named, invocable action with typed inputs and outputs, contributed as a **fill of a command slot**. Use when an action should be discoverable and callable by name, by a user or another mod. Not a surface of its own; a kind of fill, like a fragment or a role map. See [commands](/spec/commands/).
- **Format**: the node vocabulary a fragment-format slot's fills speak, declared by the host in `formats`: which nodes are legal, which props each takes, and where each prop's value lands. Not a surface of its own; the vocabulary a fill of one slot type is checked against. See [declaring a fragment format](/guidance/host-formats/).

## Slot types you will meet

A slot's `accepts` names the kind of fill it takes. The common kinds:

- **Fragment-format slot**: accepts an inert template of a named media type (`text/html`, `application/j5ml+json`, or a format the host declares in `formats`). The fill names the `format`, a `source`, and its `bindings` / `handlers` (`events` is a deprecated alias for `handlers`). The host mounts it. Fragments carry no logic of their own: values flow through `data-bind`, visibility through `data-if`, lists through `data-each` (keyed by `data-key`), and everything else through the sandbox fragment API. The `accepts` media type is not just a label; it names a **vocabulary**: the legal node names, their props, and which prop values are dangerous. HTML is built in; anything else, the host declares.
- **Role slot**: accepts a set of functions the mod exports to satisfy a named role (`application/x-xript-role`). The fill maps role function names to the mod's exports; the host resolves and calls them.
- **Event slot**: accepts a lifecycle handler (`application/x-xript-hook`). The fill names the handler export; the host fires the slot, which calls every fill. This is what a "hook" is now: an event-typed slot, fired by calling its fills.
- **Command slot**: accepts a named, invocable action (`application/x-xript-command`). The fill carries an `id`, a `title`, and the `handler` export that runs it, plus optional bound `args` so one export can back several parameterized commands. The host lists them (a palette, a menu, a keybinding table) and invokes the one the user picked. This is what a "command" is: a command-typed slot, invoked by name.
- **Code / data slots**: accept a registered renderer kind, a JSON payload, or another host-defined shape. The fill matches whatever the slot's `accepts` declares.

The three `application/x-xript-*` accepts are reserved kind names rather than markup syntaxes: they carry no content to sanitize, and a host cannot redeclare them in `formats`.

## How to pick

- Mod needs to call the host → **binding**.
- Mod contributes anything the host mounts, calls, resolves, fires, or invokes → **slot** (host side) + **fill** (mod side). Pick the slot whose `accepts` type matches the contribution: a fragment goes into a fragment-format slot, a role into a role slot, a lifecycle handler into an event slot, a named action into a command slot.
- Access must be gated → **capability**.
- Action should be named and invocable → **command slot**, filled with a command. Gate the slot to decide who may contribute an action, and put per-action authority on the export the command names; a `capability` on the fill itself is an error.
- A fragment slot accepts something other than HTML → declare that media type's **format** vocabulary. Without it the media type is a bare label, and the runtime has no way to tell a legal node from a typo.

## Anti-patterns

- **Reaching for a separate "fragment", "hook", or "commands" primitive.** There is one contribution surface: fills into slots. A fragment is a fill of a fragment-format slot; a lifecycle handler is a fill of an event slot; a command is a fill of a command slot. Don't model them as their own top-level things. A host manifest carrying an invented top-level `"commands"` block validates clean and is consumed by nothing, which is the failure this vocabulary exists to prevent.
- **Minting a closure per parameterized action.** Four commands that wrap a selection in four different delimiter pairs are one export with four fills, each binding its own `args`. Exporting `wrapInQuotes`, `wrapInParens`, and `wrapInBrackets` separately writes the parameters into code where nobody can see or override them.
- **Inventing a manifest schema** where the existing manifest already has a place for this. Check the schema before defining new JSON. The answer is almost always a new slot, not a new concept.
- **A host-only registry** that mods can't populate, when a slot would let them fill it.
- **Vocabulary drift**: mixing *extension / plugin / add-on / mod* within one application. Pick one noun and hold it.
- **Modeling renderers as slots.** A format renderer (a DOM fragment processor, a terminal widget renderer, a future native renderer) is host code, not a manifest concept. Draw the line where the contract ends: the **vocabulary** (node names, prop schemas, sinks, what a legal fill looks like) is a contract between host and mod and belongs in the manifest's `formats` block; the **renderer** (the widget library, the layout solver, the mounting code that paints that tree) is host code and never appears there. xript stays ignorant of any particular component set: it checks a fill against the declared vocabulary and hands back a tree. What paints it is yours.
- **Logic in fragments**: a fragment that tries to compute or branch beyond `data-bind` / `data-if` / `data-each`. That logic belongs in the sandbox, reached through the fragment API. The reverse mistake is just as common: assembling list markup in script when `data-each` would keep it in the template.
