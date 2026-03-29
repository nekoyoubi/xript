# Tools Docs Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate six tool documentation pages into three (CLI, TUI Wizard, Fragment Workbench) and delete the redundant individual pages.

**Architecture:** Replace five CLI subcommand pages with one unified CLI reference page. Create a new TUI Wizard page with ASCII mockups. Leave Fragment Workbench untouched. Update sidebar and CLAUDE.md.

**Tech Stack:** Markdown, Astro Starlight, astro.config.mjs

---

### Task 1: Create the unified CLI reference page

**Files:**
- Create: `docs/src/content/docs/tools/cli.md`

- [ ] **Step 1: Create `docs/src/content/docs/tools/cli.md`**

Write this file with the full content below. The content is consolidated from the five existing pages plus new `scan` documentation.

```markdown
---
title: CLI
description: The xript command-line interface — validate, generate, scaffold, sanitize, and scan.
---

The `xript` CLI is a single command with subcommands for every tool in the xript ecosystem. Validate manifests, generate TypeScript definitions, produce markdown documentation, scaffold new projects, sanitize HTML fragments, and scan annotated source code into manifests.

## Install

```bash
npm install -g @xriptjs/cli
```

Or run without installing:

```bash
npx xript <command>
```

## Commands

| Command | Description |
|---------|-------------|
| `xript validate` | Check manifests against the xript spec schema |
| `xript typegen` | Generate TypeScript definitions from a manifest |
| `xript docgen` | Generate markdown documentation from a manifest |
| `xript init` | Scaffold a new xript app or mod project |
| `xript sanitize` | Strip dangerous content from HTML fragments |
| `xript scan` | Read `@xript` annotations from TypeScript source into a manifest |

---

## validate

Checks that a manifest conforms to the xript specification schema. Catches structural errors, invalid field names, wrong types, and missing required fields.

### Usage

```bash
xript validate <manifest...>
```

Accepts one or more manifest files. The validator auto-detects whether each file is an app manifest or a mod manifest based on its structure.

### Cross-validation

The `--cross` flag validates that a mod's fragments target valid slots in the host app:

```bash
xript validate --cross app-manifest.json mod-manifest.json
```

Cross-validation checks:
- Every fragment targets a slot that exists in the app manifest
- Every fragment's format is in the slot's `accepts` list
- Every capability the mod requests is defined in the app manifest

### Example

```
$ xript validate manifest.json
  ✓ manifest.json is valid

$ xript validate broken.json
  ✗ broken.json has errors:
    - /name: must match pattern "^[a-z][a-z0-9-]*$"
    - /bindings/doStuff: must have required property 'description'
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All manifests are valid |
| `1` | One or more manifests have errors |

### Programmatic API

```typescript
import {
  validateManifest,
  validateModManifest,
  crossValidate,
  validateManifestFile,
} from "@xriptjs/validate";

const result = validateManifest({
  xript: "0.3",
  name: "my-app",
  bindings: { greet: { description: "Greets." } },
  slots: [{ id: "sidebar", accepts: ["text/html"] }],
});

const modResult = await validateModManifest({
  xript: "0.3",
  name: "my-mod",
  version: "1.0.0",
  fragments: [{ id: "panel", slot: "sidebar", format: "text/html", source: "<p>hi</p>" }],
});

const crossResult = await crossValidate(appManifest, modManifest);

const fileResult = await validateManifestFile("./manifest.json");
```

---

## typegen

Reads a manifest and produces TypeScript definition files. Gives extenders autocomplete, type checking, and inline documentation.

### Usage

```bash
xript typegen <manifest>
xript typegen <manifest> --output types.d.ts
xript typegen <manifest> -o types.d.ts
```

Prints to stdout by default. Use `--output` / `-o` to write to a file.

### Type mapping

| Manifest | TypeScript |
|----------|-----------|
| `"string"` | `string` |
| `"number"` | `number` |
| `"boolean"` | `boolean` |
| `"void"` | `void` |
| `"string[]"` | `string[]` |
| `{ "array": "Position" }` | `Position[]` |
| `{ "union": ["string", "number"] }` | `string \| number` |
| `{ "map": "number" }` | `Record<string, number>` |
| `{ "optional": "string" }` | `string \| undefined` |

Custom object types become `interface` declarations. Enum types become string literal unions.

### Fragment API types

When the manifest declares `slots`, the generator produces additional types:

- **`FragmentProxy`** — `toggle`, `addClass`, `removeClass`, `setText`, `setAttr`, `replaceChildren`
- **`hooks.fragment`** — typed lifecycle registration: `mount`, `unmount`, `update`, `suspend`, `resume`
- **`XriptSlots`** — describes available slots with accepted formats, multiplicity, and styling modes

### Generated JSDoc

- Function descriptions become the main JSDoc comment
- Parameter descriptions become `@param` tags
- Capability requirements become `@remarks Requires capability` annotations
- Deprecation notices become `@deprecated` tags

### Example

Given a manifest with a `greet` binding and a `Position` type:

```typescript
// Auto-generated by @xriptjs/typegen

/** A 2D position. */
interface Position {
  /** Horizontal coordinate. */
  x: number;
  /** Vertical coordinate. */
  y: number;
}

/**
 * Returns a greeting.
 * @param name - The name to greet.
 */
declare function greet(name: string): string;
```

### Programmatic API

```typescript
import { generateTypes, generateTypesFromFile } from "@xriptjs/typegen";

const dts = generateTypes(manifest);

const { content } = await generateTypesFromFile("./manifest.json");
```

---

## docgen

Reads a manifest and produces a structured set of markdown documentation pages. Every binding, type, and capability gets its own page with signatures, parameter tables, and examples.

### Usage

```bash
xript docgen <manifest> --output docs/api/
xript docgen <manifest> -o docs/api/
xript docgen <manifest> -o docs/ --link-format no-extension
xript docgen <manifest> -o docs/ --frontmatter "layout: ../layouts/Doc.astro"
```

### Options

| Flag | Description |
|------|-------------|
| `--output`, `-o` | Output directory (required) |
| `--link-format no-extension` | Strip `.md` extensions from generated links (for static site generators) |
| `--frontmatter` | Inject YAML frontmatter into all generated pages |

### Output structure

The generator creates these page types:

- **Index** (`index.md`) — overview of the entire API surface: global functions, namespaces, types, capabilities table
- **Binding pages** (`bindings/*.md`) — one per top-level binding with signatures, parameter tables, return types, capability requirements
- **Type pages** (`types/*.md`) — one per custom type with field tables and TypeScript definitions
- **Fragment API** (`fragment-api.md`) — lifecycle hooks and proxy operations (when manifest has slots)

### Example

```
$ xript docgen manifest.json -o api-docs/
✓ Generated 10 documentation pages to /path/to/api-docs
  api-docs/index.md
  api-docs/bindings/log.md
  api-docs/bindings/player.md
  api-docs/types/Position.md
  api-docs/types/Item.md
```

### Programmatic API

```typescript
import { generateDocs, generateDocsFromFile, writeDocsToDirectory } from "@xriptjs/docgen";

const result = generateDocs(manifest);

const result = await generateDocsFromFile("./manifest.json");

const written = await writeDocsToDirectory(result, "./api-docs/");
```

---

## init

Scaffolds new xript projects with a manifest, package configuration, and a demo script.

### Usage

```bash
xript init [directory]
xript init [directory] --yes
xript init [directory] --mod
xript init [directory] --mod --yes
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `[directory]` | Target directory for the project | Current directory |
| `--yes`, `-y` | Skip prompts, use defaults | `false` |
| `--mod` | Scaffold a mod project instead of an app | `false` |
| `--tier <2\|3>` | Adoption tier (app projects only) | `2` |
| `--typescript` | Generate TypeScript output | (default) |
| `--javascript` | Generate JavaScript output | |

### Interactive mode

```
$ xript init my-mod
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

### Mod scaffolding

Use `--mod` to scaffold a mod project with a mod manifest, fragment HTML, and entry script:

```
my-health-panel/
├── mod-manifest.json
├── src/
│   └── mod.ts
├── fragments/
│   └── panel.html
└── package.json
```

The generated fragment includes `data-bind` for value display and `data-if` for conditional visibility. The entry script demonstrates the sandbox fragment API.

### Adoption tiers

**Tier 2 (Bindings):** Simple host bindings with capability gating. Good for apps that need a few extension points like custom formatting or data transformations.

**Tier 3 (Full Scripting):** Namespace bindings, hooks, custom types, and capabilities. Designed for apps with rich extension APIs like game engines or extensible platforms.

Tier 1 (expression-only) is simple enough that no scaffolding is needed.

### Programmatic API

```typescript
import { writeProject, generateProjectFiles } from "@xriptjs/init";

const result = await writeProject("./my-mod", {
  name: "my-mod",
  tier: 2,
  language: "typescript",
});

const files = generateProjectFiles({ name: "my-app", tier: 3, language: "typescript" });
```

---

## sanitize

Cleans HTML fragment content before it reaches the host. Pure string-based with no DOM dependency — runs inside QuickJS WASM, Node, Deno, browsers, wherever.

### Usage

```bash
xript sanitize <file>
xript sanitize <file> --validate
xript sanitize <file> --quiet
```

### Options

| Flag | Description |
|------|-------------|
| `--validate` | Show what was stripped alongside the sanitized output |
| `--quiet` | Output sanitized HTML only, no diagnostics |

### What gets preserved

Structural and presentational elements: `div`, `span`, `p`, `h1`–`h6`, `ul`/`ol`/`li`, `table` family, `details`/`summary`, `section`, `article`, `header`, `footer`, `a`, `img`, `br`, `hr`, and more.

Safe attributes: `class`, `id`, `data-*` (including `data-bind` and `data-if`), `aria-*`, `role`, `style` (sanitized), `src`/`href` (safe URIs only), `alt`, `width`, `height`, `tabindex`, `hidden`.

Scoped `<style>` blocks with dangerous CSS properties stripped.

### What gets stripped

**Elements removed entirely (including children):** `script`, `iframe`, `object`, `embed`, `form`, `base`, `link`, `meta`, `title`, `noscript`, `applet`.

**Document wrappers unwrapped (children preserved):** `html`, `head`, `body`.

**Attributes stripped:** all `on*` event attributes, `formaction`, `action`, `method`.

**URIs stripped:** `javascript:`, `vbscript:`, dangerous `data:` URIs. Safe image `data:` URIs on `src` are preserved.

**CSS stripped:** `url()` references, `expression()`, `-moz-binding`, `behavior:` properties.

### Conformance

All xript runtime implementations must produce identical sanitized output. The conformance test suite lives at `spec/sanitizer-tests.json` with 45 test cases.

### Programmatic API

```typescript
import { sanitizeHTML, sanitizeHTMLDetailed, validateFragment } from "@xriptjs/sanitize";

const clean = sanitizeHTML('<div onclick="evil()">safe text</div>');
// => '<div>safe text</div>'

const result = sanitizeHTMLDetailed('<script>alert("xss")</script><p>safe</p>');
// result.html => '<p>safe</p>'
// result.strippedElements => ['script']

const validation = validateFragment('<div data-bind="health">0</div>');
// validation.valid => true
```

---

## scan

Reads `@xript` and `@xript-cap` JSDoc annotations from TypeScript source files and generates manifest bindings and capabilities. Optionally merges scanned results into an existing manifest.

### Usage

```bash
xript scan <directory>
xript scan <directory> --output bindings.json
xript scan <directory> --manifest manifest.json
xript scan <directory> --manifest manifest.json --write
```

### Options

| Flag | Description |
|------|-------------|
| `--manifest`, `-m` | Merge scanned bindings into an existing manifest |
| `--output`, `-o` | Write scanned bindings to a file (instead of stdout) |
| `--write` | Write merged manifest back to disk (requires `--manifest`) |

### Annotations

Annotate exported functions with `@xript` to declare them as bindings. Dot-delimited paths create namespace nesting.

```typescript
/**
 * Get value from the data store.
 *
 * @xript data.get
 */
export function getData(path: string): DataResult { ... }
```

Use `@xript-cap` to gate a binding behind a capability:

```typescript
/**
 * Transfer currency between players.
 *
 * @xript economy.transfer
 * @xript-cap modify-state
 */
export function transferCurrency(fromId: string, toId: string, amount: number): void { ... }
```

Standard `@deprecated` tags are also recognized:

```typescript
/**
 * @xript player.getHealth
 * @deprecated Use player.stats.get("health") instead
 */
export function getPlayerHealth(): number { ... }
```

### What gets extracted

| Source | Manifest field |
|--------|---------------|
| `@xript <path>` | Binding path (dot nesting) |
| `@xript-cap <name>` | `capability` |
| JSDoc description | `description` |
| `@param` tags + TypeScript types | `params` array |
| Return type / `@returns` | `returns` |
| `async` keyword or `Promise<>` | `async: true` |
| `@deprecated` | `deprecated` |

Files scanned: all `*.ts` in the target directory, excluding `node_modules/`, `*.test.ts`, `*.spec.ts`, and `*.d.ts`. Requires `ts-morph` (the CLI prompts if it's missing).

### Merge mode

With `--manifest`, the scanner compares scanned bindings against the existing manifest:

- **Added** bindings are inserted
- **Removed** bindings are warned about but not deleted
- **Unchanged** bindings are left untouched (manual edits preserved)
- **Capability gaps** — capabilities referenced in `@xript-cap` but not defined in the manifest — are auto-generated with `risk: "low"`

Without `--write`, merge mode previews the result to stdout. With `--write`, it updates the manifest file on disk.

```
$ xript scan src/ -m manifest.json --write
Added 2 binding(s): data.get, data.set
! 1 binding(s) in manifest but not in source: legacy.old
! 2 capability gap(s): storage, network
✓ Updated manifest.json
```

### Programmatic API

```typescript
import { scanDirectory, mergeIntoManifest } from "@xriptjs/cli/scan";

const scanned = await scanDirectory("./src");
// scanned.bindings — nested binding tree
// scanned.capabilities — auto-generated capabilities
// scanned.diagnostics — errors and warnings

const merged = await mergeIntoManifest(existingManifest, scanned);
// merged.manifest — the merged result
// merged.added — new binding paths
// merged.removed — paths in manifest but not source
// merged.capabilityGaps — capabilities referenced but not defined
```
```

- [ ] **Step 2: Verify the file was created correctly**

Run: `head -5 docs/src/content/docs/tools/cli.md`
Expected: frontmatter with title "CLI"

- [ ] **Step 3: Commit**

```bash
git add docs/src/content/docs/tools/cli.md
git commit -m "$(cat <<'EOF'
added unified CLI reference page

- consolidated validator, typegen, docgen, init, and sanitize pages into one CLI page
- added `scan` subcommand documentation (was previously undocumented)
- each subcommand section covers CLI usage, flags, examples, and programmatic API
- install instructions appear once instead of five times
EOF
)"
```

---

### Task 2: Create the TUI Wizard page

**Files:**
- Create: `docs/src/content/docs/tools/wiz.md`

- [ ] **Step 1: Create `docs/src/content/docs/tools/wiz.md`**

Write this file with the full content below:

```markdown
---
title: TUI Wizard
description: Interactive terminal wizard for manifest analysis — audit capability coverage, diff against git tags, and more.
---

`xript-wiz` is an interactive terminal wizard for working with xript manifests. Built in Rust, it dogfoods the xript ecosystem — its UI is rendered via `xript-ratatui`, the same fragment renderer available to any Rust host application.

## Install

```bash
cargo install xript-wiz
```

Or build from source:

```bash
cd tools/wiz
cargo build --release
```

## Home

The home screen is a menu of six actions. Use arrow keys or `j`/`k` to navigate, `Enter` to select, `q` to quit.

```
╭────────────────────────────────────────────╮
│ ✓ Validate                                 │
│ Check a manifest against the xript spec    │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ⚡ Scaffold                                │
│ Create a new app or mod project            │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ≡ Sanitize                                 │
│ Clean dangerous content from HTML fragments│
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ⚙ Audit                                   │
│ Analyze manifest capability coverage       │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ Δ Diff                                     │
│ Compare manifest against last git tag      │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ ✕ Quit                                     │
│ Exit the wizard                            │
╰────────────────────────────────────────────╯

          ↑↓ navigate · Enter select · q quit
```

The selected item is highlighted with colored borders. Validate, Scaffold, and Sanitize are interactive versions of the corresponding CLI subcommands. Audit and Diff are unique to the wizard.

## Audit

Analyzes a manifest's capability coverage and identifies security gaps. Enter a path to a manifest file (with tab completion), then the wizard produces a report.

```
Enter path to a manifest file:
> manifest.json

╭ Audit Report ────────────────────────────╮
│ ✓ Audit: my-app                          │
│                                          │
│ Capabilities: 4 defined                  │
│   Risk: 2 low, 1 medium, 1 high         │
│                                          │
│ Ungated (2):                             │
│   • auth.login                           │
│   • api.call                             │
│                                          │
│ Unused capabilities (1):                 │
│   • deprecated.feature                   │
│                                          │
│ Capability gaps (1):                     │
│   • new.feature                          │
╰──────────────────────────────────────────╯

    Tab complete · Enter audit · Esc back
```

The report covers:

- **Capabilities summary** — count and risk distribution (low, medium, high)
- **Ungated bindings** — bindings without capability gates (potential security surface)
- **Unused capabilities** — defined but never referenced (dead weight)
- **Capability gaps** — referenced in bindings but never defined (incomplete manifest)

The report border is green when clean, yellow when issues are found, red on errors.

## Diff

Compares the current manifest against the version at the last git tag, surfacing what changed in bindings, capabilities, and slots.

```
Enter path to a manifest file:
> manifest.json

╭ Manifest Diff ───────────────────────────╮
│ Diff: my-app (current vs v1.0.0)        │
│                                          │
│ Added bindings (2):                      │
│   + auth.mfa                             │
│   + player.inventory.sort                │
│                                          │
│ Removed bindings (1):                    │
│   - legacy.api                           │
│                                          │
│ Added capabilities (1):                  │
│   + mfa.verify                           │
│                                          │
│ Added slots (1):                         │
│   + settings-panel                       │
╰──────────────────────────────────────────╯

    Tab complete · Enter diff · Esc back
```

The wizard runs `git describe --tags` to find the last tag, retrieves the old manifest via `git show`, and diffs the two. Sections with no changes are omitted. If nothing changed, the report reads "No changes since last tag."

## Keybindings

| Key | Action |
|-----|--------|
| `↑` / `k` | Navigate up |
| `↓` / `j` | Navigate down |
| `Enter` | Select / submit |
| `Tab` | Apply completion suggestion |
| `Esc` | Back to home (or quit from home) |
| `q` | Quit (from home) |
| `Ctrl+C` | Force quit |
```

- [ ] **Step 2: Verify the file was created correctly**

Run: `head -5 docs/src/content/docs/tools/wiz.md`
Expected: frontmatter with title "TUI Wizard"

- [ ] **Step 3: Commit**

```bash
git add docs/src/content/docs/tools/wiz.md
git commit -m "$(cat <<'EOF'
added TUI Wizard documentation page

- documented home menu, audit screen, and diff screen with ASCII mockups
- covered install via `cargo install` and building from source
- included keybindings reference table
EOF
)"
```

---

### Task 3: Update sidebar and delete old pages

**Files:**
- Modify: `docs/astro.config.mjs:60-70`
- Delete: `docs/src/content/docs/tools/validator.md`
- Delete: `docs/src/content/docs/tools/typegen.md`
- Delete: `docs/src/content/docs/tools/docgen.md`
- Delete: `docs/src/content/docs/tools/init.md`
- Delete: `docs/src/content/docs/tools/sanitize.md`

- [ ] **Step 1: Update the sidebar config**

In `docs/astro.config.mjs`, replace the Tools section (lines ~61-69):

Old:
```javascript
{
    label: "Tools",
    items: [
        { label: "Validator", slug: "tools/validator" },
        { label: "Type Generator", slug: "tools/typegen" },
        { label: "Doc Generator", slug: "tools/docgen" },
        { label: "Init CLI", slug: "tools/init" },
    { label: "Sanitizer", slug: "tools/sanitize" },
    { label: "Fragment Workbench", slug: "tools/fragment-workbench" },
    ],
},
```

New:
```javascript
{
    label: "Tools",
    items: [
        { label: "CLI", slug: "tools/cli" },
        { label: "TUI Wizard", slug: "tools/wiz" },
        { label: "Fragment Workbench", slug: "tools/fragment-workbench" },
    ],
},
```

- [ ] **Step 2: Delete the five old pages**

```bash
rm docs/src/content/docs/tools/validator.md
rm docs/src/content/docs/tools/typegen.md
rm docs/src/content/docs/tools/docgen.md
rm docs/src/content/docs/tools/init.md
rm docs/src/content/docs/tools/sanitize.md
```

- [ ] **Step 3: Verify only three tool pages remain**

```bash
ls docs/src/content/docs/tools/
```

Expected: `cli.md`, `fragment-workbench.mdx`, `wiz.md`

- [ ] **Step 4: Commit**

```bash
git add docs/astro.config.mjs docs/src/content/docs/tools/validator.md docs/src/content/docs/tools/typegen.md docs/src/content/docs/tools/docgen.md docs/src/content/docs/tools/init.md docs/src/content/docs/tools/sanitize.md
git commit -m "$(cat <<'EOF'
consolidated Tools sidebar to three pages

- replaced 6 sidebar entries with 3: CLI, TUI Wizard, Fragment Workbench
- deleted `validator.md`, `typegen.md`, `docgen.md`, `init.md`, `sanitize.md`
- content migrated to the unified `cli.md` page in Task 1
EOF
)"
```

---

### Task 4: Update CLAUDE.md page count

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update doc page count references**

In `CLAUDE.md`, find and update these references:

1. Under "Developer Experience": change "31 pages" to "28 pages"
2. Under "Docs Site" in memory MEMORY.md: change "31 pages total" to "28 pages total"

The math: 31 existing - 5 deleted + 2 added = 28.

Also update the Tools description in CLAUDE.md if it references individual tool pages.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
updated CLAUDE.md for tools docs consolidation

- changed doc page count from 31 to 28 (removed 5 individual tool pages, added CLI + Wizard)
EOF
)"
```

---

### Task 5: Verify docs build

- [ ] **Step 1: Run the docs build**

```bash
npm run docs:build
```

Expected: clean build with no errors. Starlight should resolve all three tool slugs and the Fragment Workbench page should be unaffected.

- [ ] **Step 2: If build fails, fix any broken internal links or slug references**

Check build output for warnings about missing pages. The most likely issue would be other pages linking to the old tool slugs. Search for references:

```bash
grep -r "tools/validator\|tools/typegen\|tools/docgen\|tools/init\|tools/sanitize" docs/src/content/
```

If any are found, update them to point to the appropriate section anchors on `tools/cli` (e.g., `tools/cli#validate`).

- [ ] **Step 3: Commit any link fixes**

```bash
git add -u docs/
git commit -m "$(cat <<'EOF'
fixed internal links to consolidated tool pages
EOF
)"
```

Only run this step if Step 2 found and fixed broken links. Skip if the build was clean.

---

### Task 6: Final commit and verify

- [ ] **Step 1: Run `git log --oneline -6` to verify all commits landed**

Expected: 3-5 commits from this plan (CLI page, Wizard page, sidebar + deletions, CLAUDE.md, optionally link fixes).

- [ ] **Step 2: Run `git status` to verify clean working tree**

Expected: no uncommitted changes related to docs (there may be unrelated changes from earlier in the session).
