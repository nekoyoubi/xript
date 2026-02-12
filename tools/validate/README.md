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

## API

```javascript
import { validateManifest, validateManifestFile } from "@xriptjs/validate";

const result = await validateManifest({
  xript: "0.1",
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
