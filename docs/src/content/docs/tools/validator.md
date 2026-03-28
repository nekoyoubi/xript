---
title: Validator
description: Validate xript manifests against the specification schema.
---

The validator checks that your manifest conforms to the xript specification schema. It catches structural errors, invalid field names, wrong types, and missing required fields.

## Installation

```sh
npm install @xriptjs/cli
```

## CLI Usage

```sh
# Validate a single manifest
xript validate manifest.json

# Validate multiple manifests
xript validate manifest.json examples/game-mod-system/manifest.json
```

On success, each file gets a green checkmark. On failure, you get specific error messages pointing to the problem.

### Example Output

```
$ xript validate manifest.json
  ✓ manifest.json is valid

$ xript validate broken.json
  ✗ broken.json has errors:
    - /name: must match pattern "^[a-z][a-z0-9-]*$"
    - /bindings/doStuff: must have required property 'description'
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All manifests are valid |
| 1 | One or more manifests have errors |

## Mod Manifest Validation

The validator auto-detects whether a file is an app manifest or a [mod manifest](/spec/mod-manifest/). Files with `fragments` or `entry` fields (and no `bindings`) are validated against the mod manifest schema.

```sh
# Auto-detected as a mod manifest
xript validate mod-manifest.json
```

## Cross-Validation

The `--cross` flag validates that a mod's fragments target valid slots in the host app:

```sh
xript validate --cross manifest.json mod-manifest.json
```

Cross-validation checks:
- Every fragment targets a slot that exists in the app manifest
- Every fragment's format is in the slot's `accepts` list
- Every capability the mod requests is defined in the app manifest

## Programmatic Usage

```javascript
import {
  validateManifest,
  validateModManifest,
  crossValidate,
  validateManifestFile,
} from "@xriptjs/validate";

// Validate an app manifest
const result = validateManifest({
  xript: "0.3",
  name: "my-app",
  bindings: { greet: { description: "Greets." } },
  slots: [{ id: "sidebar", accepts: ["text/html"] }],
});

// Validate a mod manifest
const modResult = await validateModManifest({
  xript: "0.3",
  name: "my-mod",
  version: "1.0.0",
  fragments: [{ id: "panel", slot: "sidebar", format: "text/html", source: "<p>hi</p>" }],
});

// Cross-validate mod against app
const crossResult = await crossValidate(appManifest, modManifest);

// Auto-detect and validate from file
const fileResult = await validateManifestFile("./manifest.json");
```

## What It Validates

The validator checks against the [xript manifest JSON Schema](/spec/manifest) and [mod manifest schema](/spec/mod-manifest/), covering:

- Required fields (`xript`, `name` for apps; `xript`, `name`, `version` for mods)
- Field formats (name pattern, version semver)
- Binding structure (function vs namespace, required `description`)
- Parameter definitions (name, type, optional fields)
- Type references (primitives, arrays, unions, maps, optionals)
- Capability definitions (description, risk levels)
- Custom type definitions (object fields, enum values)
- Execution limits (timeout, memory, stack depth)
- Slot definitions (id, accepts, capability, multiple, style)
- Fragment declarations (id, slot, format, source, bindings, events)
- No additional properties at any level
