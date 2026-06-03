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
| `xript run` | Run a mod in the QuickJS WASM sandbox and optionally invoke an export |
| `xript describe` | Summarize what a host manifest exposes: bindings, hooks, slots, capabilities |
| `xript score` | Score a host's moddability capacity, the extension surface it exposes |
| `xript score-diff` | Compare a host's score against a saved baseline; moved toward or away from xript |
| `xript lint` | Review a host + mods for actionable findings, the complement to `score` |
| `xript guide` | Print xript authoring doctrine by topic |
| `xript mcp` | Start the MCP server: the CLI's capabilities, for agents |

---

## validate

Checks that a manifest conforms to the xript specification schema. Catches structural errors, invalid field names, wrong types, and missing required fields.

### Usage

```bash
xript validate <manifest...>
```

Accepts one or more manifest files. The validator auto-detects whether each file is an app manifest or a mod manifest based on its structure.

### Cross-validation

The `--cross` flag validates that a mod's fills target valid slots in the host app:

```bash
xript validate --cross app-manifest.json mod-manifest.json
xript validate --cross app-manifest.json mod-manifest.json --no-fill-payloads
```

Cross-validation checks:
- Every fill targets a slot that exists in the app manifest
- Every fill's format is in the target slot's `accepts` list
- The mod holds the capability of every gated slot it fills
- Every capability the mod requests is defined in the app manifest
- Each fill's payload is checked against the target slot's payload JSON Schema (on by default). Extra properties pass unless the slot closes its payload; pass `--no-fill-payloads` to skip this check.

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
  xript: "0.6",
  name: "my-app",
  bindings: { greet: { description: "Greets." } },
  slots: [{ id: "sidebar", accepts: ["text/html"] }],
});

const modResult = await validateModManifest({
  xript: "0.6",
  name: "my-mod",
  version: "1.0.0",
  fills: {
    sidebar: [{ id: "panel", format: "text/html", source: "<p>hi</p>" }],
  },
});

const crossResult = await crossValidate(appManifest, modManifest, { checkFillPayloads: true });

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

Custom object types become `interface` declarations. Enum types become string literal unions. An open enum (`open: true` on a type's `values` or a field's inline `enum`) means "the known values, plus any other string" — the generator emits `"known" | "values" | (string & {})` so authors keep autocomplete on the known set while any string still type-checks.

Pass `--ambient` to emit an ambient `.d.ts` that declares the global `xript` namespace, for authoring mods in TypeScript:

```bash
xript typegen <manifest> --ambient -o xript.d.ts
```

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
- **Type pages** (`types/*.md`) — one per custom type with field tables and TypeScript definitions. Open enums (`open: true`) are marked extensible — the documented values are the known set, but any string is accepted
- **Hook pages** (`hooks/*.md`) — one per declared hook
- **Fragment API** (`fragment-api.md`) — lifecycle hooks and proxy operations (when manifest has slots)
- **Capability Grant Shapes** (`capability-grant-shapes.md`) — the grant/install/discovery wire shapes, when the manifest opts in

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

Cleans HTML fragment content before it reaches the host. Pure string-based with no DOM dependency, so it runs inside QuickJS WASM, Node, Deno, browsers, wherever.

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

All xript runtime implementations must produce identical sanitized output. The conformance test suite lives at `spec/sanitizer-tests.json` with 56 test cases.

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

---

## lint

Reviews a host manifest and any number of mod manifests and emits actionable findings about how well they fit together. Where [`score`](/tools/score/) returns a single number, `lint` returns the list of things to fix. Every check is set arithmetic over manifest fields — no source analysis. See the [Lint](/tools/lint/) page for the full check catalog and severity model.

### Usage

```bash
xript lint <host> [mods...]
xript lint <host> [mods...] --json
xript lint <host> [mods...] --strict
```

### Options

| Flag | Description |
|------|-------------|
| `--json` | Emit the findings and counts as JSON instead of a formatted report |
| `--strict` | Treat warnings as failures (exit nonzero on any `warn`) |

### Findings

Each finding carries a `severity` (`error`, `warn`, `info`), a stable `code`, a `message`, and a `suggestion`. Findings are grouped and counted by severity.

| Code | Severity | When |
|------|----------|------|
| `filled-but-undeclared` | error | a mod fills a slot id the host never declares |
| `undeclared-capability` | error | a slot or mod references a capability the host never declares |
| `abstract-type-unfilled` | error | a type inherited as `abstract` is never concretized by the host |
| `dead-slot` | warn | a declared slot no supplied mod fills (skips `reserved` and inherited slots) |
| `vestigial-capability` | warn | a declared capability nothing references — no slot, binding, hook, or mod (skips `reserved` and inherited) |
| `ungated-slot` | info | a slot with no `capability` — any mod may fill it |
| `undescribed` | info | a slot or capability missing a `description` |
| `legacy-shape` | info | a mod uses the deprecated `fragments[]` / `contributions` shape instead of `fills` |

Fills are read from both the new `fills` surface and the legacy `fragments[]` / `contributions.slots`, so lint works mid-migration. Slots and capabilities marked `"reserved": true` are aspirational surface — never flagged as dead or vestigial, and excluded from the coverage denominators. Capabilities that gate a binding or hook (not just a slot) now count as used.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | No errors (and no warnings under `--strict`) |
| `1` | At least one error, or any warning under `--strict` |

### Example

```
$ xript lint host.json mod-a.json mod-b.json
  ✗ 1 error, 2 warnings, 1 info

  error  filled-but-undeclared slot
    mod-b fills "sidebar.right" but the host declares no such slot
    → declare a "sidebar.right" slot, or correct the slot id in mod-b

  warn   dead slot
    "footer.status" is declared but no mod fills it
    → drop it, or mark it aspirational
```

### Programmatic API

The analyzers (`lintManifests`, `scoreManifests`, `diffScores`) live in `@xriptjs/validate`. Import them from the validation library your host already depends on; the CLI and MCP server are thin front-ends over them.

```typescript
import { lintManifests } from "@xriptjs/validate";

const { findings, counts } = lintManifests(hostManifest, [modA, modB], { strict: false });
// findings — [{ severity, code, message, suggestion }, ...]
// counts — { error, warn, info }
```

---

## run

Loads a mod into the QuickJS WASM sandbox and optionally invokes one of its exports. Useful for exercising a mod against a host without wiring up a full application.

### Usage

```bash
xript run <mod-manifest.json> <entry-script>
xript run <mod-manifest.json> <entry-script> --export greet --args '["world"]'
xript run <mod-manifest.json> <entry-script> --app host.json --cap modify-state,ui-mount
```

### Options

| Flag | Description |
|------|-------------|
| `--export`, `-e <name>` | Invoke a named export after the mod loads |
| `--args <json>` | JSON array of arguments for the invoked export |
| `--app <manifest>` | Host app manifest (a minimal host is used otherwise) |
| `--cap <c1,c2>` | Comma-separated capabilities to grant |

The result (load status, export return value, audit entries) is printed as JSON. Exit code is `0` when the mod loaded, `1` otherwise.

### Programmatic API

```typescript
import { runMod } from "@xriptjs/cli";

const result = await runMod({ modManifest, source, appManifest, capabilities, invoke });
```

---

## describe

Summarizes what a host manifest exposes — its bindings, hooks, slots, and capabilities — then prints the generated documentation. The fast way to see a host's extension surface.

### Usage

```bash
xript describe <manifest.json>
xript describe <manifest.json> --summary
```

### Options

| Flag | Description |
|------|-------------|
| `--summary` | Print only the surface summary (JSON), not the generated docs |

### Programmatic API

```typescript
import { describeManifest } from "@xriptjs/cli";

const { summary, docs } = describeManifest(manifest);
```

---

## score

Rates a host's **moddability capacity**: how much of xript's extension surface (bindings, slots, events, and a capability model) the host exposes, against a ceiling of exposing all of it. The headline is `round(100 × capacity)`, where capacity averages how many of those four surfaces are present.

Exposing a slot no mod fills reads as moddability, not waste, so the score is about what the host *offers*, not how much a supplied mod set happens to exercise. `extends` is resolved before scoring, and resolving inheritance can only raise the score. How much your supplied mods fill (slot and capability coverage) survives as **informational** mod-coverage, reported but not scored, with `reserved` and inherited surface excluded from its denominators.

### Usage

```bash
xript score <host-manifest> [mods...]
xript score <host-manifest> [mods...] --min 70
xript score <host-manifest> [mods...] --json
```

### Options

| Flag | Description |
|------|-------------|
| `--min <n>` | Exit non-zero if the headline is below `n` (or any integrity violation exists) — a CI gate |
| `--json` | Emit the full result as JSON |

### Programmatic API

```typescript
import { scoreManifests } from "@xriptjs/validate";

const result = await scoreManifests(hostManifest, [modA, modB], { min: 70 });
// result.headline — 0–100 moddability capacity
// result.capacity — exposed / absent surfaces
// result.slots, result.capabilities — informational mod coverage
```

---

## score-diff

Compares a host's current score against a saved baseline (a prior `xript score --json` result), reporting whether the codebase moved toward or away from xript.

### Usage

```bash
xript score host.json mods/*.json --json > baseline.json
xript score-diff baseline.json host.json mods/*.json
xript score-diff baseline.json host.json mods/*.json --min-delta 0
```

### Options

| Flag | Description |
|------|-------------|
| `--min-delta <n>` | Gate: exit non-zero if the headline fell by more than `n`, or any new integrity violation appeared |
| `--json` | Emit the full diff as JSON |

### Programmatic API

```typescript
import { scoreManifests, diffScores } from "@xriptjs/validate";

const current = await scoreManifests(hostManifest, mods);
const diff = diffScores(baseline, current, { minDelta: 0 });
```

---

## guide

Prints xript's authoring doctrine by topic — including "More extensible, not less," the framework's default toward openness. The doctrine is authored once as content and shared verbatim across this command, the `xript_guide` MCP tool, and the `xript://guidance/*` MCP resources.

### Usage

```bash
xript guide            # list available topics
xript guide surfaces   # print a topic
```

Topics include `when-to-use`, `surfaces`, `mod-zero`, `boundary`, `openness`, `authoring`, `hosting`, and `tiers`.

---

## mcp

Starts the CLI's capabilities as an MCP server over stdio, so an agent can validate, score, lint, scaffold, and read xript's spec and doctrine without shelling out.

### Usage

```bash
xript mcp
```

Configure your MCP client to run `xript mcp`. The server exposes:

- **Tools** — one per CLI command, mirroring the human surface 1:1: `xript_validate`, `xript_cross_validate`, `xript_typegen`, `xript_docgen`, `xript_sanitize`, `xript_scaffold`, `xript_scan`, `xript_manifest_describe`, `xript_run`, `xript_score`, `xript_score_diff`, `xript_lint`, and `xript_guide`, plus `xript_server_info`.
- **Resources** — the spec docs under `xript://spec/*` and the authoring guidance under `xript://guidance/*`.
- **Prompts** — doctrine-carrying prompts for adopting xript, judging whether a surface is xript-native, choosing a surface, and authoring a mod.

### Programmatic API

```typescript
import { createServer } from "@xriptjs/cli";

const server = await createServer("0.6.0");
```
