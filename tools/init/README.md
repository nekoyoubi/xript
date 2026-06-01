# @xriptjs/init

Scaffolding CLI for new [xript](https://github.com/nekoyoubi/xript) projects.

[![npm](https://img.shields.io/npm/v/@xriptjs/init)](https://www.npmjs.com/package/@xriptjs/init)

## Usage

```sh
npx @xriptjs/init
```

Walks you through creating a new xript project with interactive prompts:

```
$ npx @xriptjs/init my-mod
Project name (my-mod):
Tier: 2 (bindings) or 3 (full scripting)? (2):
Language: typescript or javascript? (typescript):

✓ Created my-mod in /path/to/my-mod

  manifest.json
  package.json
  src/demo.ts
  tsconfig.json

Next steps:
  cd my-mod
  npm install
  npm run demo
```

### Skip prompts

```sh
npx @xriptjs/init my-mod --yes
```

Uses defaults: tier 2, TypeScript.

### Mods

```sh
npx @xriptjs/init my-mod --mod                # mod project
npx @xriptjs/init my-mod --mod --typescript   # ESM TypeScript mod
```

`--mod --typescript` scaffolds an ESM TypeScript mod: an ESM `tsconfig`, an `export`-based example entry, and ambient types wired in for real intellisense.

### Options

```
npx @xriptjs/init [directory] [options]

Options:
  --yes, -y          Skip prompts, use defaults
  --mod              Generate a mod project instead of an app
  --tier <2|3|4>     Adoption tier (2 = bindings, 3 = advanced scripting, 4 = full feature)
  --typescript       Generate TypeScript output (default)
  --javascript       Generate JavaScript output
  --help, -h         Show help
```

## API

```javascript
import { writeProject, generateProjectFiles } from "@xriptjs/init";

const result = await writeProject("./my-mod", {
  name: "my-mod",
  tier: 2,
  language: "typescript",
});

console.log(result.files); // ["manifest.json", "package.json", ...]
```

### `writeProject(directory, options): Promise<InitResult>`

Writes a complete xript project scaffold to disk.

### `generateProjectFiles(options): ProjectFiles`

Returns the file contents as a `Record<string, string>` without writing to disk.

## Documentation

[xript.dev](https://xript.dev): full docs, adoption tiers, and getting started guide.

## License

MIT
