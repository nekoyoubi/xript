---
title: Mod Manifest
description: "The xript mod manifest format: how mods declare themselves and contribute UI fragments."
---

The mod manifest is a JSON file that declares what a mod provides and what it needs from the host application. It is distinct from the [app manifest](/spec/manifest/). The app manifest describes what the host exposes; the mod manifest describes what the mod contributes.

## Overview

A mod manifest declares metadata, required capabilities, script entry points, and UI fragment contributions. At minimum, it requires a spec version, name, and version:

```json
{
  "xript": "0.3",
  "name": "health-panel",
  "version": "1.0.0"
}
```

The full schema lives at [`spec/mod-manifest.schema.json`](https://github.com/nekoyoubi/xript/blob/main/spec/mod-manifest.schema.json).

## Required Fields

### `xript`

The xript specification version this mod targets. Format: `major.minor` (e.g., `"0.3"`).

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

### `capabilities`

An array of capability names the mod requires from the host:

```json
{
  "capabilities": ["ui-mount", "modify-player"]
}
```

The host grants or denies these when loading the mod. If a required capability isn't granted, gated operations fail with `CapabilityDeniedError`.

### `entry`

Script entry point(s) relative to the mod root. Can be a single string or an array:

```json
{ "entry": "src/mod.js" }
{ "entry": ["src/setup.js", "src/handlers.js"] }
```

Entry scripts execute in the host's sandbox when the mod is loaded. They can register hook handlers, fragment lifecycle callbacks, and set up mod state.

### `fragments`

UI fragment contributions. See [Fragments](/spec/fragments/) for the full protocol.

## Example

```json
{
  "$schema": "https://xript.dev/schema/mod-manifest/v0.3.json",
  "xript": "0.3",
  "name": "health-panel",
  "version": "1.0.0",
  "title": "Health Panel",
  "description": "Displays a health bar with low-health warnings.",
  "author": "modder",
  "capabilities": ["ui-mount"],
  "entry": "src/mod.js",
  "fragments": [
    {
      "id": "health-display",
      "slot": "sidebar.left",
      "format": "text/html",
      "source": "fragments/panel.html",
      "bindings": [
        { "name": "health", "path": "player.health.val" },
        { "name": "maxHealth", "path": "player.health.max" }
      ],
      "events": [
        { "selector": "[data-action='heal']", "on": "click", "handler": "onHealClicked" }
      ],
      "priority": 10
    }
  ]
}
```

## Validation

Use the validator to check mod manifests:

```bash
npx xript validate mod-manifest.json
```

The validator auto-detects whether a file is an app manifest or a mod manifest based on the presence of `fragments` or `entry` fields.

For cross-validation (checking that a mod's fragments target valid slots):

```bash
npx xript validate --cross manifest.json mod-manifest.json
```
