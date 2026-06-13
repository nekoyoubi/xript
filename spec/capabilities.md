# xript Capability Model

The capability model defines how xript enforces its default-deny security posture. Every sensitive operation is gated behind a named capability that scripts must be explicitly granted before use. This document specifies how capabilities are declared, requested, granted, and enforced.

## Core Principles

1. **Default-deny.** Scripts start with zero capabilities. They can only call ungated bindings until capabilities are explicitly granted.
2. **Explicit grants.** The host application decides which capabilities a script receives. Scripts cannot grant themselves capabilities.
3. **No ambient authority.** Having one capability does not imply access to another. Each capability is independent.
4. **Transparent to the modder.** Modders should always know which capabilities their script needs and what each one grants.

## Declaring Capabilities

Capabilities are declared in the manifest's `capabilities` section:

```json
{
  "capabilities": {
    "modify-player": {
      "description": "Modify the player's stats, inventory, and equipment.",
      "risk": "medium"
    },
    "network": {
      "description": "Make HTTP requests to allowed domains.",
      "risk": "high"
    },
    "storage": {
      "description": "Read and write persistent data for this mod.",
      "risk": "low"
    }
  }
}
```

Each capability has:
- **`description`** (required): A human-readable explanation of what the capability grants. This is shown to users when a script requests it.
- **`risk`** (`low`, `medium`, `high`): An advisory level that helps users make informed decisions. Does not affect runtime behavior.

### Naming Conventions

A declared capability key is **scope-only**: a dot-delimited path of lowercase-hyphen segments, with no mode prefix. A host declares a scope node once (`run`, `run.command`, `fs.addon`); the `read:`/`write:` axis is a property of a grant or require *reference*, not of the declaration.

Capability scope names should be:
- Lowercase with hyphens per segment (`modify-player`, not `modifyPlayer` or `MODIFY_PLAYER`)
- Action-oriented when possible (`read-files`, `modify-world`, `send-messages`)
- Dotted by domain when the API is large (`fs.addon`, `run.command`, `world.terrain`) — the dot is the scope delimiter and supports prefix-subsumption (see [Hierarchical Capabilities](#hierarchical-capabilities))

The grammar for a declared capability key is `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$`. A *reference* to a capability (a binding/hook/slot/event `capability` field, or a grant) additionally permits an optional `read:` or `write:` mode prefix: `^(read:|write:)?[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$`.

## Gating Bindings

Individual functions are gated by referencing a capability name in their `capability` field:

```json
{
  "bindings": {
    "player": {
      "description": "Player functions.",
      "members": {
        "getHealth": {
          "description": "Returns the player's health.",
          "returns": "number"
        },
        "setHealth": {
          "description": "Sets the player's health.",
          "params": [{ "name": "value", "type": "number" }],
          "capability": "modify-player"
        }
      }
    }
  }
}
```

In this example, `player.getHealth()` is always available (no `capability` field), but `player.setHealth()` requires the `modify-player` capability.

### Ungated Bindings

Functions without a `capability` field are accessible to all scripts unconditionally. This is the common case for read-only operations that pose no risk. The manifest author decides what is gated; the default is "available."

### Multiple Capabilities

A function can reference at most one capability. If a function logically requires multiple permissions, either:
- Create a composite capability (e.g., `admin` that implies broad access)
- Split the function into smaller, individually-gated functions

The manifest does not support listing multiple capabilities per function. This is intentional: the simplicity of "one function, one gate" makes the model easy to reason about for both integrators and modders.

## Runtime Behavior

### Capability Lifecycle

1. **Declaration**: The manifest declares which capabilities exist and which bindings they gate.
2. **Request**: When a script is loaded, the runtime inspects which capabilities it needs (determined by which gated functions it calls, or declared in a script manifest).
3. **Grant decision**: The host application receives the capability request and decides whether to grant each one. This decision is application-specific; it might be automatic, user-prompted, or policy-driven.
4. **Enforcement**: The runtime makes only granted capabilities available. Calls to gated functions without the required capability fail with a `CapabilityDeniedError`.

### Calling a Gated Function Without the Capability

When a script calls a function it doesn't have the capability for, the runtime must:
1. Throw a `CapabilityDeniedError` with a clear message including the capability name
2. Not execute the function (no partial execution, no side effects)
3. Allow the script to catch the error and continue running

Example error message: `CapabilityDeniedError: calling "player.setHealth" requires the "modify-player" capability, which has not been granted to this script.`

### Capability Grants Are Immutable

Once a script's capabilities are set at load time, they cannot change during execution. A script cannot request additional capabilities mid-run. This prevents escalation attacks and simplifies the security model.

If a host application wants to support dynamic permission prompting, it should do so during the grant phase (before execution begins), not during script execution.

## Hierarchical Capabilities

A capability name has two orthogonal axes: a **scope** (a dot-delimited tree) and a **mode** (a read/write lattice). The two never collapse into a single string compare; the matcher splits once on a colon and matches the halves with two different operators.

### Reference syntax

A capability string is `[<mode>:]<scope>`:

- `<mode>` is `read` or `write`. The colon is the axis separator and is forbidden inside a scope segment, so the split is unambiguous. An absent prefix means `write`, the top of the lattice (full access).
- `<scope>` is a dot-delimited path of `[a-z][a-z0-9-]*` segments. The hyphen stays a within-segment character (`modify-player`, `player-write` are legal single segments); the dot is promoted to the structural scope delimiter.

Examples: `fs.addon`, `read:fs.addon`, `write:run.command`, bare `run` (≡ `write:run`).

Declared capability **keys** carry no mode prefix — a host declares a scope node once; the mode is a property of a grant or require *reference*.

### The match predicate

A **grant** and a **require** are both capability strings. A grant *satisfies* a require iff **both** axes match. The reference algorithm is identical across all four runtimes:

```
fn splitMode(cap: str) -> (mode: str, scope: str):
    i = cap.indexOf(':')
    if i < 0:
        return ("write", cap)              // no prefix ⇒ top of lattice
    prefix = cap[0..i]
    return (prefix, cap[i+1..])            // "read"/"write" expected; unknown ⇒ fail-closed at match

fn satisfies(grant: str, require: str) -> bool:
    (gMode, gScope) = splitMode(grant)
    (rMode, rScope) = splitMode(require)
    modeOk  = (gMode == "write") || (gMode == rMode)
    scopeOk = (gScope == rScope) || rScope.startsWith(gScope + ".")
    return modeOk && scopeOk

fn grantedSatisfies(granted: Set<str>, require: str) -> bool:
    return any(satisfies(g, require) for g in granted)
```

**Mode (lattice match, `write` ⊒ `read`).** A `write` grant satisfies both `read:` and `write:` requires; a `read` grant satisfies only `read:` requires. `modeSatisfies(g, r) = (g.mode == "write") || (g.mode == r.mode)`.

**Scope (prefix subsumption on the dot tree).** `g.scope == r.scope || r.scope.startsWith(g.scope + ".")`. The `+ "."` boundary is mandatory and matches on whole dot-segments — `run` subsumes `run.command` but does **not** subsume `runner`.

**Set semantics.** The granted *set* satisfies a require iff **any single grant** in the set satisfies it (existential; no cross-grant composition — one grant must independently cover both axes). An empty granted set denies (vacuous `any`).

Every gate site evaluates `grantedSatisfies(granted, required)` rather than a bare set-membership check. The null/empty guard is preserved unchanged: an unspecified `capability` field still means "always available."

### Why the mode axis is not just another scope segment

Mode is a lattice and scope is a tree; flattening mode into the scope tree (e.g. `fs.addon.read`) would let a `fs.addon` grant subsume **both** `fs.addon.read` and `fs.addon.write` by prefix, silently granting write to anyone holding the read scope and breaking the read/write distinction in the write→read direction. The colon keeps the lattice and the tree from contaminating each other.

### The monotonic-privilege invariant (normative)

A capability scope node **MUST NOT** be more privileged than any of its dotted ancestors. Formally: for every grant `g` a host issues, and for every capability `c` that `g` subsumes by prefix (`c == g.scope` or `c.startsWith(g.scope + ".")`), the access `g` confers on `c` MUST be one the host considers acceptable for the entire subtree rooted at `g.scope`. A child scope MUST NOT name an escalation that its parent would not also grant; if a sub-scope needs to confer strictly MORE than its parent (e.g. a privileged `run.command.shell`), the host MUST re-root that authority under a SEPARATE top-level scope rather than nest it where a broad parent grant would silently sweep it in (re-rooting beats hoisting). The mode axis composes monotonically with this: a `write:` grant on a scope MUST be treated as conferring at least the `read:` authority on every node in that subtree, never less.

**This invariant CANNOT be statically enforced.** The match predicate is purely structural — it knows that `run` subsumes `run.command`, but it cannot know whether `run.command` is semantically a narrowing of `run` or an escalation smuggled under a benign-looking name. No runtime gate, no schema pattern, and no tooling check can verify that a host's scope tree is monotonic, because monotonicity is a property of what each scope MEANS to the host, not of the strings. It therefore becomes a PER-HOST AUDIT DISCIPLINE: when a host author adds a child scope, they MUST verify by inspection that no ancestor grant would confer authority over the child that the child's name understates. `xript lint` MAY surface candidate violations heuristically (e.g. flag child segments named `admin`/`shell`/`exec`/`root`/`sudo`/`all` whose parent is broadly granted) as warnings, but a clean lint is NOT a proof of monotonicity and MUST NOT be represented as one.

## Capability Discovery

Modders need to know which capabilities exist and what they grant. The manifest provides this information:

- **Tooling**: `xript-validate` can list all capabilities and which functions they gate
- **Typegen**: Generated TypeScript types include JSDoc annotations indicating which functions require capabilities
- **Docgen**: Generated documentation groups functions by capability requirement

A modder writing a script should be able to look at the generated types or docs and immediately see: "I need `modify-player` to use `player.setHealth()` and `player.addItem()`."

## Observability

Hosts may observe capability-gated activity through an opt-in **audit channel** on the runtime options. When set, the runtime emits one audit event *before* each allowed host-binding invocation, carrying the binding's qualified name, the capability it required (or none if the binding declares no capability), and a wall-clock timestamp in epoch milliseconds:

```jsonc
{ "binding": "app.setClipboard", "capability": "clipboard-write", "at": 1730000000000 }
```

The channel reports **allowed** invocations only. A denied (ungranted-capability) call throws before invocation and is already observable as the thrown capability-denied error; it is not double-reported as an audit event. Emission is fire-and-forget: a full or dropped channel never breaks script execution. Omitting the channel disables auditing with zero overhead. This is a host-side observation seam (mechanism only); grant policy and UX stay host-side per the default-deny philosophy.

## Host Runtime Options

These are host-side runtime options, not manifest-declared fields. They are documented here for completeness; the manifest schema does not change for them.

- **Cancellation**: a host-held `CancellationToken` on the runtime options. Flipping it (`cancel()`) interrupts the in-flight execution cooperatively at the next interrupt check, surfacing a cancellation error distinct from a timeout. Cancellation is sticky and idempotent; a fresh execution on a cancelled token errors immediately. It reuses the deadline/interrupt mechanism. Dropping the runtime does not auto-cancel.
- **Hard limits**: host-imposed ceilings (`timeout_ms`, `memory_mb`, `max_stack_depth`) that a manifest's `limits` cannot exceed. The effective limit is `min(manifest, hard)` per field, clamped silently rather than rejecting the manifest, so an over-greedy mod still loads under the host ceiling.
- **Console severity**: the console handler routes five severities — `Trace`, `Debug`, `Info`, `Warn`, `Error`. The sandbox `console` exposes six methods: `log`, `info`, `warn`, `error`, `debug`, `trace`. Both `console.log` and `console.info` map to `Info` severity. `console.trace` is the lowest-severity channel, not a stack-dumper.
- **Debug**: an optional `debug` option attaches a DAP-shaped debug session before execution (see [Debug Protocol](./debug-protocol.md)). It is default-off with zero overhead when absent, mirroring the audit channel. xript imposes no capability for it — it is purely a host-side toggle. A host should not attach a debugger to untrusted production scripts; that gate is host policy, not an xript capability.

## Grant Shapes (host-side)

Granting a capability still flows exactly as before: the host passes capability names into `RuntimeOptions.capabilities`. The runtimes never see a grant prompt, a grant decision, or any of the shapes below. **Grant policy and prompt UX are host-side, mechanism-not-policy.**

xript defines three optional wire shapes so adopters share a vocabulary and can reuse reference UIs. They live entirely in host-side glue and never enter the sandbox.

- **`CapabilityPrompt`** (`capability-prompt.schema.json`) — what a host needs to render a first-time or elevation grant prompt: the capability name, its `description` and `risk` (drawn from the manifest capability definition), the requesting `mod`, the `requestedScope`, the prompt `state`, and an optional `reason`. The `requestedScope` enum is `one-run | session | persistent`; the `state` enum is `first-time | previously-denied | requesting-elevation`. Both are closed and identical across hosts — adopt these as the canonical vocabulary.
- **`InstallDescriptor`** (`install-descriptor.schema.json`) — what identifies an installable mod: `name`, `version`, `source` (`type` is `file | url | registry`), optional `integrity` and `signature` strings, declared `capabilities`, and an optional inline `manifest`. `integrity` and `signature` are host-verified; xript defines the fields and never checks them.
- **`DiscoveryResult`** (`discovery-result.schema.json`) — what an addon-discovery pass yields: a `mods` array (each with `name`, `version`, `location`, `enabled`, `capabilities`, and `provides`) plus `scannedAt`. The `provides` entries are logical roles, sharing the vocabulary of mod-manifest `contributions.provides`.

A prompt payload merely **describes** a request. Granting still happens host-side through `RuntimeOptions.capabilities`; default-deny is preserved.

## Design Rationale

### Why Not Role-Based Access Control?

RBAC introduces complexity: roles, role hierarchies, role assignments. xript's capability model is deliberately simpler. The case against RBAC rests on three separable claims about how capabilities differ from roles, and only two of them survive.

1. **Binary, not graded.** A capability is granted or it is not; there is no partial role membership, no "level 3 of role X." A gate either admits a script or throws `CapabilityDeniedError`. This keeps the grant decision a single yes/no the host can reason about and a user can be prompted on, with no role-resolution step in between.
2. **Bound directly to functions (and slots, hooks, events), not to abstract roles.** A capability names a concrete gate site, so the question "what does granting this allow?" is answered by reading the manifest, not by chasing a role through a hierarchy of assignments. The contribution surface gates the *thing*, not a role that the thing happens to belong to.
3. ~~**Flat, not hierarchical.**~~ This claim no longer holds, and is deliberately dropped. Capabilities **do** have structure: a dotted scope tree with prefix-subsumption, plus an orthogonal read/write mode lattice (see [Hierarchical Capabilities](#hierarchical-capabilities)). A grant on `run` subsumes `run.command`; a `write:` grant subsumes the `read:` authority on the same scope. The structure xript rejected was RBAC's *role* hierarchy (indirection through named roles and role-to-permission assignments), not all structure. Scope subsumption is a property of the capability strings themselves, evaluated by a purely structural match predicate with no role layer; it earns its hierarchy without re-introducing roles.

### Why Not Per-Invocation Grants?

Checking capabilities on every function call would add runtime overhead and require the host to maintain per-call permission state. Per-script grants are simpler, faster, and match the mental model: "this script is allowed to do these things."

### Why Advisory Risk Levels Instead of Enforced Tiers?

The `risk` field is advisory because risk is context-dependent. Writing to storage might be `low` risk for a game mod but `high` risk for a financial tool. The manifest author sets the risk level based on their application's context; the runtime shows it to users but doesn't enforce behavior differences.
