# Commands

A command is a named, invocable action contributed by a mod: something a user picks out of a palette, a menu, or a keybinding, and something another mod or an agent can call by name.

A command is **a fill of a slot**, exactly like a fragment, a role map, or a lifecycle handler. It is not a new top-level manifest key and it is not a third extensibility surface. The host declares a slot whose `accepts` names the reserved media type `application/x-xript-command`; a mod contributes commands into it through the one `fills` object it already uses for everything else. The contribution surface stays what it has always been: *hosts declare slots, mods fill them*.

This page is the surface end to end. See [manifest.md](./manifest.md#slot-types) for the slot declaration, [mod-manifest.md](./mod-manifest.md#representative-fill-shapes) for the fill shape in context, and [capabilities.md](./capabilities.md) for the authority model it leans on.

## The Shape

### The host declares the slot

```json
{
  "xript": "0.8",
  "name": "example-editor",
  "capabilities": {
    "editor": { "description": "Editor surface" },
    "editor.text": { "description": "Document text" },
    "editor-destructive": { "description": "Irreversible document edits" }
  },
  "slots": [
    {
      "id": "palette.commands",
      "accepts": ["application/x-xript-command"],
      "description": "Named actions offered in the command palette",
      "capability": "write:editor.text",
      "multiple": true
    }
  ]
}
```

Nothing on the slot is new. `accepts` carries the reserved media type the way `application/x-xript-role` and `application/x-xript-hook` already do, and `capability`, `multiple`, `payload`, `reserved`, and `refines` keep the meanings they have on every other slot.

Note that `editor-destructive` is a **separate top-level capability scope**, not `editor.text.destructive`. That is required by the [monotonic-privilege invariant](./capabilities.md#the-monotonic-privilege-invariant-normative), and [Capability Gating](#capability-gating) explains why it is the only shape that can actually deny.

### The mod fills it

```json
{
  "xript": "0.8",
  "name": "quote-tools",
  "entry": {
    "script": "src/main.js",
    "format": "module",
    "exports": {
      "wrapSelection": { "description": "Wrap the selection in a delimiter pair" },
      "stripFormatting": {
        "description": "Remove all inline formatting, irreversibly",
        "capability": "write:editor-destructive"
      }
    }
  },
  "capabilities": ["write:editor.text", "write:editor-destructive"],
  "fills": {
    "palette.commands": [
      {
        "id": "wrap.double",
        "title": "Wrap in double quotes",
        "handler": "wrapSelection",
        "args": { "open": "\"", "close": "\"" },
        "keywords": ["surround", "quote"],
        "group": "text"
      },
      {
        "id": "wrap.paren",
        "title": "Wrap in parentheses",
        "handler": "wrapSelection",
        "args": { "open": "(", "close": ")" }
      },
      {
        "id": "wrap.custom",
        "title": "Wrap in…",
        "handler": "wrapSelection",
        "input": {
          "type": "object",
          "properties": {
            "open": { "type": "string", "description": "Opening delimiter" },
            "close": { "type": "string" }
          },
          "required": ["open", "close"],
          "additionalProperties": false
        },
        "output": { "type": "object", "properties": { "changed": { "type": "boolean" } } }
      },
      {
        "id": "strip.formatting",
        "title": "Strip all formatting",
        "handler": "stripFormatting",
        "priority": -10
      }
    ]
  }
}
```

```js
export function wrapSelection({ open, close }) {
  const sel = xript.editor.getSelection();
  xript.editor.replaceSelection(open + sel + close);
  return { changed: sel.length > 0 };
}

export function stripFormatting() {
  xript.editor.replaceSelection(xript.editor.getSelection().replace(/<[^>]+>/g, ""));
}
```

Four commands, two exports, no closure minted per variant. Three commands are parameterized variants of one export; the fourth is separately gated because it names a separately gated export.

## The Fill

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | string, `^[a-z][a-z0-9.-]*$` | yes | command id, unique within a (mod, slot) pair |
| `handler` | string | yes | the mod export that runs it |
| `title` | string | no | human label; defaults to `id` |
| `description` | string | no | one-line prose, surfaced in palettes and docs |
| `icon` | string | no | host-interpreted icon token |
| `group` | string | no | category for grouping in a picker |
| `keywords` | string[] | no | search synonyms |
| `args` | object | no | bound arguments (see [Bound Arguments](#bound-arguments)) |
| `input` | JSON Schema | no | the *effective* argument object's contract |
| `output` | JSON Schema | no | the return contract |
| `priority` | integer | no | ordering within the slot, default `0` |
| `exposed` | boolean | no | discoverability hint, default `true` |

`capability` is **not** a key. A fill carrying one is a hard error; see [Why there is no per-fill capability](#why-there-is-no-per-fill-capability).

`handler` names an export, matching the hook fill's `handler` exactly. It is deliberately not an `entry` + `fn` pair: a xript mod is a single-entry ES module whose top-level named exports auto-register ([modules.md](./modules.md#top-level-exports-become-host-invokable-exports)), so a second file pointer would contradict the module model.

A command must name itself. Fragment fills may omit an `id` and have one synthesized; a command is invoked and displayed by name, so `id` is required.

`exposed: false` is a **discoverability** gate, not an authority gate. The command still resolves and still runs; it is asking not to be listed in a palette or projected into an agent tool catalog. Authority is capability, always.

### Types live on the fill, bounded by the slot

`input` and `output` are JSON Schema (draft 2020-12), the same dialect `slot.payload` already uses, and they live on the **fill**.

The reason is authority, not preference: a host cannot know the signature of an action it did not write, which is the definition of a contributed command. The role precedent agrees, since `fns` is a mod-authored map the host resolves by logical name rather than a host-fixed vtable. Putting the signature on the slot would make commands the only slot kind where the host must anticipate the mod.

The **slot bounds them** with machinery that already exists. `slot.payload` is a JSON Schema over the fill object, and `input` / `output` are properties of the fill object:

```json
{
  "id": "format.transformer",
  "accepts": ["application/x-xript-command"],
  "multiple": true,
  "payload": {
    "required": ["input", "output"],
    "properties": {
      "output": { "properties": { "type": { "const": "string" } } },
      "group": { "enum": ["text", "code"] }
    }
  }
}
```

No new slot field, no second schema language, and `refines` inheritance keeps working.

**Omission means open, not invalid.** A fill with no `input` accepts any argument object; a fill with no `output` returns anything. Declaring a signature buys typegen output, docgen tables, and (where a host opts in) argument validation. Omitting it costs only those.

`input` and `output` accept `$ref`, resolved by the existing `extends` / `$schema` resolver rules: relative to the manifest, remote allowed unless the host opts out.

### Fill-time errors

Normalization rejects a fill when:

| Code | Condition |
|---|---|
| `command-fill-capability` | `capability` is present at all, including `"capability": null` |
| `command-missing-handler` | `handler` is missing or is not a non-empty string |
| `command-invalid-id` | `id` is missing or fails `^[a-z][a-z0-9.-]*$` |
| `command-duplicate-id` | `id` repeats within the same (mod, slot) pair |
| `command-args-not-object` | `args` is present and is not a plain object |
| `command-unbound-arg` | `input` declares `additionalProperties: false` and `args` carries a key `input.properties` does not list |

A seventh code, `command-handler-unknown`, fires in `xript lint` when a `handler` names an export absent from a non-empty `entry.exports`. It is a static finding only: the runtime is authoritative for what a module actually exports and enumeration is optional, so a runtime that raised it would reject mods whose handlers genuinely exist.

These are load-time errors with fix-it messages, not runtime surprises. Errors are matched by `code`, never by message text.

## Bound Arguments

```
effective = { ...fill.args, ...callArgs }
```

Shallow, top level only. The handler is called with exactly one argument, the effective object.

**Call time wins.** A key present in both is taken from the caller. One rule, no modes, no `fixed` flag. It keeps the framework open, since a host or user can always steer a command it is already allowed to invoke, and the case for pinning is security, which is capability's job rather than the argument merger's. A mod wanting a hard pin writes the constant in the handler, which is clearer than a manifest flag that looks like a security boundary and is not one. A conflict is never an error and never a warning: in the parameterized-variant pattern, bound keys are *expected* to be overridable defaults.

**Shallow, not deep.** Deep merge would make `args: { opts: { a: 1 } }` plus `callArgs: { opts: { b: 2 } }` produce a value neither side wrote. A mod wanting nested defaults merges them itself.

**Configured versus wired.** `args` is the configured-parameter channel and `input` is the call channel. A key present in `args` is configured; a key absent from `args` and present in `input` is wired. The distinction falls out of the merge rather than needing its own field.

**`input` describes the effective object**, not the caller's slice. Validation (where a host opts in) runs against `effective`, so a bound key satisfies a `required` entry, and typegen derives the call-time parameter type by relaxing the bound keys:

```ts
type CallArgs = Omit<Input, BoundKeys> & Partial<Pick<Input, BoundKeys>>;
```

So `wrap.double` types as `(args?: { open?: string; close?: string }) => …` while `wrap.custom` types as `(args: { open: string; close: string }) => …`, from one `input` schema plus the `args` object.

## Resolution

### Namespacing and collisions

```
qualifiedId = `${mod}:${id}`
```

The mod name is not a label. It is the first half of export identity and the first argument to `invokeModExport`, so `qualifiedId` is an **address** and resolving it is total.

Resolution returns both `id` and `qualifiedId`, and marks `collides: true` on every entry whose bare `id` is not unique within the slot. It never renames and never drops. The host picks its own display policy; the runtime makes an informed policy possible. `xript lint` reports the collision as `command-id-collision` at info level.

### Ordering and cardinality

Command resolution **conforms to the slot resolver** rather than forking it. Fills of a slot are ordered by:

1. `priority` descending
2. fill `id` ascending
3. owning mod name ascending

Key 3 is an amendment to the shared rule, applied to *both* resolvers in this version (see [Runtime Slot Resolution](./fragments.md#runtime-slot-resolution)). For commands, ids are mod-authored and collide by construction, so key 3 is load bearing; the ordering does not depend on the order the host loaded its mods.

**Cardinality means what it means everywhere else.** A `multiple: false` command slot resolves to exactly **one command** across all mods, not one command per mod and not one mod's whole set. A palette slot must declare `multiple: true`. This is not a degraded outcome: `multiple: false` is the schema default, so a host that forgets it gets a one-item palette rather than a surprising one, and `xript lint` emits `command-slot-singular` as a warning for exactly that case. Redefining a shared field's meaning per slot kind would have been the worse trade.

### The resolver API

```ts
export function resolveCommandsAll(slot: string, mods: ModInstance[]): ResolvedCommand[];
export function resolveCommands(slot: string, mods: ModInstance[], slots: SlotDeclaration[]): ResolvedCommand[];
export function resolveCommand(
  ref: string,                             // bare id or qualified id
  mods: ModInstance[],
  slots: SlotDeclaration[],
  preferences?: Record<string, string>,    // command id or slot id → mod name
): ResolvedCommand | null;
```

`resolveCommandsAll` is the unfiltered walk. `resolveCommands` applies slot cardinality, and takes the same `slots` argument `resolveSlotContributions` takes, for the same reason: cardinality is a property of the declaration, not of the fills. `resolveCommand` searches the *resolved* set of every command slot in declaration order, so a command the host could not get from `resolveCommands` is not invocable by name either; on a bare-id lookup it consults `preferences[commandId]` first, then `preferences[slotId]`. A qualified-id lookup is an address and ignores preferences.

```ts
export interface ResolvedCommand {
  mod: string;                     // owning mod, the first half of export identity
  slot: string;
  id: string;
  qualifiedId: string;
  title: string;                   // falls back to id
  description?: string;
  icon?: string;
  group?: string;
  keywords: string[];
  handler: string;                 // export name, addressed within `mod`
  args: Record<string, unknown>;   // bound args, {} when none
  input?: unknown;                 // JSON Schema
  output?: unknown;
  capability?: string;             // informational: the narrowest gate (see below)
  capabilities: string[];          // informational: every gate, slot first then export
  priority: number;
  exposed: boolean;
  collides: boolean;
}
```

The field is `mod`, not `addon`. `RoleResolution.addon` predates export scoping and is not renamed here; `mod` is the parameter name of `invokeModExport(mod, name, args)` and the field name on a hook fill, and a `ResolvedCommand` is meant to be spread straight into an invocation.

`capability` and `capabilities` are **informational only** and are never consulted at invoke. `capability` is the narrowest gate the command sits behind: the handler's export capability when it declares one, else the slot's. `capabilities` is the deduplicated union, slot gate first then export gate, because the two can be unrelated re-rooted scopes that are both genuinely required. Both exist so a host can render "this action requires X" in a palette without a second lookup.

### Host built-ins

xript has no mod-zero concept and commands do not introduce one. Resolution returns mod-contributed commands only. The host concatenates its own built-ins and applies its own precedence, usually built-ins first, since a host that lets a mod silently shadow a built-in has made a security decision by accident. Same posture as role resolution: the runtime supplies resolution, the host keeps policy.

## Invocation

```ts
await runtime.invokeCommand(command, callArgs?);
```

Sugar over the addressed export-invoke path:

1. `effective = { ...command.args, ...callArgs }`
2. optional `input` validation, when the host supplied a validator
3. `invokeModExport(command.mod, command.handler, [effective])`
4. return the handler's value; a throwing handler propagates as an invocation error

Step 3 is the whole authority story, and it is not new code. `invokeModExport` re-reads the handler's declared export capability and re-checks it against the live grant set before dispatching into the mod's own export namespace, so grants revoked between load and call are honoured.

Three properties fall out:

- **No ambiguity, ever.** Bare `invokeExport(name)` throws an ambiguous-export error when two mods own a name. A `ResolvedCommand` always carries its owner, so it always takes the addressed path. **A command MUST NOT be routed through the bare, unaddressed invoke path** in any runtime.
- **No cross-mod reach.** The command runs in its declaring mod's namespace and is structurally unable to reach another mod's export of the same name.
- **No new gate.** `invokeCommand` adds no capability check of its own, because the two that matter already ran.

**Errors propagate, unlike hooks.** Hook dispatch swallows a handler's error and contributes `undefined`, which is right for a fire-and-forget lifecycle notification and wrong for a user-triggered action. A command that fails must say so. This asymmetry is a decision, not an oversight; see [hooks.md](./hooks.md#error-handling).

**Full JSON Schema validation is opt-in.** No runtime bundles a schema validator, and pulling one into the QuickJS-WASM dependency graph to check every call is a real cost for a check the host can do once. The JS and Node runtimes accept an optional `validateInput` predicate on runtime construction; Rust and C# ship none. Structural checks (the fill is an object, bound keys are declared) run everywhere, always, at load. `xript validate` and `xript lint` check `input` / `output` well-formedness statically in every case.

## Capability Gating

Authority is two layers, and both of them already shipped.

**Layer 1, the slot gate (contribution).** `slot.capability` is checked during normalization exactly as it is for role, hook, and data fills. A mod without the grant does not contribute commands to that slot; the command branch reuses that check verbatim, which means a mod that lacks the grant fails to load, the same as every other slot kind.

**Layer 2, the export gate (invocation).** `entry.exports[name].capability` gates each invocation. This is enforced in all four runtimes and statically by `@xriptjs/validate`, whose rule is that an export's capability must be declared in the mod's own `capabilities`.

### Why there is no per-fill capability

A `capability` on the command fill would be **decorative**, and the capability model forbids the only shape that would work.

**It could not deny.** `satisfies` is prefix subsumption on the dot tree plus a `write` ⊒ `read` mode lattice. A mod holding `write:editor.text`, which the slot gate already required it to hold, therefore satisfies `write:editor.text.destructive` automatically. Every strictly narrower fill capability is satisfied by definition, by exactly the grant the mod needed to fill the slot at all.

**The model mandates the other shape.** The [monotonic-privilege invariant](./capabilities.md#the-monotonic-privilege-invariant-normative) requires that a sub-scope conferring strictly more than its parent be **re-rooted under a separate top-level scope**. A genuinely escalating command capability is therefore `write:editor-destructive`, not `write:editor.text.destructive`, and a fill-level rule of "must be subsumed by the slot's" would reject precisely the shape the spec mandates while accepting the useless one.

So the key is **rejected rather than ignored**, in all four runtimes:

```
command 'strip.formatting' declares a 'capability'; per-action authority lives on the
export it names — move it to entry.exports.stripFormatting.capability
```

Silently ignoring it would read to an author as a granted narrowing, which is the exact failure this rule exists to kill.

### Differentiating authority between commands

The gate sits at the **action**, which is the right altitude. Two commands backed by the same export are the same action with different bound arguments and must carry the same authority; gating at the fill would let two names for one action disagree about what it is allowed to do.

The worked example is the one at the top of this page. `wrapSelection` carries no export capability; `stripFormatting` declares `write:editor-destructive`, a re-rooted top-level scope. Granting `write:editor.text` gets the host every wrap variant and no destructive one. The consequence a host must understand is stated plainly: **two commands differ in authority only by naming different exports.** That is a constraint, and it is the honest one. Authority is a property of code, not of a manifest label pointing at code.

## Slot Kind Precedence

A fill's kind is decided by the slot's `accepts`, in a fixed order (normative, all four runtimes):

1. `accepts` includes `application/x-xript-role` → provider role
2. `accepts` includes `application/x-xript-hook` → hook fill
3. `accepts` includes `application/x-xript-command` → **command fill**
4. the fill carries a string `format` and a string `source` → fragment
5. otherwise → data fill

Command sits at position 3: after the two existing reserved accepts, so the reserved kinds are checked in a fixed order when a slot lists more than one, and before the fragment sniff, so a command fill carrying `format` and `source` keys is still read as a command rather than as markup.

`application/x-xript-command` is a **reserved media type**. It is never sanitized, because a command carries no markup, and a host may not redeclare it in `formats`; the schema forbids it and `xript validate` errors. This matches `application/x-xript-role` and `application/x-xript-hook` exactly.

## Behaviour Change in v0.8.0

Before v0.8.0, `application/x-xript-command` was reserved in name only: fills into a slot accepting it were delivered untyped in `mod.dataFills[slotId]`. From v0.8.0 they are parsed as command fills and delivered in `mod.commandFills`. A host reading them from `dataFills` must read `commandFills` (or `resolveCommands`) instead.

Two sharp edges, stated rather than smoothed:

- **Normalization gets strict.** A fill that previously loaded as an opaque object now errors if it lacks a valid `handler` or `id`. That is the point of typing the accept, and it is a load-time error with a fix-it message.
- **Dual delivery is rejected.** Command fills do not also appear in `dataFills`. `dataFills` is the escape hatch for slot kinds the runtime has no typed reading of; a typed kind that also appeared there would make the field mean two things. Neither role nor hook fills dual-deliver.

The same latent hazard existed for role and hook when those accepts were typed. This is the one-time cost of turning a reserved-by-convention string into a reserved-by-implementation one, and there is no third occurrence pending.

## Tooling

**typegen.** A host manifest emits a `commandSlots` namespace and a `CommandSlotId` union, generated from slot `payload` constraints only, since the host does not know its mods. A mod manifest emits a `commands.Catalog` interface keyed by command id, with bound keys relaxed per [Bound Arguments](#bound-arguments) and non-identifier ids degrading to bracket access.

**docgen.** A `## Commands` section folds out of the generic UI-slots table the way hook slots fold into `## Hooks`. The host page reports the slot, its capability, its cardinality, and its fill contract; the mod page reports each command's id, title, handler, **Requires**, bound args, input, and output. The Requires column is the union of the slot gate and the export gate, and it is the column that makes the design legible: authority visibly tracks the handler.

**lint.** Beyond the fill-time errors above, `xript lint` reports:

| Level | Code | What it says |
|---|---|---|
| warning | `command-slot-singular` | a command slot without `multiple: true` resolves to exactly one command across all mods |
| warning | `command-slot-ungated` | a command slot with no `capability`: an unqualified contribution surface is usually an oversight, though legal |
| info | `command-opaque-args` | a fill binds `args` but declares no `input`, so the bound keys are undiscoverable to tooling |
| info | `command-uniform-authority` | on a gated slot, no handler declares an export capability, so every command carries identical authority |
| info | `command-id-collision` | two mods declare the same bare id in one slot |

**score.** Command slots are reported **alongside** the headline, in `ScoreResult.commands`, not folded into the capacity denominator. A command slot *is* a slot and is already counted; adding a sixth surface would double-count and would silently penalize every host that shipped before the feature existed. Declared fragment formats are reported for the same reason and with the same wording. The surface reports which command slots exist, which are `payload`-constrained, which are gated, which are singular, and which no supplied mod reaches, and `score-diff` reports movement in each.

## Runtime Parity

| | `@xriptjs/runtime` | `@xriptjs/runtime-node` | `xript-runtime` (Rust) | `Xript.Runtime` (C#) |
|---|---|---|---|---|
| command accept constant | yes | yes | yes | yes |
| normalize branch at position 3 | yes | yes | yes | yes |
| fill-time errors incl. `capability` rejection | yes | yes | yes | yes |
| command fills on the normalized mod | yes | yes | yes | yes |
| resolvers, three-key order | yes | yes | yes | yes |
| bound-arg merge at invoke | yes | yes | yes | yes |
| invoke over the addressed export path | yes | yes | yes | yes |
| structural arg checks | yes | yes | yes | yes |
| full JSON Schema `input` validation at invoke | opt-in | opt-in | no | no |
| reserved-format exclusion (never sanitized) | yes | yes | yes | yes |
| `spec/command-tests.json` corpus run | yes | yes | yes | yes |

Parity is held by contract. [`command-tests.json`](./command-tests.json) is a shared conformance corpus with four sections, asserted by every runtime and by `@xriptjs/validate`:

- **`branchOrder`** pins the precedence list above, including the case that a fill carrying `format` and `source` on a command slot is a command.
- **`normalize`** pins the fill defaults (`title` falls back to `id`, `keywords` to `[]`, `args` to `{}`, `priority` to `0`, `exposed` to `true`) and every fill-time error code.
- **`boundArgs`** pins the merge: call time wins, shallow, an explicit `null` overrides.
- **`resolution`** pins the three comparators in isolation, load-order independence, cardinality, bare and qualified lookup, preferences, and the slot gate.

Cases carry a `code` for their expected error, never a message string, so a runtime may word its diagnostics natively.

Out of scope by design: `xript-ratatui` renders fragments and a command is not a fragment, and `xript-wiz` gains command scaffolding through the CLI's templates rather than as a second implementation.
