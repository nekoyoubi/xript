# Offering commands

A command is a named, invocable action a mod contributes: the thing a command palette lists, a menu offers, and a keybinding fires. The host declares a **command slot**, mods fill it, and the host lists and invokes the fills. **A command is a kind of slot fill, not a third surface** — see [choosing a surface](/guidance/surfaces/).

## Declaring the slot

```json
{
  "id": "palette.commands",
  "accepts": ["application/x-xript-command"],
  "description": "Named actions offered in the command palette",
  "capability": "write:editor.text",
  "multiple": true
}
```

Nothing on the declaration is special to commands. `accepts` names the reserved kind the way a role or event slot does, and `capability`, `multiple`, `payload`, and `refines` keep their usual meanings.

**Declare `multiple: true` for anything list-shaped.** Cardinality counts fills, not mods, on every slot kind, so a `multiple: false` command slot resolves to exactly one command across every loaded mod. That is almost never what a palette wants, and `xript lint` warns about it.

**Gate the slot.** Contributing an invocable action is a privilege. A command slot with no `capability` lets any mod put an action in front of the user; legal, usually an oversight, and `xript lint` says so.

## Resolving and invoking

- `runtime.resolveCommands(slotId)` returns the ordered commands for a slot, with cardinality applied. This is the palette.
- `runtime.resolveCommandsAll(slotId)` is the same walk without cardinality, for a host building its own picker.
- `runtime.resolveCommand(ref)` looks one up by bare id or by `mod:id`, honoring `commandPreferences`.
- `runtime.invokeCommand(command, callArgs)` runs it. `invokeCommandAsync` is the promise-returning form.

Ordering is `priority` descending, then command `id`, then owning mod name. It does not depend on the order the host loaded its mods, so a palette does not reshuffle when the mod list is reordered.

Invocation merges the fill's bound `args` under the caller's arguments — shallow, and the caller wins any conflict — then routes through the addressed per-mod export path. That path re-reads the handler's export capability and re-checks it against the live grant set, so a grant revoked between load and call is honored.

## Authority lives on the export

Two layers, and neither of them is the fill:

1. **The slot's `capability`** decides which mods may contribute a command at all.
2. **`entry.exports[<handler>].capability`** on the mod side gates each invocation.

A command fill declaring its own `capability` fails to load. It could never have denied anything (the slot grant the mod already holds subsumes any narrower scope by prefix), and a genuine escalation must be re-rooted under a separate top-level scope, not nested under the slot's. So a host differentiating a destructive action from an ordinary one declares a separate scope and puts it on the export that performs it. Granting the ordinary scope then gets every ordinary command and none of the destructive ones.

The consequence to design around: **two commands differ in authority only by naming different exports.** Two commands backed by one export are the same action with different bound arguments, and they carry the same authority by construction.

`ResolvedCommand.capability` and `.capabilities` are informational, so a palette can render "this action requires X" without a second lookup. Neither is consulted at invoke.

## Displaying them

- `title` falls back to `id`; `description`, `icon`, `group`, and `keywords` are presentation the host is free to use or ignore.
- `exposed: false` asks not to be listed. It is a **discoverability** hint, not an authority gate: the command still resolves and still runs, so do not treat it as a permission check.
- `collides: true` marks a command whose bare `id` is shared with another mod's in the same slot. Nothing is renamed and nothing is dropped; each also carries a `qualifiedId` of `mod:id`, which is a real address. The display policy is the host's.
- Host built-ins are the host's own. Resolution returns mod-contributed commands only; concatenate your built-ins and apply your own precedence, usually built-ins first, since letting a mod shadow a built-in is a security decision made by accident.

## Common mistakes

- **Forgetting `multiple: true`** and shipping a one-item palette.
- **Treating `exposed: false` as a permission.** It hides; it does not deny.
- **Reading command fills out of `dataFills`.** They moved to `commandFills` in v0.8.0, when the accept became typed. Read `commandFills`, or better, `resolveCommands`.
- **Putting a `capability` on the fill.** It is a hard load error, and the fix is to move it to the export the command names.
- **Invoking through the bare export path.** Use `invokeCommand`, or pass the command's `mod` through to the addressed invoke. The unaddressed path throws when two mods own a handler name, and guesses nothing.
