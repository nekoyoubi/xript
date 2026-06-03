---
title: Manifest Specification
description: "The xript manifest format: how applications declare their scripting API."
---

The xript manifest is the single source of truth for an application's scripting API. It declares what functionality is exposed to scripts, how it is organized, what capabilities gate access, and what types are involved. From the manifest, everything else is derived: documentation, TypeScript definitions, validation, and interactive playgrounds.

## Overview

A manifest is a JSON file conforming to the [manifest JSON Schema](https://github.com/nekoyoubi/xript/blob/main/spec/manifest.schema.json). At minimum, a manifest declares a spec version and a name:

```json
{
  "xript": "0.1",
  "name": "my-app"
}
```

Complexity layers on only as needed. Every field beyond `xript` and `name` is optional, and each section you add enables more functionality.

## Top-Level Fields

### `$schema`

The schema this manifest conforms to. Optional; when present, tooling validates against it rather than always assuming bundled core, which lets a domain extend the vocabulary with an overlay. See [Schema and domain overlays](#schema-and-domain-overlays).

### `xript` (required)

The specification version this manifest conforms to. This is not the application's version; it's the version of the xript spec the manifest was written against.

Format: `major.minor` (e.g., `"0.1"`).

### `name` (required)

A machine-readable identifier for the application. Used in generated package names, documentation URLs, and tooling output.

Constraints: lowercase letters, numbers, and hyphens. Must start with a letter. Maximum 64 characters.

### `version`

The version of the application's scripting API, following semver. Tracks how the exposed bindings evolve over time.

### `title`

A human-readable display name. Used in documentation headers and UI.

### `description`

A brief description aimed at extenders. Used in documentation landing pages and registry listings.

### `extends`

One or more base manifests to inherit from. The bases get resolved and deep-merged before validation, so a host can build on a shared foundation and add, fill, or refine only what differs:

```json
{
  "xript": "0.6",
  "name": "extended-host",
  "extends": "./base.manifest.json"
}
```

`extends` takes a single path or an array of paths, resolved before schema validation. Maps (`bindings`, `capabilities`, `hooks`, `types`) key-merge, `slots` append keyed by `id`, and scalars are child-wins. Paths are filesystem-relative to the manifest, and resolution is transitive with cycle detection. A name that appears in both base and child resolves by one of three moves (**add**, **fill**, or **refine**); an un-opted concrete-name collision is an error. See [Manifest inheritance](#manifest-inheritance-extends).

### `events`

A catalog of the named events the host broadcasts and their payload types. Optional. See [Events](#events).

## Bindings

Bindings define the functions and namespaces that scripts can call.

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

Every function binding requires a `description`. Optional fields include `params`, `returns`, `async`, `capability`, `examples`, and `deprecated`.

### Namespace Bindings

Namespaces group related functions using the `members` field:

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

Namespaces can nest, but deep nesting is discouraged. Two levels is usually plenty.

## Slots

A host declares a surface of named, typed plug-points. Bindings are callables the host implements and the mod *calls*; slots are typed points the host declares and the mod *fills*. Everything a mod contributes is a slot fill — a fragment, a provider role, a lifecycle-event handler are all fills of slots of a particular type.

```json
{
  "slots": [
    {
      "id": "sidebar.left",
      "accepts": ["text/html+jsml"],
      "capability": "ui-mount",
      "multiple": true,
      "style": "isolated"
    }
  ]
}
```

A slot's `accepts` type names the format(s) or kind the slot takes and governs what a valid fill looks like and what the host does with it: mount it, call it, resolve it, or fire it. Representative `accepts` values: `"text/html+jsml"` (an inert fragment), `"application/javascript+esm"` (a code-backed renderer), `"application/json"`, `"application/x-xript-role"` (a provider role), `"application/x-xript-hook"` (an event handler).

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Unique slot identifier (`^[a-z][a-z0-9.-]*$`) |
| `accepts` | string[] | yes | — | The format(s)/kind this slot takes |
| `description` | string | no | — | What the slot is for; surfaced in docs |
| `capability` | string | no | — | Capability a mod must hold to fill it |
| `multiple` | boolean | no | false | Allow more than one fill |
| `payload` | object | no | — | A JSON Schema each fill's payload must satisfy |
| `reserved` | boolean | no | false | Aspirational slot; never flagged unfilled, excluded from coverage |
| `refines` | boolean | no | false | Deep-merge onto a base slot of the same `id` (see [inheritance](#manifest-inheritance-extends)) |
| `style` | enum | no | `"inherit"` | Styling mode (fragment-format slots) |

A slot's `payload` carries a full JSON Schema (draft 2020-12), not a flat field list — the host validates each fill's payload against it. `cross-validate` checks fills against the target slot's payload schema by default (`--no-fill-payloads` / `checkFillPayloads` flexes it off; extras pass unless the slot closes its payload). A `reserved` slot is aspirational surface: declared without a current filler, never reported as dead, and excluded from coverage denominators.

Mods engage slots through the `fills` surface in their [mod manifest](/spec/mod-manifest/). See [Fragments](/spec/fragments/) for the fragment-format slot type in depth.

### Role slots and resolution

A role slot (`accepts: ["application/x-xript-role"]`) is a host-declared plug-point any mod can fill. Rather than core UI hardcoding a mod-specific global function name, the host declares the role slot, a mod fills it with a logical-to-concrete `fns` map (in its `fills` surface), and the host asks the runtime to resolve it via `resolve_role` / `resolveRole` / `ResolveRole` (and the `*_all` variants). Resolution is pure data lookup over loaded mods in load order; it returns `{ addon, role, fns }`, never calls the resolved functions, and grants no capability. The functions stay gated by their own capabilities, and an unfilled role slot resolves cleanly to `null`/`None`. See the [mod manifest](/spec/mod-manifest/) for the fill shape.

## Capabilities

Capabilities implement the default-deny security model. Every capability is a named permission that must be explicitly granted before scripts can use the functionality it protects.

```json
{
  "capabilities": {
    "filesystem": {
      "description": "Read and write files in the mod's data directory.",
      "risk": "medium"
    }
  }
}
```

Functions reference capabilities via the `capability` field. Functions without a `capability` are always available.

The `risk` field (`low`, `medium`, `high`) is advisory; it gives users a signal when deciding what to grant.

A capability may carry `"reserved": true` to mark it as aspirational: declared for canon parity or a future surface without yet gating anything. Tooling treats a reserved capability as intentional rather than vestigial and suppresses the unreferenced-capability warning. A capability that gates a binding or hook counts as used.

## Events

The `events` array is a discovery declaration of the named events the **host emits** and the shape of each one's payload. It is consumer-agnostic: it says what the host broadcasts, not who listens. Sandbox scripts, the host's own UI, and external subscribers are all equally valid audiences — the catalog presupposes none of them.

```json
{
  "events": [
    {
      "id": "player.died",
      "description": "Fired when the player's health reaches zero.",
      "payload": "DeathContext"
    },
    {
      "id": "level.loaded",
      "description": "Fired after a new level finishes loading."
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | The event name the host broadcasts under |
| `description` | string | yes | What the event means and when it fires |
| `payload` | type reference | no | The shape of the data delivered with the event |

`typegen` emits a typed event catalog from this array, and `docgen` renders an events section, so an author knows exactly what a host emits and what each payload carries.

### Events versus its neighbors

Three surfaces sit close enough to confuse. The line between them:

- **Event-typed slots** (a slot whose `accepts` is `application/x-xript-hook`) are extension *points* — places a mod fills with a handler the host calls.
- **Fragment `handlers`** are DOM responses wired on a fragment fill — what runs when the user clicks something in mounted UI.
- **`events`** (this surface) is what the *host emits* — a declaration of broadcasts, with no consumer presupposed.

One line: bindings are *what you can call*, slots and handlers are *what handles*, and `events` is *what the host emits*.

## Hooks

:::caution[Deprecated as a standalone concept]
A lifecycle hook is a slot whose `accepts` is the event-handler type (`application/x-xript-hook`), and firing it means calling that slot's fills. The standalone `hooks` field remains allowed for back-compat, but new hosts should declare event-typed slots instead. Host-side hook firing is unchanged. See [Hooks](/spec/hooks/).
:::

## Types

Custom types describe complex data structures used in bindings.

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

An object type can be marked `"abstract": true` to declare a contract hole: described but unpopulated, with no `fields` of its own, left for an extending manifest to fill. See [Manifest inheritance](#manifest-inheritance-extends).

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

#### Open Enums

Adding `"open": true` to a type's `values` (or to a field's inline `enum`) declares an *open* enum — the listed values are the known set, but any other string is also valid:

```json
{
  "types": {
    "Severity": {
      "description": "A diagnostic severity. Hosts and addons may contribute their own.",
      "values": ["info", "warn", "error"],
      "open": true
    }
  }
}
```

`typegen` emits `... | (string & {})` so unlisted (for example, addon-contributed) values still type-check, and `docgen` marks the type as extensible. xript does not enforce the closed set at runtime regardless of `open`.

An enum type may also be abstract: a `description` with `"abstract": true` and no `values`, leaving the concrete `values` for an extending manifest to fill.

### Record Fields

Object-type fields can carry a `default` value and an inline `enum` of allowed values. That's enough for a mod to describe an owned record type, a structured value it manages, entirely through the `types` surface; no new persistence concept required. `typegen` emits typed accessors for these, and the runtimes stay persistence-agnostic: xript describes the shape, the host decides where it lives.

```json
{
  "types": {
    "QuestState": {
      "description": "A tracked quest.",
      "fields": {
        "title": { "type": "string" },
        "stage": { "type": "number", "default": 0 },
        "status": { "type": "string", "enum": ["active", "done", "failed"], "default": "active" }
      }
    }
  }
}
```

### Type References

Anywhere a type is expected, you can use:

- **Primitives**: `"string"`, `"number"`, `"boolean"`, `"void"`, `"null"`
- **Custom types**: `"Position"`, `"Direction"`
- **Array shorthand**: `"string[]"`, `"Position[]"`
- **Complex expressions**: `{ "array": "Position" }`, `{ "union": ["string", "number"] }`, `{ "map": "number" }`, `{ "optional": "string" }`

## Execution Limits

Default bounds for script execution:

```json
{
  "limits": {
    "timeout_ms": 5000,
    "memory_mb": 64,
    "max_stack_depth": 256
  }
}
```

These are defaults that runtimes enforce unless the host application overrides them.

## Adoption Tiers

The manifest supports four adoption tiers through progressive complexity.

### Tier 1: Expressions Only

```json
{
  "xript": "0.1",
  "name": "calculator"
}
```

Safe eval replacement. No bindings, no capabilities.

### Tier 2: Simple Bindings

```json
{
  "xript": "0.1",
  "name": "my-game",
  "version": "1.0.0",
  "bindings": {
    "getPlayerName": {
      "description": "Returns the current player's display name.",
      "returns": "string"
    },
    "getHealth": {
      "description": "Returns the player's current health (0-100).",
      "returns": "number"
    }
  }
}
```

A few functions, no capabilities needed.

### Tier 3: Advanced Scripting

Namespaces, capabilities, custom types, examples, and execution limits. See the [Game Mod System](/examples/game-mod-system) example walkthrough for a complete tier 3 manifest.

### Tier 4: Full Feature

Slots, mod manifests, and fills. The host declares typed plug-points; mods fill them with fragments that bind to host state and handle interaction, with provider roles, and with lifecycle-event handlers. See the [UI Dashboard](/examples/ui-dashboard) example for a complete tier 4 integration.

## Manifest inheritance (`extends`)

A manifest may build on one or more base manifests via the top-level [`extends`](#extends) field. A **base manifest** (sometimes called *canon*) declares the bindings, capabilities, slots, and types a family of hosts holds in common; each extending manifest builds on that floor. Resolution happens before schema validation, flattening base-then-child into a single schema-valid manifest the runtime never sees `extends` on.

### Abstract types

A type carrying `"abstract": true` is declared and described but unpopulated; it supplies neither `fields` nor `values`, standing as a typed contract hole. The base may reference it from concrete surface (a binding return type, a slot's payload schema, another type's field) without committing to its shape, and each extending manifest decides what fills it.

### The three moves: add, fill, refine

When an extending manifest declares a name, exactly one of three moves applies:

- **Add** — a name the base never declared. Purely additive, no marker. Canon is a shared floor, never a cage.
- **Fill** — redeclaring an *abstract* base type with concrete `fields` and/or `values`. Allowed without a marker; the base being abstract is the opt-in signal. The concrete definition replaces the abstract stub.
- **Refine** — redeclaring a *concrete* base type (or slot) with `"refines": true`. The child deep-merges onto the base: child members win key-by-key, and base members the child omits are retained. Slots refine the same way, including their `payload` JSON Schema.

```json
{
  "extends": "./base.json",
  "name": "consuming-host",
  "types": {
    "StatusCode": { "description": "Codes this host recognizes.", "values": ["ok", "retry", "error"] },
    "Envelope": {
      "refines": true,
      "fields": { "traceId": { "type": "string", "description": "Correlation id." } }
    }
  }
}
```

Any other concrete-name collision is a resolution error: redeclaring a concrete type, slot `id`, binding, capability, or hook without the right move (or a cross-base collision in an `extends` array) fails at resolution time, before validation, and cannot be suppressed. An inherited abstract type left unfilled is an `abstract-type-unfilled` error; a locally-declared abstract type (for one's own extenders to fill) is not flagged. Filling or refining inherited surface counts as legitimate use; it never trips dead-slot or vestigial-capability findings. The model is at parity across all four runtimes. See [`spec/extends.md`](https://github.com/nekoyoubi/xript/blob/main/spec/extends.md) for the normative reference.

## Schema and domain overlays

The full JSON Schema is available at [`spec/manifest.schema.json`](https://github.com/nekoyoubi/xript/blob/main/spec/manifest.schema.json). Core xript defines a fixed top-level vocabulary, but a domain can extend it.

### `$schema`

A manifest may name the schema it conforms to with a top-level `$schema` field, the way any JSON document does:

```json
{
  "$schema": "https://xript.dev/schema/manifest/v0.6.json",
  "xript": "0.6",
  "name": "my-app"
}
```

When `$schema` is present, tooling validates against the schema it names rather than always assuming bundled core. Resolution leans open by default: a recognized schema id resolves to its bundled local copy (core's own URI resolves to bundled core); a local path resolves relative to the manifest, the same way `extends` does; and an `http(s)` URL is fetched and cached, keyed by URL, so a repeat validation reuses the cached copy and a run pins the schema it resolved for reproducibility. If the schema can't be reached (offline, or an uncached remote), tooling falls back to bundled core and surfaces a warning rather than hard-failing. Remote resolution is allowed unless a host explicitly restricts it (an allowlist, or disabling remote schemas); you opt out of openness, not into it.

Honoring a declared schema grants no new power. Schema validation is not xript's security boundary; the [capability model](/spec/capabilities/) is. A manifest naming its own schema can describe a richer vocabulary, but it can't reach past its capabilities. The real concerns are staying usable offline, keeping a validation reproducible, and fetching safely; the cache, the pin, the bundled fallback, and the optional restriction cover those.

### Extending the vocabulary with an overlay

A domain can add its own top-level manifest properties by layering a schema *overlay* on top of core:

```json
{
  "allOf": [
    { "$ref": "https://xript.dev/schema/manifest/v0.6.json" },
    {
      "type": "object",
      "properties": {
        "myDomain": { "type": "object" }
      }
    }
  ]
}
```

Core's top-level object is open to this: it constrains the properties it knows but does not reject unknown top-level properties an overlay introduces, so a manifest validated against the overlay above can carry both core surfaces and `myDomain` and still pass. The openness stops at the top level by design; nested objects (bindings, slots, types, and the rest) stay closed, so a typo inside a known surface is still caught. A domain that needs more vocabulary adds it at the top with an overlay; it does not fork core.
