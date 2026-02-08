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

## Design Rationale

### Why Not Role-Based Access Control?

RBAC introduces complexity: roles, role hierarchies, role assignments. xript's capability model is deliberately simpler. Capabilities are flat (no hierarchy), binary (granted or not), and bound directly to functions. This maps cleanly to the manifest structure and is easy to validate statically.

### Why Not Per-Invocation Grants?

Checking capabilities on every function call would add runtime overhead and require the host to maintain per-call permission state. Per-script grants are simpler, faster, and match the mental model: "this script is allowed to do these things."

### Why Advisory Risk Levels Instead of Enforced Tiers?

The `risk` field is advisory because risk is context-dependent. Writing to storage might be `low` risk for a game mod but `high` risk for a financial tool. The manifest author sets the risk level based on their application's context; the runtime shows it to users but doesn't enforce behavior differences.
