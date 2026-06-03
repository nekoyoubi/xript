---
title: Mod Manifest
description: "The xript mod manifest format: how mods declare themselves and fill the host's typed slots."
---

The mod manifest is a JSON file that declares what a mod provides and what it needs from the host application. It is distinct from the [app manifest](/spec/manifest/). The app manifest declares a surface of typed [slots](/spec/manifest/#slots); the mod manifest declares the **fills** that engage them.

## Overview

A mod manifest declares metadata, required capabilities, a script entry point, and the slot fills it contributes. At minimum, it requires a spec version, name, and version:

```json
{
  "xript": "0.6",
  "name": "health-panel",
  "version": "1.0.0"
}
```

The full schema lives at [`spec/mod-manifest.schema.json`](https://github.com/nekoyoubi/xript/blob/main/spec/mod-manifest.schema.json).

## Required Fields

### `xript`

The xript specification version this mod targets. Format: `major.minor` (e.g., `"0.6"`).

### `name`

Machine-readable mod identifier. Same constraints as the app manifest: lowercase letters, numbers, and hyphens; starts with a letter; max 64 characters.

### `version`

The mod's version, following [semver](https://semver.org/) (e.g., `"1.0.0"`, `"0.3.0-beta.1"`).

## Optional Fields

### `title`

Human-readable display name (max 128 characters).

### `description`

Brief description of what the mod does (max 1024 characters).

### `author`

The mod author's name or handle (max 128 characters).

### `license`

The mod's license: an SPDX identifier or a short label (max 128 characters).

```json
{ "license": "MIT" }
```

### `extends`

One or more base mod manifests to inherit from. Resolved and deep-merged base-then-child before validation, transitively, with cycle detection. Paths are filesystem-relative to this manifest.

```json
{ "extends": "./base.mod.json" }
{ "extends": ["./base.mod.json", "./theme.mod.json"] }
```

Merge rules: maps key-merge, arrays append, scalars are child-wins, and duplicate ids are an error. This is the same inheritance model the [app manifest](/spec/manifest/#extends) uses.

### `capabilities`

An array of capability names the mod requires from the host:

```json
{
  "capabilities": ["ui-mount", "modify-player"]
}
```

The host grants or denies these when loading the mod. If a required capability isn't granted, gated operations fail with `CapabilityDeniedError`.

### `entry`

Script entry point(s) relative to the mod root. The simple form is a single string or an array:

```json
{ "entry": "src/mod.js" }
{ "entry": ["src/setup.js", "src/handlers.js"] }
```

The richer object form names a primary `script`, an execution `format`, and the named `exports` the host can invoke:

```json
{
  "entry": {
    "script": "src/mod.js",
    "format": "module",
    "exports": {
      "transcribe": { "description": "Transcribe a value.", "params": [{ "name": "value", "type": "string" }], "returns": "string" }
    }
  }
}
```

With `format: "module"` the entry evaluates as an ES module and its top-level named exports become host-invokable automatically; see [Module-Format Mods](/spec/modules/) for the full rules. Entry scripts run in the host's sandbox when the mod loads: they register fill handlers, register fragment lifecycle callbacks, and set up mod state.

### `family`

An optional grouping family for host-side organization, like collecting related mods into one navigation rail. When absent, hosts fall back to name-prefix heuristics.

```json
{ "family": "inventory-tools" }
```

### `fills`

The canonical contribution surface. `fills` is an object keyed by host slot id; each value is an array of fill entries that engage that slot:

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
        "handlers": [
          { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
        ]
      }
    ]
  }
}
```

A fill's inner shape is governed by the target slot's `accepts` type; the host owns that contract. Representative shapes:

| Slot kind (`accepts`) | Fill shape | The host does |
|-----------------------|------------|----------------|
| fragment format (`text/html+jsml`) | `{ "format", "source", "bindings", "handlers" }` | mounts the inert fragment |
| code renderer (`application/javascript+esm`) | `{ "kind", "entry", "label", "icon" }` | invokes the entry to paint |
| role (`application/x-xript-role`) | `{ "fns": { "transcribe": "transcribeAudio" } }` | resolves a logical role to concrete exports |
| event/hook (`application/x-xript-hook`) | `{ "handler": "onStartup" }` | fires the slot, calling the handler |

A **fragment** is a fill of a fragment-format slot; the [fragment protocol](/spec/fragments/) governs that slot type in full. A **provider role** is a fill of a role-type slot. The host calls `resolve_role(role)` to map a logical role to a providing mod and its `fns` (first-installed-wins, settings-overridable), or `resolve_role_all` to build its own picker; declaring a role grants nothing, and the named functions stay gated by their own capabilities. A **lifecycle hook handler** is a fill of an event-typed slot; firing the slot calls the handler.

A fill into a slot the host never declared, or into a gated slot the mod lacks the capability for, is a validation error. The inner fill shape is not policed by the validator; that contract belongs to the slot's `accepts` type.

:::note[Legacy `fragments` and `contributions`]
The older top-level `fragments` array and `contributions` object (`provides` + `slots`) are retired in favor of `fills`. A `fragments[]` entry is a fill of a fragment-format slot; `contributions.provides` is a fill of a role-type slot. The validator still accepts both for migration smoothness and emits a deprecation warning. New mods should write only `fills`.
:::

:::note[A fragment fill's `handlers` field, and the deprecated `events` alias]
A fragment fill's DOM event handler array is named `handlers`. It was previously called `events`, which misnamed handlers as events; a reader still accepts `events` as a deprecated alias (if both are present, `handlers` wins) and warns on it. Rename the key to migrate; the entry shape (`selector`, `on`, `handler`) is unchanged. Not to be confused with the host manifest's top-level [`events` catalog](/spec/manifest/#events), which declares what the host broadcasts.
:::

## Example

```json
{
  "$schema": "https://xript.dev/schema/mod-manifest/v0.6.json",
  "xript": "0.6",
  "name": "health-panel",
  "version": "1.0.0",
  "title": "Health Panel",
  "description": "Displays a health bar with low-health warnings.",
  "author": "modder",
  "license": "MIT",
  "capabilities": ["ui-mount"],
  "entry": "src/mod.js",
  "fills": {
    "sidebar.left": [
      {
        "format": "text/html+jsml",
        "source": "fragments/panel.html",
        "bindings": [
          { "name": "health", "path": "player.health.val" },
          { "name": "maxHealth", "path": "player.health.max" }
        ],
        "handlers": [
          { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
        ],
        "priority": 10
      }
    ]
  }
}
```

## Validation

Use the validator to check mod manifests:

```bash
npx xript validate mod-manifest.json
```

The validator auto-detects whether a file is an app manifest or a mod manifest based on the presence of `fills`, `entry`, or the legacy `fragments` field.

For cross-validation (checking that a mod's fills target valid slots and hold the capabilities those slots gate):

```bash
npx xript validate --cross manifest.json mod-manifest.json
```

Cross-validation also checks each fill's payload against the target slot's `payload` schema (on by default; pass `--no-fill-payloads` to flex it off). A fill carrying more than the payload declares still passes unless the slot explicitly closes its payload.

For a heuristic review of the same host/mod pair (dead slots, vestigial capabilities, ungated surfaces), reach for [`xript lint`](/tools/lint/).
