# @xriptjs/typegen

Generate TypeScript type definitions from [xript](https://github.com/nekoyoubi/xript) manifests.

[![npm](https://img.shields.io/npm/v/@xriptjs/typegen)](https://www.npmjs.com/package/@xriptjs/typegen)

## Install

```sh
npm install @xriptjs/typegen
```

## CLI

```sh
npx xript-typegen manifest.json              # print to stdout
npx xript-typegen manifest.json -o types.d.ts  # write to file
npx xript-typegen mod.json --ambient         # ambient .d.ts for mod authoring
```

Generates `.d.ts` files with full JSDoc, namespace support, and hook type definitions from a manifest.

### Options

```
--output, -o            Output file path (default: stdout)
--ambient               Emit an ambient .d.ts declaring the in-sandbox xript surface for mod authors
--include-grant-shapes  Emit CapabilityPrompt, InstallDescriptor, DiscoveryResult interfaces
```

`--ambient` declares the `xript` global a mod sees at runtime: host bindings, `exports.register`, and the mod's own declared exports and types. TypeScript mod authors get real intellisense and typecheck.

## API

```javascript
import { generateTypes, generateTypesFromFile } from "@xriptjs/typegen";

const dts = generateTypes({
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

console.log(dts);
// => declare function greet(name: string): string;
```

### `generateTypes(manifest, options?): string`

Generates TypeScript declarations from a manifest object.

**Options:**
- `header`: custom header comment (replaces the default auto-generated header)

### `generateTypesFromFile(path, options?): Promise<{ content: string; filePath: string }>`

Reads a manifest JSON file and generates TypeScript declarations.

## What it generates

- `declare function` for top-level bindings
- `declare namespace` for namespace bindings (with nesting)
- `interface` for custom types with fields
- `type` aliases for enum types
- `declare namespace hooks` with handler signatures and phased hook namespaces
- `ProvidedRoles` types for provider-role contributions
- typed accessors for record-type fields (with `default` and inline `enum` support)
- optional capability-grant shape interfaces via `--include-grant-shapes`
- JSDoc with `@param`, `@deprecated`, and `@remarks` annotations

## Documentation

[xript.dev](https://xript.dev): full docs, manifest specification, and examples.

## License

MIT
