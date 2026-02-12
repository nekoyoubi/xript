---
title: Doc Generator
description: Generate structured markdown documentation from xript manifests.
---

The doc generator (`@xriptjs/docgen`) reads an xript manifest and produces a structured set of markdown documentation pages. Every binding, type, and capability gets its own page with signatures, parameter tables, and examples.

## Installation

```sh
npm install @xriptjs/docgen
```

## CLI Usage

```sh
# Generate docs to a directory
xript-docgen manifest.json --output docs/api/
xript-docgen manifest.json -o docs/api/
```

### Example

```sh
$ xript-docgen examples/game-mod-system/manifest.json -o api-docs/
✓ Generated 10 documentation pages to /path/to/api-docs
  api-docs/index.md
  api-docs/bindings/log.md
  api-docs/bindings/player.md
  api-docs/bindings/world.md
  api-docs/bindings/data.md
  api-docs/types/Position.md
  api-docs/types/Item.md
  api-docs/types/Enemy.md
  api-docs/types/ItemType.md
  api-docs/types/EnemyType.md
```

## Output Structure

The generator creates the following page types:

### Index Page (`index.md`)

An overview of the entire API surface including:
- Global functions with links to their pages
- Namespaces with member counts and links
- Type listing (interfaces and enums)
- Capabilities table with descriptions and risk levels

### Binding Pages (`bindings/*.md`)

One page per top-level binding. For functions, the page includes:
- TypeScript signature
- Parameter table (name, type, required, description)
- Return type
- Capability requirements
- Usage examples from the manifest

For namespaces, all member functions are documented on a single page with their individual signatures, parameters, and annotations.

### Type Pages (`types/*.md`)

One page per custom type. For object types:
- Field table (name, type, required, description)
- TypeScript interface definition

For enum types:
- List of allowed values
- TypeScript string literal union definition

## Programmatic Usage

```javascript
import { generateDocs, generateDocsFromFile, writeDocsToDirectory } from "@xriptjs/docgen";

// From a manifest object
const result = generateDocs(manifest);
// result.pages is an array of { slug, title, content }

// From a file
const result = await generateDocsFromFile("./manifest.json");

// Write to a directory
const written = await writeDocsToDirectory(result, "./api-docs/");
```

## Integration Tips

The generated markdown pages are designed to work with any static site generator. To use them with Starlight:

1. Generate pages to your docs content directory
2. Add entries to your Starlight sidebar configuration
3. Pages include proper headings and markdown formatting that renders well in any documentation framework
