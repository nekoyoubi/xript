# xript Mod Manifest Specification

A mod manifest is a JSON file declaring what a mod needs from a host and what it contributes back. It is distinct from the app manifest: the app manifest describes the surface a host exposes; the mod manifest describes the code and contributions a mod plugs into that surface.

The schema lives at [`mod-manifest.schema.json`](./mod-manifest.schema.json).

## The Shape: Host Slots, Mod Fills

A host declares a surface of named, typed plug-points called **slots**. A mod engages that surface two ways:

- **bindings** — callables the host implements; the mod *calls* them.
- **fills** — typed plug-points the host declares as slots; the mod *fills* them.

Everything a mod contributes is a fill. A UI fragment, a provider role, and a lifecycle hook handler are not separate top-level concepts — each is a fill of a slot of a particular type. The target slot's `accepts` type governs what a valid fill looks like and what the host does with it: mount it, call it, resolve it, or fire it.

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

`capabilities` is a flat array of capability names the mod needs — what it *takes*. It is the gate on every binding the mod calls and every slot it fills. A mod that fills a capability-gated slot, or calls a capability-gated binding, must list that capability here.

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

The bare `entry: "main.js"` and `entry: ["a.js", "b.js"]` forms remain valid (script mode, no exports). The entry script registers each declared export via the runtime-injected `xript.exports.register(name, fn)`; the host invokes by name with JSON-serializable args and receives a JSON-serializable result. Invoking an undeclared or unregistered export, or an export that throws, surfaces a typed invocation error. An export may declare a required `capability`; invoking it without the grant throws a capability-denied error. **Streaming (partial results) is not yet specified** — only request → single-response is defined in this version.

Slot fills reference these exports by name (see the fill shapes below).

## Fills

`fills` is the canonical contribution surface. It is an object keyed by host slot id; each value is an array of fill entries:

```json
{
  "fills": {
    "sidebar.left": [
      {
        "format": "text/html+jsml",
        "source": "fragments/panel.html",
        "bindings": [
          { "name": "health", "path": "player.health.val" }
        ],
        "events": [
          { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
        ]
      }
    ]
  }
}
```

A fill engages exactly one slot — the key it lives under. The inner shape of a fill entry is governed by that slot's `accepts` type, which the host owns. The mod manifest does not redeclare the slot's type; it conforms to it.

### Representative Fill Shapes

The `accepts` type a slot declares determines the fill's shape and what the host does with it.

**Fragment-format slot** (`accepts` names a fragment format, e.g. `text/html+jsml`, `application/jsml+json`). The fill is an inert fragment the host mounts. The [fragment protocol](./fragments.md) governs this slot type — `data-bind`, `data-if`, the command buffer, and sanitization are its semantics.

```json
{
  "format": "text/html+jsml",
  "source": "panel.html",
  "bindings": [{ "name": "health", "path": "player.health.val" }],
  "events": [{ "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }]
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

### Multiple Fills per Slot

The value under each slot id is always an array. A slot the host declared with `"multiple": true` accepts more than one fill; a single-fill slot resolves a deterministic winner (the [fragment protocol](./fragments.md) defines ordering for fragment-format slots). Authoring a single fill still uses a one-element array.

## Validation Contract

When a mod is loaded against a host, the runtime validates each slot id in `fills`:

1. The slot id must exist in the host's `slots` (matched by `id`).
2. If the slot declares a `capability`, the mod must list that capability in its `capabilities`.

The runtime does **not** police the inner shape of a fill — that is the slot type's contract, enforced by whatever consumes the fill (the fragment processor, the renderer, the role resolver, the hook dispatcher). A fill into an undeclared slot, or into a capability-gated slot the mod lacks the capability for, is an error.

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
