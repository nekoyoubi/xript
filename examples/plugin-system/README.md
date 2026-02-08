# Plugin System Example

This example demonstrates **xript's tier 2 adoption**: namespaces, capabilities, and custom types. It shows how a host application can run multiple plugins with different permission levels.

## What It Does

A task manager application loads an xript manifest that exposes task operations through a `tasks` namespace. Some operations (listing, getting) are ungated, while others require capabilities:

| Operation | Capability Required |
|-----------|-------------------|
| `tasks.list()` | None |
| `tasks.get(id)` | None |
| `tasks.add(title, priority)` | `manage-tasks` |
| `tasks.complete(id)` | `manage-tasks` |
| `tasks.remove(id)` | `admin` |

The demo runs five plugins with different capability profiles to show how the security model works.

## Quick Start

From the repository root:

```sh
npm install
npm run build --workspace=runtimes/js
node examples/plugin-system/src/demo.js
```

## The Five Plugins

### 1. Task Reporter (no capabilities)

Can read tasks but not modify them. Demonstrates that ungated bindings work for all plugins.

### 2. Task Creator (`manage-tasks`)

Can add tasks and mark them complete. Creates three tasks and completes one.

### 3. Read-Only Dashboard (no capabilities)

Reads task counts, then tries to sneak in a `tasks.add()` call. The runtime blocks it with a `CapabilityDeniedError`.

### 4. Admin Cleanup (`manage-tasks` + `admin`)

Has full access. Removes a completed task to clean up.

### 5. Privilege Escalation Attempt (`manage-tasks` only)

Has `manage-tasks` but not `admin`. Tries to call `tasks.remove()` and gets blocked. Having one capability does not grant access to another.

## Key Concepts Demonstrated

- **Namespaces**: The `tasks` binding groups related operations under one object
- **Custom types**: `Task` and `Priority` are defined in the manifest and used in bindings
- **Capability gating**: Functions require specific capabilities to call
- **Default-deny**: Plugins start with zero capabilities; each must be explicitly granted
- **No transitive trust**: Having `manage-tasks` does not imply `admin`
- **Catchable errors**: `CapabilityDeniedError` includes the function name and required capability
