# @xriptjs/docgen

Generate markdown API documentation from [xript](https://github.com/nekoyoubi/xript) manifests.

[![npm](https://img.shields.io/npm/v/@xriptjs/docgen)](https://www.npmjs.com/package/@xriptjs/docgen)

## Install

```sh
npm install @xriptjs/docgen
```

## CLI

```sh
npx xript-docgen manifest.json                # print to stdout
npx xript-docgen manifest.json -o docs/       # write to output directory
```

Generates structured markdown documentation with binding signatures, parameter tables, capability requirements, hook documentation, and type references.

## API

```javascript
import { generateDocs, generateDocsFromFile } from "@xriptjs/docgen";

const docs = generateDocs({
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

console.log(docs);
```

### `generateDocs(manifest): string`

Generates markdown documentation from a manifest object.

### `generateDocsFromFile(path, options?): Promise<{ content: string; filePath: string }>`

Reads a manifest JSON file and generates markdown documentation.

**Options:**
- `outputDir` — directory to write output files

## What it generates

- Binding reference with function signatures and parameter tables
- Namespace binding documentation with member listings
- Capability reference with risk levels
- Hook documentation with handler signatures and phase listings
- Custom type documentation with field tables
- Usage examples (when provided in the manifest)

## Documentation

[xript.dev](https://xript.dev) — full docs and manifest specification.

## License

MIT
