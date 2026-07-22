# xript Manifest Specification

The xript manifest is the single source of truth for an application's scripting API. It declares what functionality is exposed to scripts, how it is organized, what capabilities gate access, and what types are involved. From the manifest, everything else is derived: documentation, TypeScript definitions, and validation. Interactive playgrounds are also supported as a toolchain output.

This document explains the structure of the manifest, the rationale behind key decisions, and how the manifest supports xript's four adoption tiers.

## Overview

A manifest is a JSON file conforming to the [manifest JSON Schema](./manifest.schema.json). At minimum, a manifest declares a spec version and a name:

```json
{
  "xript": "0.8",
  "name": "my-app"
}
```

From there, complexity is layered on only as needed. The schema is designed so that every field beyond `xript` and `name` is optional, and each additional section enables more functionality.

## Top-Level Fields

### `xript` (required)

The specification version this manifest conforms to. This is not the application's version; it's the version of the xript spec the manifest was written against. Runtimes use this to determine which features and validation rules apply.

Format: `major.minor` (e.g., `"0.1"`). Patch versions are intentionally excluded, since the spec level doesn't change for non-breaking fixes.

### `name` (required)

A machine-readable identifier for the application. Used in generated package names (`@xriptjs/<name>-types`), documentation URLs, and tooling output.

Constraints: lowercase letters, numbers, and hyphens. Must start with a letter. Maximum 64 characters. This mirrors npm package naming conventions because the generated types will live in that ecosystem.

### `version`

The version of the application's scripting API, following semver. This is distinct from `xript`; it tracks how the application's exposed bindings evolve over time.

When a binding is added, the minor version increments. When a binding's signature changes in a breaking way, the major version increments. This versioning drives compatibility checks and generated type package versioning.

### `title`

A human-readable display name. While `name` is `"skyrim-modkit"`, `title` might be `"Skyrim Mod Toolkit"`. Used in documentation headers and UI.

### `description`

A brief description aimed at modders. Tells them what the application does and what they can extend. Used in documentation landing pages and registry listings.

## Bindings

Bindings are the core of the manifest. They define the functions and namespaces that scripts can call.

### Function Bindings

A function binding declares a callable function:

```json
{
  "bindings": {
    "getHealth": {
      "description": "Returns the player's current health points.",
      "returns": "number"
    }
  }
}
```

Every function binding requires a `description`. This is not optional because if a modder can't understand what a function does, it may as well not exist. The description appears in generated docs, TypeScript JSDoc comments, and editor tooltips.

Optional fields on function bindings:

- **`params`** — an ordered array of parameters, each with a `name`, `type`, and optional `description` and `default`
- **`returns`** — the return type (omit for void functions)
- **`async`** — whether the function returns a promise (defaults to `false`)
- **`capability`** — the capability required to call this function
- **`examples`** — usage examples for documentation
- **`deprecated`** — marks the function as deprecated with a migration message

### Namespace Bindings

Namespaces group related functions. They create the `namespace.function()` calling convention:

```json
{
  "bindings": {
    "player": {
      "description": "Functions related to the player character.",
      "members": {
        "getHealth": {
          "description": "Returns the player's current health points.",
          "returns": "number"
        },
        "setHealth": {
          "description": "Sets the player's health points.",
          "params": [
            { "name": "value", "type": "number", "description": "The new health value." }
          ]
        }
      }
    }
  }
}
```

Namespaces can nest arbitrarily (`game.world.weather.setRain()`), but deep nesting is discouraged; two levels is usually plenty.

A binding is distinguished as a namespace by the presence of `members`. A binding with both `members` and `params` is invalid.

### Why Bindings Are a Flat Object, Not Nested by Default

Bindings are declared as a flat key-value map at the top level (`"getHealth": {...}`) rather than being implicitly grouped. Namespaces exist as an explicit opt-in via `members`. This keeps the simple case simple (one function = one key) while allowing organization when needed.

## Capabilities

Capabilities implement the default-deny security model. Every capability is a named permission that must be explicitly granted before scripts can use the functionality it protects.

```json
{
  "capabilities": {
    "filesystem": {
      "description": "Read and write files in the mod's data directory.",
      "risk": "medium"
    },
    "network": {
      "description": "Make HTTP requests to allowed domains.",
      "risk": "high"
    }
  }
}
```

Capabilities are referenced by name in function bindings via the `capability` field. A function with `"capability": "filesystem"` is only callable if the script has been granted the `filesystem` capability.

The `risk` field is advisory; it helps users make informed decisions about what to grant. It does not affect runtime behavior. Runtimes may use it to display warnings or require additional confirmation for `high` risk capabilities.

Functions without a `capability` field are always available to any script. This is intentional: the common case is that most bindings are safe read-only operations that don't need gating.

## Types

Custom types let the manifest describe complex data structures used in bindings.

### Object Types

```json
{
  "types": {
    "Position": {
      "description": "A 2D position in world coordinates.",
      "fields": {
        "x": { "type": "number", "description": "Horizontal position." },
        "y": { "type": "number", "description": "Vertical position." }
      }
    }
  }
}
```

An object type can be marked `"abstract": true` to declare a contract hole with no `fields` of its own, expecting an extending manifest to fill it. See [Abstract Types](./extends.md#abstract-types).

### Enum Types

```json
{
  "types": {
    "Direction": {
      "description": "A cardinal direction.",
      "values": ["north", "south", "east", "west"]
    }
  }
}
```

An enum type can also be abstract: a `description` with `"abstract": true` and no `values`, leaving the concrete `values` for an extending manifest to fill. See [Filling Abstract Types](./extends.md#the-three-moves-add-fill-refine).

### Field Defaults and Inline Enums

Object-type fields carry optional `default` and inline `enum` metadata:

```json
{
  "types": {
    "BrickFiles": {
      "description": "File-viewer configuration for a brick.",
      "fields": {
        "path": { "type": "string", "optional": true, "description": "Path to display." },
        "pathStyle": { "type": "string", "enum": ["posix", "hybrid", "native"], "default": "posix" },
        "viewingEnabled": { "type": "boolean", "default": true }
      }
    }
  }
}
```

- `default` declares the value used when the field is absent.
- `enum` declares the allowed literal values for the field.

Both are **documentation and codegen hints only**. xript does not apply defaults, does not enforce enum membership, and reads neither at runtime. Codegen consumes them: a field with a `default` becomes non-optional in the generated interface (the host can rely on a value being present), and an inline `enum` becomes a literal union type.

An enum field may instead reference a named `values`-based type definition (`{ "type": "PathStyle" }` where `PathStyle` declares `values`). The inline `enum` form and the named-enum form generate identical TypeScript.

### Record Schemas via Types

Addon-owned record shapes are expressed as ordinary object type definitions — there is no separate records block, no key field, and no record vocabulary in the schema. A record type **is** a custom object type whose `fields` carry `type`, `optional`, `default`, and `enum`.

xript stays persistence-agnostic. It owns no store, reads and writes nothing, validates no field at runtime, and has no migration story. The type definition is purely a source of truth for documentation and code generation. Strictness, cross-addon writes, and migration are host concerns: the type def supplies the shape, and the host decides enforcement. Schema evolution over time is narrated through the manifest's own semver.

For codegen, typegen emits a companion `<TypeName>Accessor` interface alongside the plain interface, exposing typed get/set per field so a host that backs records with its own store gets typed access without xript ever seeing that store.

### Type References

Anywhere a type is expected, you can use:

- **Primitives**: `"string"`, `"number"`, `"boolean"`, `"void"`, `"null"`
- **Custom types**: `"Position"`, `"Direction"` (references to the `types` section)
- **Array shorthand**: `"string[]"`, `"Position[]"`
- **Complex expressions**: `{ "array": "Position" }`, `{ "union": ["string", "number"] }`, `{ "map": "number" }`, `{ "optional": "string" }`

The shorthand `"string[]"` is equivalent to `{ "array": "string" }`. Both are valid. The shorthand exists because array types are common and the verbose form is noisy for simple cases.

## Slots

Slots are the host's typed fill surface, the counterpart to bindings. A binding is a callable the host implements and the mod *calls*. A slot is a typed plug-point the host declares and the mod *fills*. Everything a mod contributes is a fill of a slot; the slot's `accepts` type governs what a valid fill looks like and what the host does with it: mount it, call it, resolve it, fire it.

```json
{
  "slots": [
    {
      "id": "sidebar.left",
      "accepts": ["text/html"],
      "capability": "ui-mount",
      "multiple": true,
      "style": "isolated"
    }
  ]
}
```

### Slot Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Unique slot identifier (`^[a-z][a-z0-9.-]*$`) |
| `accepts` | string[] | yes | — | Format(s)/kind(s) this slot takes (see slot types) |
| `capability` | string | no | — | Capability required to fill this slot |
| `multiple` | boolean | no | false | Whether more than one mod can fill this slot |
| `refines` | boolean | no | false | When set, deep-merges onto a base slot of the same `id` (see below) |
| `style` | enum | no | "inherit" | Styling mode, for fragment-format slots |

A slot in an extending manifest can redeclare a base slot `id` with `"refines": true` to deep-merge onto it, including its payload member types. Without the marker, redeclaring a base slot `id` is a resolution error. See [Refining Concrete Types and Slots](./extends.md#the-three-moves-add-fill-refine).

### Slot Types

A slot's `accepts` names the format(s) or kind(s) of fill it takes. The type determines what a fill looks like and what the host does with it:

- **Fragment-format slots** — `accepts` names a fragment format: one of the four built-in ones (`text/html`, `text/html+jsml`, `application/j5ml+json`, `application/jsml+json`), or one the host declares itself in [`formats`](#fragment-formats). The host *mounts* the fill as an inert fragment. The [fragment protocol](./fragments.md) is the semantics of this slot type.
- **Code-renderer slots** — `accepts` names an executable renderer kind (e.g. `application/javascript+esm`). The host *loads and runs* the fill's code to paint the slot.
- **Role slots** — `accepts` is `application/x-xript-role`. The host *resolves* the fill's logical-to-concrete function map and calls the named functions itself.
- **Event slots** — `accepts` is `application/x-xript-hook`; the host *fires* the slot, calling each fill's named handler when the event occurs. This is the modern replacement for the standalone `hooks` concept below.
- **Command slots** — `accepts` is `application/x-xript-command`. Each fill is a named, invocable action backed by a mod export; the host *lists* them (a palette, a menu, a keybinding table) and *invokes* the one the user picked. See [Command Slots](#command-slots) below and [commands.md](./commands.md).

The three `application/x-xript-*` types are **reserved**: they carry no markup, are never sanitized, and cannot be redeclared in [`formats`](#fragment-formats). When a slot's `accepts` names more than one of them, they are matched in a fixed order: role, then hook, then command.

Mods fill slots through the `fills` surface in their mod manifest; see [mod-manifest.md](./mod-manifest.md).

### Styling Modes

For fragment-format slots, `style` controls how host styles reach the fragment:

- **`inherit`** — fragment inherits host styles. Suitable for inline UI like status bars.
- **`isolated`** — no host styles bleed into the fragment. Suitable for panels and overlays. On the web, implemented via Shadow DOM or equivalent.
- **`scoped`** — host exposes CSS custom properties / design tokens; the fragment uses them.

## Hooks (deprecated — use event-typed slots)

> **Deprecated.** A lifecycle hook is an event-typed slot (`accepts: ["application/x-xript-hook"]`) whose fills are handlers the host calls when the event fires. Declare lifecycle events as slots and let mods fill them. The `hooks` field remains allowed for back-compat. Hosts still fire hooks and runtimes still dispatch them, but new manifests should model events as slots. See [hooks.md](./hooks.md).

Hooks are the reverse of bindings. While bindings let scripts call the host, hooks let the host call scripts. They enable the event-driven programming model that real modding requires: "when the player takes damage," "before the game saves," "after a level loads."

### Simple Hooks

A hook without lifecycle phases is a simple notification:

```json
{
  "hooks": {
    "playerDamage": {
      "description": "Fired when the player takes damage.",
      "params": [
        { "name": "amount", "type": "number", "description": "Damage amount." },
        { "name": "source", "type": "string", "description": "What caused the damage." }
      ]
    }
  }
}
```

Scripts register handlers: `hooks.playerDamage((amount, source) => { ... })`. The host fires the hook via `runtime.fireHook("playerDamage", { amount: 25, source: "trap" })`.

### Phased Hooks

Hooks can declare lifecycle phases for structured interception:

```json
{
  "hooks": {
    "save": {
      "description": "Fired during the save lifecycle.",
      "phases": ["pre", "post", "done", "error"],
      "capability": "persistence",
      "params": [
        { "name": "data", "type": "SaveData" }
      ]
    }
  }
}
```

Scripts register per-phase: `hooks.save.pre((data) => { ... })`. Multiple handlers per phase run in registration order.

The four standard phases are `pre` (before execution), `post` (after execution, can modify), `done` (after all post-processing, sealed), and `error` (after failure). Hosts declare which phases apply and control firing order.

### Hook Properties

Optional fields on hooks mirror bindings where appropriate:

- **`phases`** — lifecycle phases (`pre`, `post`, `done`, `error`). Omit for simple hooks.
- **`params`** — parameters passed to handlers when the hook fires
- **`capability`** — capability required to register for this hook
- **`async`** — whether handlers run asynchronously (host-controlled, defaults to `false`)
- **`limits`** — per-handler execution limits, overriding manifest defaults
- **`examples`** — usage examples for documentation
- **`deprecated`** — marks the hook as deprecated with a migration message

See [hooks.md](./hooks.md) for the full hook conventions, error handling, and TypeScript mapping.

## Events (Host Broadcast Catalog)

The optional top-level `events` array is the named events a host **emits** and the payload each carries. It says "here is what this application broadcasts," and through the shared dispatch engine that hooks already use, it is *deliverable*: a sandbox script subscribes with `events.on("<id>", handler)`, the host's own UI may react, an external subscriber may observe. The catalog names the signal; sandbox delivery rides the hook registry/fire engine rather than introducing a parallel event subsystem (see [Event Delivery](./hooks.md#event-delivery)).

```json
{
  "events": [
    {
      "id": "player.damaged",
      "description": "Broadcast after the player takes damage, once the new health is committed.",
      "payload": "DamageEvent"
    },
    {
      "id": "level.loaded",
      "description": "Broadcast after a level finishes loading and is interactive.",
      "capability": "read:world"
    }
  ]
}
```

### Event Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Event identifier, the name the host broadcasts under |
| `description` | string | yes | What the event signals and when it fires |
| `payload` | typeRef | no | The type of the data carried with the event (a [type reference](#type-references)) |
| `capability` | capabilityRef | no | Capability required to subscribe via `events.on`. If omitted, any script may subscribe. Gated at registration time, reusing the hook gate model. |

### Three Surfaces, One Distinction

`events`, event-typed slots, and fragment handlers all touch "events," but they answer different questions, and the manifest keeps the line clean:

- **`events` (this surface)** — *what the host emits.* A catalog of broadcasts the application produces. A sandbox script subscribes with `events.on(id, fn)`; the host delivers with `emit(id, payload)`. (See [Event Delivery](./hooks.md#event-delivery).)
- **Event-typed slots** (`accepts: ["application/x-xript-hook"]`) — *extension points addons fill.* The host declares the plug-point; a mod fills it with a handler the host calls when the event fires. (See [Slot Types](#slot-types).)
- **Fragment `handlers`** — *DOM responses on a fragment fill.* A `{ selector, on, handler }` entry wiring a sandboxed function to a DOM event on mounted markup. (See the [fragment protocol](./fragments.md#event-routing).)

In one line: bindings are *what you can call*, slots and fragment handlers are *what handles*, and `events` is *what the host emits and a mod subscribes to*.

The catalog is a source of truth for documentation and code generation: typegen emits a typed event catalog, docgen renders an events section. Sandbox delivery and the event-typed-slot hook dispatch share one engine: a keyed handler registry plus a fire-from-registry pass. As with the rest of the manifest, xript declares the shape; the host owns dispatch.

## Libraries (Approved Import Allow-List)

The optional top-level `libraries` map is the host's **curated allow-list of importable libraries**: whole pre-bundled modules (a markdown renderer, a date library) that mod code may pull in with a real static `import`. Imports stay default-deny; an entry here is the only thing that lifts the deny, and only for mods holding the entry's capability. This is the capability model applied to modules: the host curates *which* libraries exist, the capability gates *which mods* may import each.

```json
{
  "libraries": {
    "@example/doc": {
      "description": "Shared markdown + doc rendering.",
      "capability": "lib.doc",
      "version": "^1.0.0"
    },
    "luxon": {
      "description": "Date/time parsing, formatting, and arithmetic.",
      "capability": "lib.luxon"
    }
  }
}
```

An approved library runs **inside the sandbox at the importing mod's own privilege**: full-fidelity calls, no JSON boundary, and no new power granted. The manifest declares the allow-list; the host supplies each library's source when it constructs the runtime. A library must be **import-clean** (a self-contained bundle with no imports of its own), and its `capability` scope must be declared in `capabilities` like any other gate. Contrast with bindings: a binding runs *host-side* with host privilege behind a JSON boundary; a library runs *sandbox-side* with mod privilege. Pure compute belongs in a library; privileged operations stay bindings. Full semantics, the resolution order, and the import-clean rule live in [Modules — Approved Libraries](./modules.md#approved-libraries).

### Library Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | yes | What the library provides to mod code |
| `capability` | capabilityRef | no | Capability a mod must hold to import it. If omitted, any mod may import it. Checked at link time under subsumption (`lib` ⊇ `lib.doc`) |
| `version` | string | no | The version or semver range the host ships (the contract mod authors compile against) |
| `deprecated` | string | no | If present, the library is deprecated; the value says what to use instead |

## Fragment Formats

`slots[].accepts` names the fragment format a slot takes. `formats` says what that format *means*: how a fill of that media type is parsed, which node vocabularies are in scope while it is read, and — through those vocabularies — which props each node accepts and where each prop's value lands.

```json
{
  "formats": {
    "application/x-panel+json": {
      "syntax": "j5ml",
      "nodes": {
        "Panel": { "props": { "heading": { "type": "string" } } },
        "Link":  { "children": "text", "props": { "href": { "type": "string", "sink": "uri" } } }
      }
    }
  },
  "slots": [
    { "id": "sidebar.left", "accepts": ["application/x-panel+json"] }
  ]
}
```

The four built-in formats need no declaration: each brings the built-in `html` vocabulary into scope and nothing else, which is what a manifest carrying no `formats` block gets. A host declares `formats` when it wants a fragment to carry something other than HTML — component nodes, terminal widgets, desktop controls — with node names that keep their case and props that keep their type.

### Format Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `syntax` | `"j5ml"` \| `"jsml"` \| `"html"` | yes | — | The parser a runtime reads a fill's `source` with. `j5ml` reads JSON in J5ML array form, `html` tokenizes an HTML string; `jsml` is a deprecated spelling of `j5ml` and parses identically |
| `vocabularies` | string[] | no | — | The node vocabularies in scope, in resolution order. Each entry names a built-in vocabulary (`html`) or one this manifest declares in [`vocabularies`](#vocabularies) |
| `nodes` | object | no | — | An inline single-use vocabulary, resolved ahead of every entry in `vocabularies`. Names are case-sensitive |
| `schemes` | string[] | no | `["http", "https", "mailto", "data"]` | The URI schemes a `uri` or `image-uri` sink admits, named without the colon. Declaring the key **replaces** the default set rather than extending it, so the one key both widens (`tauri`) and narrows (`https` alone); `[]` closes the format to absolute URLs. `javascript` and `vbscript` are refused and cannot be declared |
| `description` | string | no | — | What the format is for |
| `refines` | boolean | no | false | Refines a base manifest's format of the same id (see [extends.md](./extends.md)) |

A format must admit at least one node: `nodes`, a non-empty `vocabularies`, or both. `nodes` and `vocabularies` answer different questions — `syntax` is how a fill is *read*, `vocabularies` is what is *in scope* while reading it — and an inline `nodes` block is exactly a vocabulary that happens to have no id, so nothing else can reference it. Declare a vocabulary in [`vocabularies`](#vocabularies) when more than one format will speak it; inline it otherwise.

Each node declares `props` (each a JSON Schema), a `children` constraint, and an optional `bindTo` naming where a `data-bind` value lands. A prop's `sink` (`text` — the default — `uri`, `image-uri`, `css`, `html`) declares where its value ends up, and is the *only* thing the runtime needs to know in order to sanitize it correctly. A prop with no sink is inert data and is never touched. The format's `schemes` says which absolute URLs the two URI sinks admit; a value carrying no scheme is relative and is never measured against it.

A host **cannot** redeclare a built-in or reserved media type in `formats`; a host that wants a component vocabulary registers a new media type. The full model — vocabulary resolution, the sink table, the tree contract, default-deny semantics — is in [fragment-formats.md](./fragment-formats.md).

## Vocabularies

A format names a parser and a scope. A **vocabulary** is what fills that scope: a set of node names with their props, and nothing at all about how they are authored. The optional top-level `vocabularies` map declares them, keyed by id, so that any number of formats may bring the same one into scope — under different syntaxes, and alongside different neighbours.

```json
{
  "vocabularies": {
    "acme.components": {
      "description": "The component set the design system ships.",
      "nodes": {
        "acme-icon": { "children": "none", "props": { "name": { "type": "string" } } },
        "acme-card": { "props": { "heading": { "type": "string" } } }
      }
    }
  },
  "formats": {
    "text/x-acme+html": {
      "syntax": "html",
      "vocabularies": ["acme.components", "html"]
    },
    "application/x-acme+json": {
      "syntax": "j5ml",
      "vocabularies": ["acme.components"]
    }
  }
}
```

Those two formats are the shape this surface exists for. The component library authors its own components as HTML, with the whole HTML element vocabulary in scope beside them. An application embedding that library exposes **the same** component vocabulary to mod authors under a J5ML syntax with no HTML in scope at all — so a mod can reach every component and no element, and the application cannot be extended with markup. Same nodes, different syntax, different scope, declared once. Welding the three together, as a format did when it carried its own vocabulary and an HTML on/off switch, forces a host to maintain two copies of one component list and keep them honest by hand.

### Vocabulary Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodes` | object | yes | — | The nodes this vocabulary declares, at least one. Names are case-sensitive and matched verbatim |
| `description` | string | no | — | What the vocabulary is for. Shown in generated docs |
| `refines` | boolean | no | false | Refines a base manifest's vocabulary of the same id (see [extends.md](./extends.md)) |

Node bodies are identical to the ones a format's inline `nodes` block carries, and are specified in [fragment-formats.md](./fragment-formats.md).

### Two Grammars

Vocabulary ids come in two grammars, and which kind of thing a reference names is readable from the name alone, without a lookup:

- **Built-in** — a single lowercase segment. `html` is currently the only one. Built-ins are *referenceable but not declarable*: a format lists `html` in its `vocabularies` like any other entry, and a `vocabularies` block that tries to declare it is refused.
- **Host-declared** — two or more lowercase dot-separated segments, `acme.components`. These are the ids a manifest declares and formats reference.

The grammars are disjoint by construction, so a host can never shadow a built-in and a reader never has to resolve an id to learn what sort of vocabulary it is. This is the same split-on-purpose reasoning the [binding grammars](./bindings.md) follow.

### Scope and Resolution

`vocabularies` on a format is an ordered list, and the order is authoritative: **the first vocabulary that claims a node name wins**. A format's inline `nodes` block always resolves first, ahead of every named entry. The built-in `html` vocabulary, when in scope, must be the last entry — an HTML element name is only reachable once every declared vocabulary has declined it, which is what keeps a declared node winning over a same-named element.

Resolution stays default-deny: a node name no vocabulary in scope claims is an error, not a silent drop.

### Containment Is a Separate Axis

A vocabulary declares what a node **is** — its props, its sinks, its bind target. It never declares what a node may *parent*. Containment is its own axis and it defaults **open**: anything in scope may nest inside anything else in scope, across vocabulary boundaries, in any combination. The only thing that narrows it is a node's own `children` constraint, which a node states about itself and which is not scoped by vocabulary — a node listing permitted children names them wherever they come from.

## Execution Limits

The `limits` section sets default bounds for script execution:

```json
{
  "limits": {
    "timeout_ms": 5000,
    "memory_mb": 64,
    "max_stack_depth": 256
  }
}
```

These are defaults that runtimes enforce unless the host application overrides them at runtime. They exist in the manifest so that the application author can declare sensible defaults for their use case: a game mod system might allow 100ms per frame tick, while a data processing tool might allow 30 seconds.

### Per-slot budgets

A single budget cannot suit every surface at once: a slot whose fills legitimately run long inherits one tuned for something briefer, and a slot handling untrusted input inherits one tuned for something trusted. A slot may therefore declare its own `limits`, which replaces the manifest's for calls into that slot's fills:

```json
{
  "slots": [
    {
      "id": "report.generators",
      "accepts": ["application/x-xript-command"],
      "description": "Report generation, which is allowed to take its time.",
      "multiple": true,
      "limits": { "timeout_ms": 30000 }
    }
  ]
}
```

A slot may **raise** the budget as well as lower it. The host declares both the manifest budget and the slot's, so neither direction is an escalation — a mod cannot buy itself more time by filling a slot, because it never wrote the number. The embedder's hard limits still clamp the result, so a manifest can never exceed what the application embedding the runtime allowed. Fields left out inherit the manifest's `limits`; where neither declares one, the schema default applies.

`slotExecutionLimits` carries **`timeout_ms` alone**, and the omission is deliberate. `memory_mb` and `max_stack_depth` are properties of a runtime at the moment it is created in all four engines, so a per-slot value for either could not be enforced without standing up a separate runtime. That path already exists: route the slot with `execution.affinity` and give the worker its own limits. Declaring keys no engine can honour would promise enforcement and deliver nothing.

`limits` is the enforcement counterpart to `execution`, which is advisory routing. A slot can carry both: `execution` tells a host *where* to run the fills, `limits` bounds them once they run. `limits` is declarable on a slot and on a hook, never on a binding — a binding is host code, and once control is inside it no xript timeout reaches it.

The rule deciding which budget governs a call is pinned by `spec/slot-limit-tests.json` and asserted by all four runtimes.

## Adoption Tiers

The manifest supports xript's four adoption tiers through progressive complexity.

### Tier 1: Expressions Only

The simplest manifest. No bindings, no capabilities. The application uses xript purely as a safe eval replacement for user-provided expressions.

```json
{
  "xript": "0.8",
  "name": "calculator"
}
```

The runtime provides only the JavaScript language itself — no host bindings. This is useful for formula fields, template expressions, and user-defined calculations.

### Tier 2: Simple Bindings

The application exposes a few functions. No capabilities needed because everything exposed is inherently safe.

```json
{
  "xript": "0.8",
  "name": "my-game",
  "version": "1.0.0",
  "title": "My Game",
  "bindings": {
    "getPlayerName": {
      "description": "Returns the current player's display name.",
      "returns": "string"
    },
    "getHealth": {
      "description": "Returns the player's current health (0-100).",
      "returns": "number"
    },
    "log": {
      "description": "Logs a message to the mod console.",
      "params": [
        { "name": "message", "type": "string" }
      ]
    }
  }
}
```

### Tier 3: Advanced Scripting

Namespaces organize a rich API. Capabilities gate sensitive operations. Custom types describe complex data. Examples document usage.

See the [game mod system example](../examples/game-mod-system/) for a full tier 3 manifest and walkthrough.

### Tier 4: Full Feature

Slots and mod manifests. The host declares typed slots; mods fill them: fragments that bind to host state and handle interaction, roles the host resolves, event handlers the host fires.

See the [UI dashboard example](../examples/ui-dashboard/) for a full tier 4 integration.

## Manifest Inheritance (`extends`)

A manifest may inherit from one or more base manifests via the optional top-level `extends` field (a path string or an array of path strings):

```jsonc
{
  "xript": "0.8",
  "extends": "./host.json",
  "name": "my-workflow",
  "bindings": { /* only new bindings; base bindings are merged in */ }
}
```

Resolution happens before schema validation, performed identically by loaders and tools:

- **Maps merge**: `bindings`, `capabilities`, `hooks`, and `types` are key-merged; the child augments the base.
- **Arrays append**: `slots` append, deduped by slot `id`.
- **Scalars: child wins**: `name`, `version`, `title`, `description`, `xript`.
- **Transitive with cycle detection**: a base may itself `extends` another; cycles error.
- **Paths are relative** to the extending manifest's location. Remote and URL bases are not supported in this version.

When `extends` is an array, bases merge left-to-right (the child applies last). The resolved manifest is a flat, schema-valid manifest; the runtime never sees `extends` after resolution.

A name present in both base and child resolves by one of three moves: **add** a name the base never declared, **fill** an abstract base type, or **refine** a concrete one with `refines: true`. An un-opted concrete-name collision is an error, not a silent override. The full model (abstract types, the three moves, deep-merge semantics, and the `abstract-type-unfilled` lint) is documented in [Manifest Extension and Inheritance](./extends.md).

## Mod Manifest `family`

The mod manifest carries an optional top-level `family` string (pattern `^[a-z][a-z0-9-]*$`) for host-side grouping of addons (e.g. a nav rail). When absent, hosts fall back to name-prefix heuristics. The runtime stores and round-trips `family` but does not branch on it; grouping is host policy. `display_name` is intentionally not added; the existing `title` field covers it.

## Host-Invokable Exports

A mod's `entry` block may declare named exports the host can invoke and whose return value it honors:

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

The bare `entry: "main.js"` / `entry: ["a.js", "b.js"]` forms remain valid (script mode, no exports). The entry script registers each declared export via the runtime-injected `xript.exports.register(name, fn)`; the host invokes by name with JSON-serializable args and receives a JSON-serializable result. Invoking an undeclared or unregistered export, or an export that throws, surfaces a typed invocation error. An export may declare a required `capability`; invoking it without the grant throws a capability-denied error. **Streaming (partial results) is not yet specified.** Only request → single-response is defined in this version.

## Role Slots and Resolution

A role slot (`accepts: ["application/x-xript-role"]`) is a host-declared plug-point that any mod can fill. Instead of core UI hardcoding a mod-specific global function name, the host declares a role slot, mods fill it with a logical-to-concrete function map, and the host asks the runtime to resolve the slot, getting back the mod that fills it plus the map from logical method names to the concrete function names that mod registered.

A mod fills a role slot through its `fills` surface (see [mod-manifest.md](./mod-manifest.md)). The fill is the `fns` map:

```json
{
  "fills": {
    "clipboard-history": [
      {
        "fns": {
          "query": "clipHistory_query",
          "restore": "clipHistory_restore",
          "togglePin": "clipHistory_togglePin",
          "setTags": "clipHistory_setTags",
          "delete": "clipHistory_delete",
          "clear": "clipHistory_clear",
          "getImage": "clipHistory_getImage"
        }
      }
    ]
  }
}
```

- The slot id (`clipboard-history`) is a lowercase-hyphen identifier (`^[a-z][a-z0-9-]*$`), the same vocabulary discovery results use.
- `fns` is an **object map** from logical method name to the concrete export or registered-global function name. The host calls `fns.query`; it is never a positional list.

### Resolution

The host resolves a role slot through the runtime's resolver API (`resolve_role` / `resolveRole` / `ResolveRole` and the `*_all` variants). Resolution is pure data lookup over loaded mods:

1. Collect every loaded mod that fills the requested role slot.
2. Order that list by **owning mod name ascending**; that ordered list is the result of `resolve_role_all`.
3. For `resolve_role`: if the host supplied a preference (a flat `role → addon-name` map on `RuntimeOptions`) that names a candidate, return that candidate; otherwise return the first candidate; otherwise `null`/`None`.

Ordering changed in v0.8.0. Role resolution used to walk mods in **load order**, so the winner depended on the order the host happened to pass its mods in, and reordering that array silently changed which implementation ran. A role candidate carries neither a `priority` nor a fill `id`, so the [three-key slot order](./fragments.md#runtime-slot-resolution) collapses here to its third key alone. A host that was relying on load order to pick between two providers of one role should name its choice in `rolePreferences`, which still outranks the tiebreak.

A resolution returns `{ addon, role, fns }` where `addon` is the filling mod's `name` and `fns` is the winning fill's declared map verbatim.

### Mechanism, not policy

- **xript never calls the resolved fns.** It returns the name map; the host invokes the concrete functions through its existing export or binding path.
- **Filling a role slot grants no capability.** The functions it points at remain ordinary exports/bindings gated by their own capabilities. Default-deny is preserved.
- A role slot with no fill resolves cleanly to `null`/`None`, never an error.
- xript stores no preference state and persists nothing; the preference map is host-supplied per run, driven from the host's own settings.
- `resolve_role` returns only the winner; `resolve_role_all` exposes the full ordered candidate set so the host can build its own picker UI.

## Command Slots

A command slot (`accepts: ["application/x-xript-command"]`) is a host-declared plug-point for **named, invocable actions**: the things a command palette lists, a menu offers, and a keybinding fires. Each fill names an id, a human title, and the mod export that runs it. Full surface in [commands.md](./commands.md).

```json
{
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

Nothing on the declaration is new. Three points a host declaring one should know:

- **`multiple` means fills, not mods.** A `multiple: false` command slot resolves to exactly one command across every loaded mod, the same way it resolves to one fragment on a fragment slot. A palette slot wants `multiple: true`, and `xript lint` warns when a command slot omits it.
- **`payload` bounds the fill contract.** The fill's `input` and `output` JSON Schemas live on the fill, because a host cannot know the signature of an action it did not write. A host that wants to constrain those signatures narrows them with the `payload` schema it already has, since `input` and `output` are properties of the fill object. No second schema language, and `refines` inheritance keeps working.
- **`capability` gates contribution, not invocation.** The slot's capability decides which mods may contribute a command at all. Per-action authority is `entry.exports[<handler>].capability` on the mod side, so two commands backed by the same export carry the same authority and two commands differ in authority only by naming different exports. A command fill declaring its own `capability` is a hard error; it could never deny under prefix subsumption, and the [monotonic-privilege invariant](./capabilities.md#the-monotonic-privilege-invariant-normative) mandates re-rooting an escalation under a separate top-level scope instead.

## Schema Evolution

The manifest schema will evolve as xript matures. The `xript` field enables runtime compatibility:

- **0.x** versions may introduce breaking changes between minors
- **1.0** and beyond will follow semver: minors add, majors break

Runtimes should validate the `xript` field first and reject manifests with unsupported spec versions with a clear error message.

## Domain Schema Extension

xript is an extensibility substrate, and that posture extends to its own vocabulary. The core manifest schema is meant to be *extended*, not fenced off: a domain (a particular kind of host, a product family, a deployment context) can add its own top-level surfaces to the manifest and still validate cleanly.

### Extending the Core Vocabulary

The top-level manifest object uses `unevaluatedProperties: false` rather than a closed `additionalProperties: false`. A domain overlay composes the core schema with its own surfaces:

```json
{
  "$schema": "https://example.dev/schemas/my-domain-manifest.schema.json",
  "allOf": [
    { "$ref": "https://xript.dev/schema/manifest/v0.7.json" },
    {
      "properties": {
        "myDomainSurface": { "type": "object" }
      }
    }
  ]
}
```

Because validation evaluates the composed branches together, properties the overlay introduces are recognized and the manifest still validates against core. A top-level key that *no* branch accounts for is surfaced as an **advisory warning, not an error** — the manifest still validates. The runtime reads only the declared vocabulary and ignores a stray top-level key, so blocking it would fence off a key that has no runtime effect; the warning is there to catch a silent typo of an optional key. Deeper objects (bindings, slots, types, and the rest) stay closed with hard errors, so the loosening is scoped to the top level, where a domain legitimately needs room, and nowhere else.

### Honoring the Declared `$schema`

A manifest may name the schema it was written against via the standard `$schema` keyword. Validation honors that declaration rather than always validating against bundled core. Resolution proceeds in order:

1. **Known schema id/URI** → its bundled local copy. Core's own URI resolves to the bundled core schema; a domain schema the validator already knows resolves to its bundled copy.
2. **Local path**, relative to the manifest → the schema at that path, resolved the same way `extends` resolves a base path.
3. **Remote `http(s)` URL** → fetched, with a local cache keyed by URL. A cache hit uses the cached copy; the resolved schema is pinned so a given manifest validates reproducibly across runs.

When the network is unavailable or a remote schema is uncached and unreachable, validation **falls back to bundled core with a surfaced warning**; it never hard-fails on a schema fetch. Openness beats brittleness: a host should be able to validate the parts of a manifest it understands even when a domain schema is momentarily out of reach.

Remote resolution is **open by default.** A host opts *out* of openness by setting an allowlist of permitted schema origins, or by disabling remote resolution entirely, rather than opting in. Reflexive lockdown is off-brand for an extensibility substrate; a restriction is justified only where it buys real security or convenience the framework could not otherwise provide.

This is safe to honor because **schema validation is not the security boundary; the capability model is.** A declared schema describes shape; it grants no capability and confers no power. Validating against a domain or remote schema cannot widen what a script may do. The real concerns a remote schema raises are operational (offline behavior, reproducibility, and fetch safety), and those are handled by the cache, the schema pin, the bundled-core fallback, and the optional origin restriction, not by refusing to look.
