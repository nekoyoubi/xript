---
title: Extensibility Score
description: A litmus for how moddable a host actually is; moddability capacity and contract integrity, computed from manifests.
---

`xript score` answers a blunt question: **how moddable is this host, really?** It computes a number from the host manifest: how much of xript's extension surface the host exposes, against a ceiling of exposing all of it. A high score does not mean the surface is well-designed; a low score reliably means the host is barely opened up for modding. It is a litmus, not a proof.

```bash
xript score host.json mods/*.json --min 70
```

It is also an MCP tool (`xript_score`) and a library export (`scoreManifests` from `@xriptjs/validate`), so an agent, a CI job, and a host application reach the same computation the terminal does, without bundling the CLI.

The headline is **moddability capacity**, not coverage: it measures how much surface the host exposes, *not* how much a supplied mod set happens to exercise. Exposing a slot that no mod fills reads as moddability, not waste, and because resolving `extends` only adds inherited surface, inheritance can only raise the score, never drag it down. Mod manifests are still accepted (and cross-validated for contract integrity), but how thoroughly they fill the surface is reported as informational context, not scored.

## What it measures

Every metric is set arithmetic over fields that already exist in the manifests. Nothing is inferred from running code. `extends` is resolved before scoring, so inherited slots and capabilities count as exposed surface.

### Moddability capacity (the headline)

The headline number is **capacity**: of xript's five extension surfaces, how many does the host expose? A surface counts as exposed the moment the host declares at least one of it.

- **`bindings`** — host functions a mod can call
- **`slots`** — typed extension points a mod fills (fragments, provider roles, event handlers)
- **`events`** — named events the host broadcasts for a mod to observe
- **`libraries`** — approved libraries mod code may import in-sandbox
- **`capabilities`** — the model that gates the other three

The score is the fraction of those five surfaces the host exposes, scaled to 100 (`round(100 * exposed / 5)`). A host that exposes bindings, slots, capabilities, and events but declares no `libraries` allow-list scores 80. There is no penalty for declaring a slot nothing fills; an unfilled slot is open modding surface, so capacity only ever rises as a host opens up more.

### Contract integrity

The strict part, and the part that finds real bugs. It aggregates what the validator already knows, plus one host-internal check the per-manifest validators miss:

- every `slot`'s `capability` is actually declared in `capabilities`
- every supplied mod cross-validates against the host: requested capabilities are grantable, each fill targets a real slot, and each fill's payload satisfies the slot's `payload` schema

An integrity violation is a bug, not a soft signal. It is the class of drift where a host manifest falls behind the code it describes: latent until the runtime gets wired, then a hard failure. Integrity is reported alongside the headline, and a violation fails any `--min` gate regardless of the capacity number.

### Mod coverage (informational)

If you point `score` at a set of mods, it also reports how much of the host's own surface those mods exercise. This is informational context, not part of the headline.

- **Slots:** the host's own non-reserved slots that at least one mod fills (through its `fills` object).
- **Capabilities:** the host's own non-reserved capabilities that a mod requests or that gate a binding, slot, or hook.

Slots and capabilities the host **inherited** through `extends`, and any flagged [`reserved`](#reserved-surface), are excluded from the coverage denominators; you are not penalized for leaving inherited or aspirational surface unfilled. This is the old "mod-zero read": aim `score` at a host's *own bundled* mods and the slot coverage tells you how much of its surface the application's own content exercises.

## Reserved surface

A slot or capability marked `reserved: true` is aspirational: surface declared ahead of a filler, for forward-compat or to match an inherited base. Reserved surface still counts as exposed for the capacity headline, but it is never flagged dead or vestigial and is excluded from the coverage denominators. Use it when you want to publish a slot before any mod fills it without the linter nagging that it is unused.

## What it does not measure

`score` cannot tell whether a binding or hook is *called from inside a mod's script*; that lives in the script, not the manifest. And it cannot tell whether the host/mod boundary is *drawn correctly*: it can confirm the surface is exposed and the contract holds, but it cannot read intent. A 100 means all five surfaces are open and the contract holds, not that the design is right. Use the score as a floor and a litmus; use [`xript lint`](/tools/lint/) for the actionable list of dead slots and vestigial capabilities behind the number, and the [host/mod boundary](/guidance/boundary/) doctrine for the judgment neither tool can make.

## Gating in CI

`--min N` exits non-zero when the headline falls below `N` or any integrity violation exists, which makes it a tier-one gate:

```bash
xript score manifest.json addons/*/manifest.json --min 70
```

Drop that into a project's check script and the host contract is enforced on every commit, instead of remembered when someone happens to run a tool.

## Tracking it over time

A number is a floor; a *trend* is a direction. `xript score-diff` compares a current run against a saved baseline and reports whether the surface moved toward or away from xript: the capacity delta (which of the five surfaces became exposed or went absent), the informational coverage deltas, and any integrity violation introduced or fixed.

Save a baseline once, then diff against it:

```bash
xript score host.json addons/*/manifest.json --json > baseline.json
# ...changes happen...
xript score-diff baseline.json host.json addons/*/manifest.json --min-delta 0
```

`--min-delta N` is the regression gate: it exits non-zero if the capacity headline fell by more than `N`, or if any new integrity violation appeared. With `--min-delta 0`, any drop in exposed surface or new contract violation fails the check. It is also the `xript_score_diff` MCP tool, so an agent can ask the same question after a change.

## Programmatic use

Hosts that already depend on `@xriptjs/validate` can score and diff without the CLI. The analyzers live in the validation library; the CLI and MCP tool are thin front-ends over them.

```js
import { scoreManifests, diffScores } from "@xriptjs/validate";

const result = await scoreManifests(hostManifest, [modA, modB], { min: 70 });
console.log(result.headline, result.capacity.exposed, result.integrity.passed);

const diff = diffScores(baselineResult, result, { minDelta: 0 });
console.log(diff.direction, diff.headline.delta);
```

`scoreManifests` takes optional `inheritedSlots` / `inheritedCapabilities` so a host that resolves `extends` itself can mark inherited surface out of the coverage denominators; the `xript score` command derives those for you via `resolveProvenance`.
