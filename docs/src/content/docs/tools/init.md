---
title: Init CLI
description: Scaffold new xript projects with interactive prompts or defaults.
---

The init CLI (`@xriptjs/init`) scaffolds new xript projects with a manifest, package configuration, and a demo script. It supports interactive prompts or fully non-interactive mode for CI and scripting.

## Usage

```sh
npx @xriptjs/init
```

Or install globally:

```sh
npm install -g @xriptjs/init
xript-init
```

## Interactive Mode

Running without flags starts an interactive session:

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

## Non-Interactive Mode

Skip all prompts with `--yes` (or `-y`):

```sh
npx @xriptjs/init my-mod --yes
```

Defaults: tier 2, TypeScript.

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `[directory]` | Target directory for the project | Current directory |
| `--yes`, `-y` | Skip prompts, use defaults | `false` |
| `--tier <2\|3>` | Adoption tier | `2` |
| `--typescript` | Generate TypeScript output | (default) |
| `--javascript` | Generate JavaScript output | |
| `--help`, `-h` | Show help | |

## Adoption Tiers

The init CLI generates project scaffolding tailored to two adoption tiers:

**Tier 2 (Bindings)**: Simple host bindings with capability gating. Good for apps that need a few extension points like custom formatting, data transformations, or simple plugins.

**Tier 3 (Full Scripting)**: Namespace bindings, hooks, custom types, and capabilities. Designed for apps with rich extension APIs like game engines, content tools, or extensible platforms.

Tier 1 (expression-only) is simple enough that no scaffolding is needed.

## Generated Files

| File | Description |
|------|-------------|
| `manifest.json` | xript manifest with bindings, capabilities, and (tier 3) hooks |
| `package.json` | Project configuration with `@xriptjs/runtime` dependency and demo script |
| `src/demo.ts` or `src/demo.js` | Working demo that creates a runtime and executes example scripts |
| `tsconfig.json` | TypeScript configuration (TypeScript projects only) |

## Programmatic API

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

Returns the file contents as a `Record<string, string>` without writing to disk. Useful for testing or custom scaffolding workflows.
