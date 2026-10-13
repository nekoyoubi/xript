# xript Mod Manifest Specification

A mod manifest is a JSON file declaring what a mod needs from a host and what it contributes back. It is distinct from the app manifest: the app manifest describes the surface a host exposes; the mod manifest describes the code and contributions a mod plugs into that surface.

The schema lives at [`mod-manifest.schema.json`](./mod-manifest.schema.json).

## The Shape: Host Slots, Mod Fills

A host declares a surface of named, typed plug-points called **slots**. A mod engages that surface two ways:

- **bindings** — callables the host implements; the mod *calls* them.
- **fills** — typed plug-points the host declares as slots; the mod *fills* them.

Everything a mod contributes is a fill. A UI fragment, a provider role, and a lifecycle hook handler are not separate top-level concepts; each is a fill of a slot of a particular type. The target slot's `accepts` type governs what a valid fill looks like and what the host does with it: mount it, call it, resolve it, or fire it.

See [manifest.md](./manifest.md) for how a host declares slots.

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `xript` | string | Spec version this mod targets (e.g. `"0.3"`) |
| `name` | string | Machine-readable identifier (`^[a-z][a-z0-9-]*$`, max 64 chars) |
| `version` | string | Mod version (semver) |

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Human-readable display name |
| `description` | string | Brief description for users |
| `author` | string | Author name or handle |
| `family` | string | Host-side grouping key (`^[a-z][a-z0-9-]*$`) |
| `capabilities` | string[] | Capabilities this mod requires from the host |
| `entry` | object \| string \| string[] | The mod's code and its callable API |
| `fills` | object | Contributions, keyed by host slot id (see below) |

## Capabilities

`capabilities` is a flat array of capability names the mod needs, what it *takes*. It is the gate on every binding the mod calls and every slot it fills. A mod that fills a capability-gated slot, or calls a capability-gated binding, must list that capability here.

```json
{
  "capabilities": ["ui-mount", "audio-read"]
}
```

Declaring a capability does not grant it. The host decides what to grant at load time; an ungranted capability blocks the bindings and fills that depend on it.

## Entry

The `entry` block declares the mod's code and the named API the host can invoke.

```jsonc
{
  "entry": {
    "script": "main.js",
    "format": "script",
    "exports": {
      "transcribe": {
        "description": "Transcribe an audio clip to text.",
        "params": [{ "name": "audioUrl", "type": "string" }],
        "returns": "string",
        "capability": "audio-read"
      }
    }
  }
}
```

The bare `entry: "main.js"` and `entry: ["a.js", "b.js"]` forms remain valid (script mode, no exports). The entry script registers each declared export via the runtime-injected `xript.exports.register(name, fn)`; the host invokes by name with JSON-serializable args and receives a JSON-serializable result. Invoking an undeclared or unregistered export, or an export that throws, surfaces a typed invocation error. An export may declare a required `capability`; invoking it without the grant throws a capability-denied error. **Streaming (partial results) is not yet specified.** Only request → single-response is defined in this version.

An export's `params` and `returns` follow the host manifest's rules exactly: a last parameter may be `variadic`, `optional` is the inverse alias of `required`, and `returns` may be `{ "type": <typeRef>, "description": "..." }`. See [Parameters](./manifest.md#parameters) and [Type References](./manifest.md#type-references).

Slot fills reference these exports by name (see the fill shapes below).

### Loading the Entry

Every script the entry names is a script the host must supply when it loads the mod (in the fragment sources a runtime's load call takes; the Rust runtime also accepts one explicit entry source). Each runtime exposes the rule publicly (`modEntryScripts` / `modEntryFormat` / `modEntryExports` in JavaScript, `ModManifest::entry_scripts` / `entry_format` / `entry_exports` in Rust, `ModEntry.Scripts` / `Format` / `Exports` in C#) so a host can collect the right sources before it loads.

Loading is loud by default:

- **An entry script the host did not supply is a load error** naming the mod and the script (`MissingEntryScriptError` and its equivalents). All scripts are checked before any runs, so a mod never half-runs because a later script is missing. An empty string is a supplied script with an empty body
- **An entry that throws is a load error** (the mod entry error), whether the throw is a script's top level, a module body, or a module whose exports could not be read. A typed failure (an execution limit, a refused import, CommonJS) keeps its own type

A host that would rather boot with one broken mod than not boot at all sets the **entry error policy** to `report`. The mod then loads anyway, without whatever its entry did not run; the failure is recorded on the mod instance's diagnostics (`missing-entry-script` or `entry-failed`, severity `error`) instead of thrown. Under either policy every load-time diagnostic also reaches the host's mod diagnostic callback, so the failure is observable even when it is not fatal. Cancellation is the host's own decision and always propagates. The behavior is held to `spec/mod-load-tests.json` by every runtime.

## Fills

`fills` is the canonical contribution surface. It is an object keyed by host slot id; each value is an array of fill entries:

```json
{
  "fills": {
    "sidebar.left": [
      {
        "format": "text/html",
        "source": "fragments/panel.html",
        "bindings": [
          { "name": "health", "path": "player.health.val" }
        ],
        "handlers": [
          { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
        ]
      }
    ]
  }
}
```

A binding may carry fields beyond `name`, `path`, and `type`. These are host-defined extensions: the schema accepts them, runtimes pass them to the host untouched, and a mod that uses one only works on hosts that implement it. See [Binding Fields](./fragments.md#binding-fields).

A fill engages exactly one slot: the key it lives under. The inner shape of a fill entry is governed by that slot's `accepts` type, which the host owns. The mod manifest does not redeclare the slot's type; it conforms to it.

### Representative Fill Shapes

The `accepts` type a slot declares determines the fill's shape and what the host does with it.

**Fragment-format slot** (`accepts` names a fragment format, e.g. `text/html`, `application/j5ml+json`). The fill is an inert fragment the host mounts. The [fragment protocol](./fragments.md) governs this slot type — `data-bind`, `data-if`, the command buffer, and sanitization are its semantics.

```json
{
  "format": "text/html",
  "source": "panel.html",
  "bindings": [{ "name": "health", "path": "player.health.val" }],
  "handlers": [{ "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }]
}
```

**Code-renderer slot** (`accepts` names an executable renderer kind, e.g. `application/javascript+esm`). The fill points the host at code it loads and runs to paint the slot.

```json
{
  "kind": "text",
  "entry": "dist/text.js",
  "label": "Plain Text",
  "icon": "file-text"
}
```

**Role slot** (`accepts` is `application/x-xript-role`). The fill maps logical method names to the concrete `entry` exports that implement them. The host resolves the role and calls the named functions itself.

```json
{
  "fns": {
    "transcribe": "transcribeAudio",
    "detectLanguage": "detectLang"
  }
}
```

**Event/hook slot** (`accepts` is `application/x-xript-hook`). The fill names a handler export the host calls when the event fires. See [hooks.md](./hooks.md).

```json
{
  "handler": "onStartup"
}
```

**Command slot** (`accepts` is `application/x-xript-command`). The fill is a named, invocable action: an `id` the host addresses it by, a `handler` export that runs it, and optional presentation, bound arguments, and JSON Schema signature. The host lists it and invokes it when the user picks it. See [commands.md](./commands.md).

```json
{
  "id": "wrap.double",
  "title": "Wrap in double quotes",
  "handler": "wrapSelection",
  "args": { "open": "\"", "close": "\"" },
  "keywords": ["surround", "quote"],
  "group": "text"
}
```

Bound `args` are merged under the caller's arguments at invoke, shallowly, with the caller winning, so one export can back several parameterized commands instead of forcing a closure per variant. `id` and `handler` are required and are checked at load; `capability` is **not** a key, and a fill carrying one is a hard error, because per-action authority lives on the export the command names (`entry.exports[<handler>].capability`).

**Data slot** (`accepts` names a data format the host reads, e.g. `application/json`). The fill is pure metadata — no fragment, no code, no handler. The host reads it and applies its own policy. This is the canonical shape for grouping and curation surfaces: a host that wants mods to declare collection membership, ordering, or pack-style bundles declares a data slot with a `payload` schema describing the metadata, and a "grouping mod" is simply a mod whose only contribution is a data fill.

```json
{
  "members": ["mod-one", "mod-two", "mod-three"],
  "label": "Starter Pack"
}
```

The slot's `payload` schema validates the fill's shape (`xript validate --cross` enforces it); what the host *does* with the metadata (discovery gating, ordering, bundling) is host policy, deliberately outside the spec. No dedicated grouping primitive exists because none is needed: a typed slot plus a payload-schema'd data fill already carries the whole pattern.

### Multiple Fills per Slot

The value under each slot id is always an array. A slot the host declared with `"multiple": true` accepts more than one fill; a single-fill slot resolves a deterministic winner (the [fragment protocol](./fragments.md) defines ordering for fragment-format slots). Authoring a single fill still uses a one-element array.

## Validation Contract

When a mod is loaded against a host, the runtime validates each slot id in `fills`:

1. The slot id must exist in the host's `slots` (matched by `id`).
2. If the slot declares a `capability`, the mod must list that capability in its `capabilities`.

The runtime does **not** police the inner shape of a fill; that is the slot type's contract, enforced by whatever consumes the fill (the fragment processor, the renderer, the role resolver, the hook dispatcher, the command normalizer). A fill into an undeclared slot, or into a capability-gated slot the mod lacks the capability for, is an error.

### Extending the Mod Vocabulary

Like the core [host manifest](./manifest.md#extending-the-core-vocabulary), the mod manifest schema is **open at the top level** so a domain can add its own surfaces and still validate against core. A domain overlay composes the two:

```json
{
  "$schema": "https://example.dev/schemas/my-domain-mod.schema.json",
  "allOf": [
    { "$ref": "https://xript.dev/schema/mod-manifest/v0.8.json" },
    { "properties": { "myDomainSurface": { "type": "object" } }, "unevaluatedProperties": false }
  ]
}
```

The published schema document carries no top-level `additionalProperties`/`unevaluatedProperties`. `@xriptjs/validate` flags an unrecognized top-level key, but as an **advisory warning, not an error**; the manifest still validates. This is deliberate: the runtime reads only the declared vocabulary and ignores a stray top-level key, so it has no runtime effect, and a hard error would block a key that does nothing. The warning exists to catch the *silent* case (a typo of an optional key like `capabilties` that would otherwise leave the real key absent with no signal); a key a declared `$schema` overlay accounts for is evaluated and draws no warning at all. Nested closures (a handler's or a legacy fragment's inner shape) remain hard errors, with one deliberate exception: a fragment binding accepts host-defined extension fields (see [Binding Fields](./fragments.md#binding-fields)).

Because a stray top-level key is inert, it is **not an access surface** — nothing in the runtime or the sandbox ever reads it. When you want data a host actually consumes, use a payload-schema'd [data fill](#representative-fill-shapes) into a data slot (the host receives it keyed by slot id, checked by `--cross`); for host-provided values a mod reads, use a binding. Reach for a top-level overlay only for manifest-wide domain metadata that an external tool or a human reads off the JSON directly.

## Deprecated Aliases

Two earlier top-level surfaces fold into `fills`. Validators still accept them and emit a deprecation warning so migration is smooth; new manifests should use `fills` only.

### `fragments` → fragment-format slot fills

The former top-level `fragments` array is a list of fills of fragment-format slots. Each legacy fragment's `slot` field becomes the `fills` key; the rest of the entry is the fill.

```jsonc
// deprecated
{ "fragments": [ { "id": "health-panel", "slot": "sidebar.left", "format": "text/html", "source": "panel.html" } ] }

// equivalent
{ "fills": { "sidebar.left": [ { "format": "text/html", "source": "panel.html" } ] } }
```

### `contributions.provides` → role slot fills

The former `contributions.provides` array is a list of fills of role-type slots. Each entry's `role` becomes the `fills` key; its `fns` map becomes the fill.

```jsonc
// deprecated
{ "contributions": { "provides": [ { "role": "clipboard-history", "fns": { "query": "clipHistory_query" } } ] } }

// equivalent
{ "fills": { "clipboard-history": [ { "fns": { "query": "clipHistory_query" } } ] } }
```

`contributions.slots` was always just fills — its entries move under `fills` unchanged.

## Format Renderers Are Not Manifest Concepts

A format renderer (a terminal-widget renderer, a DOM fragment processor, a future native-widget renderer) is runtime infrastructure, not a slot or a fill. It paints a fragment of format `F` onto a target. A slot's `accepts` type names the format the runtime must be able to render; the renderer that does the painting lives in the runtime, not the manifest. Do not model renderers as slots or fills.
