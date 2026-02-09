---
title: Manifest Validator
description: Validate xript manifests against the specification schema.
---

The manifest validator (`@xript/manifest-validator`) checks that your manifest conforms to the xript specification schema. It catches structural errors, invalid field names, wrong types, and missing required fields before you ship.

## Installation

```sh
npm install @xript/manifest-validator
```

## CLI Usage

```sh
# Validate a single manifest
xript-validate manifest.json

# Validate multiple manifests
xript-validate manifest.json examples/game-mod-system/manifest.json
```

On success, each file gets a green checkmark. On failure, you get specific error messages pointing to the problem.

### Example Output

```
$ xript-validate manifest.json
  ✓ manifest.json is valid

$ xript-validate broken.json
  ✗ broken.json has errors:
    - /name: must match pattern "^[a-z][a-z0-9-]*$"
    - /bindings/doStuff: must have required property 'description'
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All manifests are valid |
| 1 | One or more manifests have errors |

## Programmatic Usage

```javascript
import { validateManifest, validateManifestFile } from "@xript/manifest-validator";

// Validate a manifest object
const result = validateManifest({
  xript: "0.1",
  name: "my-app",
  bindings: { greet: { description: "Greets." } },
});

if (result.valid) {
  console.log("Manifest is valid");
} else {
  console.log("Errors:", result.errors);
}

// Validate from a file path
const fileResult = await validateManifestFile("./manifest.json");
```

## What It Validates

The validator checks against the [xript manifest JSON Schema](/spec/manifest), which covers:

- Required fields (`xript`, `name`)
- Field formats (name pattern, version semver)
- Binding structure (function vs namespace, required `description`)
- Parameter definitions (name, type, optional fields)
- Type references (primitives, arrays, unions, maps, optionals)
- Capability definitions (description, risk levels)
- Custom type definitions (object fields, enum values)
- Execution limits (timeout, memory, stack depth)
- No additional properties at any level
