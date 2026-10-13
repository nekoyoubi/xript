# @xriptjs/validate

Validate [xript](https://github.com/nekoyoubi/xript) manifests against the specification schema.

[![npm](https://img.shields.io/npm/v/@xriptjs/validate)](https://www.npmjs.com/package/@xriptjs/validate)

## Install

```sh
npm install @xriptjs/validate
```

## CLI

```sh
npx xript-validate manifest.json
```

Validates one or more manifest files and prints results:

```
✓ manifest.json
✗ bad-manifest.json
  /bindings/greet: missing required property "description"
  /xript: must match pattern "^\d+\.\d+$"
```

Exit code is `1` if any file fails validation.

## What it validates

- app and mod manifests against the xript JSON Schema (with auto-detection)
- cross-validation between an app manifest and a mod manifest
- manifest `extends` with deep-merge (a manifest inheriting and overriding host bindings)
- the mod-manifest `family` field for addon grouping
- ES-module `entry.format`, including a static-import lint (external imports are denied at load)
- a CommonJS guardrail: `require(`, `module.exports`, and top-level `exports.` in a mod entry fail loudly with a fix-it message
- provider-role contributions (`contributions.provides`), flagging duplicate roles and unbound functions

## API

```javascript
import { validateManifest, validateManifestFile } from "@xriptjs/validate";

const result = await validateManifest({
  xript: "0.7",
  name: "my-app",
  bindings: {
    greet: {
      description: "Returns a greeting.",
      params: [{ name: "name", type: "string" }],
      returns: "string",
    },
  },
});

console.log(result.valid);  // true
console.log(result.errors); // []
```

### `validateManifest(manifest): Promise<ValidationResult>`

Validates a manifest object against the xript JSON Schema.

### `validateManifestFile(path): Promise<ValidationResult & { filePath: string }>`

Reads a JSON file from disk and validates it.

### Browser and edge runtimes: `@xriptjs/validate/core`

The main entry reads manifests, `extends` bases, and `$schema` overlays from disk and the network, so it imports Node builtins. `@xriptjs/validate/core` is the same validator with none of that: every schema (including the frozen ones for earlier manifest versions) is bundled in, and nothing in its import graph touches `node:*`. It exports `validateManifest`, `validateModManifest`, `crossValidate`, `lintManifests`, `scoreManifests`, the capability and type-reference helpers, and everything else the main entry does except the file and network resolvers.

```javascript
import { validateManifestForVersion, crossValidate, lintManifests } from "@xriptjs/validate/core";

const host = await validateManifestForVersion(appManifest); // pinned by $schema or the xript field
const pair = await crossValidate(appManifest, modManifest);
const { findings } = lintManifests(appManifest, [modManifest]);
```

`validateManifestForVersion(manifest, { kind?, version?, schema? })` picks the schema the way the main entry's `validateManifestVersioned` does, minus fetching: a `$schema` naming something other than an xript schema is an overlay it cannot resolve, so pass the overlay as `schema` or it validates against bundled core with a `schema-fallback` warning.

### `ValidationResult`

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}
```

## Documentation

[xript.dev](https://xript.dev): full docs and manifest specification.

## License

MIT
