---
title: "Example: Plugin System"
description: A tier 2 integration walkthrough — namespaces, capabilities, and custom types.
---

This example demonstrates a full-featured plugin system using xript's tier 2 features: namespaces to organize bindings, capabilities to gate destructive operations, and custom types to describe data structures. Five plugins run against the same host, each with a different permission profile.

The full source is in [`examples/plugin-system/`](https://github.com/nekoyoubi/xript/tree/main/examples/plugin-system).

## The Manifest

The manifest declares a `tasks` namespace with five methods and a top-level `log` function:

```json
{
  "xript": "0.1",
  "name": "task-manager",
  "version": "1.0.0",
  "bindings": {
    "tasks": {
      "description": "Read and manage tasks.",
      "members": {
        "list":     { "description": "Returns all tasks.", "returns": { "array": "Task" } },
        "get":      { "description": "Returns a task by ID.", "params": [{ "name": "id", "type": "string" }] },
        "add":      { "description": "Creates a new task.", "params": [...], "capability": "manage-tasks" },
        "complete": { "description": "Marks a task as done.", "params": [...], "capability": "manage-tasks" },
        "remove":   { "description": "Permanently removes a task.", "params": [...], "capability": "admin" }
      }
    },
    "log": { "description": "Writes a message to the plugin console.", "params": [...] }
  }
}
```

Key observations:

- `tasks.list` and `tasks.get` have **no capability gate** -- any plugin can read tasks
- `tasks.add` and `tasks.complete` require the **`manage-tasks`** capability
- `tasks.remove` requires the **`admin`** capability -- a higher privilege tier
- `log` is a top-level function with no gate

### Capabilities

```json
{
  "capabilities": {
    "manage-tasks": { "description": "Create and complete tasks.", "risk": "medium" },
    "admin": { "description": "Delete tasks and admin operations.", "risk": "high" }
  }
}
```

### Custom Types

```json
{
  "types": {
    "Task": {
      "description": "A task in the task manager.",
      "fields": {
        "id": { "type": "string" },
        "title": { "type": "string" },
        "done": { "type": "boolean" },
        "priority": { "type": "Priority" },
        "createdAt": { "type": "string" }
      }
    },
    "Priority": {
      "description": "Task priority levels.",
      "values": ["low", "medium", "high", "urgent"]
    }
  }
}
```

Types do not enforce runtime validation -- they serve as documentation for plugin authors and feed into tools like `xript-typegen` and `xript-docgen`.

## The Host

The host creates a shared task store and wires up the namespace methods:

```javascript
const taskStore = [];

const hostBindings = {
  tasks: {
    list: () => [...taskStore],
    get: (id) => taskStore.find((t) => t.id === id),
    add: (title, priority) => {
      const task = { id: String(nextId++), title, done: false, priority, createdAt: new Date().toISOString() };
      taskStore.push(task);
      return task;
    },
    complete: (id) => { /* mark done */ },
    remove: (id) => { /* splice from array */ },
  },
  log: (msg) => console.log(`[plugin] ${msg}`),
};
```

Each plugin gets its own runtime instance but shares the same underlying `taskStore`. This means plugins can see each other's changes -- a deliberate design choice for this example.

The factory is initialized once, then each plugin creates a runtime from it:

```javascript
import { initXript } from "@xript/runtime-js";
const xript = await initXript();
```

## The Five Plugins

### 1. Task Reporter (no capabilities)

```javascript
const runtime = xript.createRuntime(manifest, { hostBindings, capabilities: [] });
runtime.execute("tasks.list()");
runtime.execute('log("Found " + tasks.list().length + " tasks")');
```

Can read tasks and call `log`, but cannot create, complete, or remove tasks.

### 2. Task Creator (manage-tasks)

```javascript
const runtime = xript.createRuntime(manifest, { hostBindings, capabilities: ["manage-tasks"] });
runtime.execute('tasks.add("Write documentation", "high")');
runtime.execute('tasks.complete("1")');
```

Can create and complete tasks, but cannot remove them (no `admin` capability).

### 3. Read-Only Dashboard (no capabilities)

```javascript
const runtime = xript.createRuntime(manifest, { hostBindings, capabilities: [] });
runtime.execute('tasks.list().filter(t => !t.done).length'); // works
runtime.execute('tasks.add("Sneaky task", "low")');          // CapabilityDeniedError
```

Demonstrates that even after other plugins have created tasks, a plugin without capabilities still cannot modify them.

### 4. Admin Cleanup (manage-tasks + admin)

```javascript
const runtime = xript.createRuntime(manifest, { hostBindings, capabilities: ["manage-tasks", "admin"] });
runtime.execute('tasks.remove("1")');
```

Full access. Can read, create, complete, and remove tasks.

### 5. Privilege Escalation Attempt (manage-tasks only)

```javascript
const runtime = xript.createRuntime(manifest, { hostBindings, capabilities: ["manage-tasks"] });
runtime.execute('tasks.remove("2")'); // CapabilityDeniedError: requires "admin"
```

Having `manage-tasks` does not grant `admin`. Each capability must be explicitly granted.

## Running the Demo

```sh
cd examples/plugin-system
node src/demo.js
```

The demo runs all five plugins sequentially, showing which operations succeed and which are denied.

## Concepts Demonstrated

| Concept | Where |
|---------|-------|
| Namespaces | `tasks.list()`, `tasks.add()` |
| Capability gating | `manage-tasks` on add/complete, `admin` on remove |
| Tiered permissions | Plugin 5 has `manage-tasks` but not `admin` |
| Custom types | `Task` and `Priority` in the manifest |
| Default-deny | Plugins 1 and 3 get read-only access |
| Shared state | All plugins see the same task store |

## When to Use This Pattern

Tier 2 is the right choice when:

- You need to **organize bindings into logical groups** (namespaces)
- Some operations are **destructive or sensitive** and need permission gating
- You want to **document data structures** for plugin authors
- Different plugins need **different permission levels**
