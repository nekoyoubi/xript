# Hosting: mounting slots

A slot is a named, typed plug-point the host declares; a mod fills it. After loading mods, the host asks the runtime what filled each slot and mounts the result. **The host owns where and how a slot mounts; the runtime owns what is allowed to fill it.**

## Resolving fills

- `runtime.resolveSlot(slotId)` returns every `SlotContribution` filling that slot, ordered.
- `runtime.resolveSlotSingle(slotId)` returns the highest-priority contribution, or `null`.

A `SlotContribution` is `{ modName, fragmentId, slot, format, priority }`. The host reads it and mounts according to the slot's declared `accepts` type — a fragment-format fill gets rendered ([rendering fragments](/guidance/host-fragments/)), a role fill gets resolved ([resolving roles](/guidance/host-roles/)), an event fill gets fired ([firing hooks & events](/guidance/host-hooks/)). The `accepts` type is the whole contract for what the host does with the fill.

## Honor multiple and priority

A slot declares whether it allows `multiple` fills. For a single-fill slot, take `resolveSlotSingle`. For a multi-fill slot, take `resolveSlot` and mount each contribution in `priority` order. Dropping priority — or mounting only the first of many — is a host bug, not a runtime one; the runtime hands you the full ordered set and trusts you to honor it.

## Mod zero applies to the host's own UI

The strongest slot is one the host fills *as a mod*. If the application's own panels mount through `resolveSlot` like any third-party fill, the slot is exercised every run and stays honest. A slot only the host can fill privately is decoration. See [mod zero](/guidance/mod-zero/).

## Common mistakes

- **Hardcoding the host's own UI beside a slot instead of filling the slot.** That is the private-back-door failure mod zero exists to catch. Fill your own slots.
- **Ignoring `priority` or `multiple`.** Mount the full ordered set a multi-fill slot returns; do not assume one fill.
- **Branching on `format` the host never declared `accepts` for.** The slot's `accepts` type is the contract; a fill outside it would have failed validation at load.
