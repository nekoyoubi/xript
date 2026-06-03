---
title: Lint
description: A findings-based reviewer for host and mod manifests; the actionable complement to the extensibility score.
---

`xript lint` answers the question the [score](/tools/score/) leaves open: **not "how moddable is this host" but "what should I fix?"** Where `score` collapses a host and its mods into a single number, `lint` returns the list behind that number: one finding per issue, each with a suggestion. Reach for `score` when you want a CI gate; reach for `lint` when you want the punch list.

```bash
xript lint host.json mods/*.json
```

It is also an MCP tool (`xript_lint`) and a library export, `lintManifests` from `@xriptjs/validate`, so an agent, a CI job, and a host application reach the same review the terminal does. Because it lives in the validation library a host already depends on, an app can surface a modder's problems in its own UI without bundling the CLI.

## What it checks

Every check is set arithmetic over fields that already exist in the manifests. Nothing is inferred from running code, and the inner shape of a fill is never policed; that contract belongs to the slot's `accepts` type, not the linter.

| Code | Severity | What it catches | Suggestion |
|------|----------|-----------------|------------|
| `filled-but-undeclared` | `error` | a mod fills a slot id the host never declares | declare the slot, or remove the fill |
| `undeclared-capability` | `error` | a slot's `capability`, or a capability a mod requests, that the host never declares | declare the capability |
| `abstract-type-unfilled` | `error` | a type inherited as `abstract: true` from an `extends` base that the host never concretized | redeclare the type with concrete `fields` or `values` |
| `dead-slot` | `warn` | a declared slot no supplied mod fills | mark it `reserved`, or drop it |
| `vestigial-capability` | `warn` | a declared capability nothing references — no slot, binding, hook, or mod | mark it `reserved`, gate something on it, or drop it |
| `ungated-slot` | `info` | a slot with no `capability` — any mod may fill it | gate it if that's unintended |
| `undescribed` | `info` | a slot or capability missing a `description` | describe it |
| `legacy-shape` | `info` | a mod still on the deprecated `fragments` / `contributions` shape | move its fills under `fills` |

A `reserved` slot or capability (one declared for canon parity or a future surface, marked `"reserved": true`) is treated as aspirational, so it never trips the dead-slot or vestigial-capability warning. The same exclusion applies to surface a host **inherited** from an `extends` base: an inherited-but-unfilled slot or inherited-but-unreferenced capability is not the host's defect, so neither is flagged. Capabilities that gate a binding or a hook (not just a slot) count as used, so a capability doing real gating work is never called vestigial.

The `abstract-type-unfilled` error is the inheritance counterpart: a base manifest can mark a type `abstract: true`, declaring a typed hole a child is **required** to fill. Resolve the host's `extends` chain, leave that hole open, and lint reports it as a hard error, the same way the cross-validator and the runtimes treat it.

Fills are read from both the new [`fills`](/spec/mod-manifest/#fills) surface and the legacy `fragments[]` / `contributions.slots`, so lint stays useful while a project migrates; the `legacy-shape` note lets you watch the un-migrated count tick to zero instead of grepping for it.

## The severity model

Three levels, and the line between them is sharp:

- **`error`** — the contract is broken. A fill points at a slot that doesn't exist, or a capability is referenced but never declared. These are the same drift the cross-validator catches; latent until the runtime gets wired, then a hard failure.
- **`warn`** — the contract holds but the surface is sloppy. A slot nothing fills, a capability nothing references; dead weight that makes the host look richer than it is.
- **`info`** — a nudge, not a problem. An ungated slot any mod may fill, a surface missing its description. Worth a glance, never a blocker.

Findings are grouped and counted by severity, so the headline is a glance: `1 error, 2 warnings, 1 info`.

## How it relates to score

`score` and `lint` read the same manifests and share the same arithmetic; they differ in what they hand back. `score` is the number: a litmus and a CI floor. `lint` is the findings: the actionable detail under that number. A host scoring below its gate is told *that* it fell short; lint tells it *why*, line by line, with a fix for each. Run `score` to gate; run `lint` to clear the gate.

Neither reads intent. Lint can flag a dead slot; it cannot tell whether the slot was meant to be dead. Use it as a punch list, and the [host/mod boundary](/guidance/boundary/) doctrine for the judgment it cannot make.

## Gating in CI

By default `lint` exits non-zero only when an `error` exists, so it pairs cleanly with `score --min` without double-failing on soft signals. To hold the line on warnings too, pass `--strict`:

```bash
xript lint manifest.json addons/*/manifest.json --strict
```

Under `--strict`, any `warn` fails the run alongside errors. Drop that into a project's check script and dead slots and vestigial capabilities get caught on every commit, not whenever someone remembers to look.

## Output

The default report is human-formatted and grouped by severity. For machine consumption (an agent or a dashboard), `--json` emits the raw shape:

```json
{
  "findings": [
    {
      "severity": "error",
      "code": "filled-but-undeclared",
      "message": "mod \"mod-b\" fills slot \"sidebar.right\" which the host does not declare",
      "suggestion": "Declare a slot with id \"sidebar.right\" in the host manifest, or remove the fill."
    }
  ],
  "counts": { "error": 1, "warn": 0, "info": 0 }
}
```

## Programmatic API

```typescript
import { lintManifests } from "@xriptjs/validate";

const { findings, counts } = lintManifests(hostManifest, [modA, modB], { strict: false });
// findings — [{ severity, code, message, suggestion }, ...]
// counts — { error, warn, info }
```

`lintManifests` reads the manifests as given; it does not resolve `extends` for you. To match the CLI (it resolves the host's inheritance chain before linting and excludes inherited surface), pass the resolver's output:

```typescript
import { lintManifests, resolveProvenance } from "@xriptjs/validate";

const { resolved, inheritedSlots, inheritedCapabilities, inheritedAbstractTypes } =
  await resolveProvenance(hostManifest, hostDir);
const { findings, counts } = lintManifests(resolved, [modA, modB], {
  strict: false,
  inheritedSlots,
  inheritedCapabilities,
  inheritedAbstractTypes,
});
```
