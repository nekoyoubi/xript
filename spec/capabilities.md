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

Capability names should be:
- Lowercase with hyphens (`modify-player`, not `modifyPlayer` or `MODIFY_PLAYER`)
- Action-oriented when possible (`read-files`, `modify-world`, `send-messages`)
- Scoped by domain when the API is large (`player-read`, `player-write`, `world-read`, `world-write`)

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

Functions without a `capability` field are accessible to all scripts unconditionally. This is the common case for read-only operations that pose no risk. The manifest author decides what is gated — the default is "available."

### Multiple Capabilities

A function can reference at most one capability. If a function logically requires multiple permissions, either:
- Create a composite capability (e.g., `admin` that implies broad access)
- Split the function into smaller, individually-gated functions

The manifest does not support listing multiple capabilities per function. This is intentional: the simplicity of "one function, one gate" makes the model easy to reason about for both integrators and modders.

## Runtime Behavior

### Capability Lifecycle

1. **Declaration**: The manifest declares which capabilities exist and which bindings they gate.
2. **Request**: When a script is loaded, the runtime inspects which capabilities it needs (determined by which gated functions it calls, or declared in a script manifest).
3. **Grant decision**: The host application receives the capability request and decides whether to grant each one. This decision is application-specific — it might be automatic, user-prompted, or policy-driven.
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

The channel reports **allowed** invocations only. A denied (ungranted-capability) call throws before invocation and is already observable as the thrown capability-denied error — it is not double-reported as an audit event. Emission is fire-and-forget: a full or dropped channel never breaks script execution. Omitting the channel disables auditing with zero overhead. This is a host-side observation seam (mechanism only); grant policy and UX stay host-side per the default-deny philosophy.

## Host Runtime Options

These are host-side runtime options, not manifest-declared fields. They are documented here for completeness; the manifest schema does not change for them.

- **Cancellation**: a host-held `CancellationToken` on the runtime options. Flipping it (`cancel()`) interrupts the in-flight execution cooperatively at the next interrupt check, surfacing a cancellation error distinct from a timeout. Cancellation is sticky and idempotent; a fresh execution on a cancelled token errors immediately. It reuses the deadline/interrupt mechanism. Dropping the runtime does not auto-cancel.
- **Hard limits**: host-imposed ceilings (`timeout_ms`, `memory_mb`, `max_stack_depth`) that a manifest's `limits` cannot exceed. The effective limit is `min(manifest, hard)` per field, clamped silently rather than rejecting the manifest, so an over-greedy mod still loads under the host ceiling.
- **Console severity**: the console handler routes five severities — `Trace`, `Debug`, `Info`, `Warn`, `Error`. The sandbox `console` exposes six methods: `log`, `info`, `warn`, `error`, `debug`, `trace`. Both `console.log` and `console.info` map to `Info` severity. `console.trace` is the lowest-severity channel, not a stack-dumper.
- **Debug**: an optional `debug` option attaches a DAP-shaped debug session before execution (see [Debug Protocol](./debug-protocol.md)). It is default-off with zero overhead when absent, mirroring the audit channel. xript imposes no capability for it — it is purely a host-side toggle. A host should not attach a debugger to untrusted production scripts; that gate is host policy, not an xript capability.

## Grant Shapes (host-side)

Granting a capability still flows exactly as before: the host passes capability names into `RuntimeOptions.capabilities`. The runtimes never see a grant prompt, a grant decision, or any of the shapes below — **grant policy and prompt UX are host-side, mechanism-not-policy.**

xript defines three optional wire shapes so adopters share a vocabulary and can reuse reference UIs. They live entirely in host-side glue and never enter the sandbox.

- **`CapabilityPrompt`** (`capability-prompt.schema.json`) — what a host needs to render a first-time or elevation grant prompt: the capability name, its `description` and `risk` (drawn from the manifest capability definition), the requesting `mod`, the `requestedScope`, the prompt `state`, and an optional `reason`. The `requestedScope` enum is `one-run | session | persistent`; the `state` enum is `first-time | previously-denied | requesting-elevation`. Both are closed and identical across hosts — adopt these as the canonical vocabulary.
- **`InstallDescriptor`** (`install-descriptor.schema.json`) — what identifies an installable mod: `name`, `version`, `source` (`type` is `file | url | registry`), optional `integrity` and `signature` strings, declared `capabilities`, and an optional inline `manifest`. `integrity` and `signature` are host-verified — xript defines the fields and never checks them.
- **`DiscoveryResult`** (`discovery-result.schema.json`) — what an addon-discovery pass yields: a `mods` array (each with `name`, `version`, `location`, `enabled`, `capabilities`, and `provides`) plus `scannedAt`. The `provides` entries are logical roles, sharing the vocabulary of mod-manifest `contributions.provides`.

A prompt payload merely **describes** a request. Granting still happens host-side through `RuntimeOptions.capabilities`; default-deny is preserved.

## Design Rationale

### Why Not Role-Based Access Control?

RBAC introduces complexity: roles, role hierarchies, role assignments. xript's capability model is deliberately simpler. Capabilities are flat (no hierarchy), binary (granted or not), and bound directly to functions. This maps cleanly to the manifest structure and is easy to validate statically.

### Why Not Per-Invocation Grants?

Checking capabilities on every function call would add runtime overhead and require the host to maintain per-call permission state. Per-script grants are simpler, faster, and match the mental model: "this script is allowed to do these things."

### Why Advisory Risk Levels Instead of Enforced Tiers?

The `risk` field is advisory because risk is context-dependent. Writing to storage might be `low` risk for a game mod but `high` risk for a financial tool. The manifest author sets the risk level based on their application's context; the runtime shows it to users but doesn't enforce behavior differences.
