# xript Security Guarantees

This document defines the security guarantees that xript-conformant runtimes must provide. These guarantees exist so that users running third-party scripts never have to wonder whether a script is safe. It is safe. That is the contract.

The guarantees formalize the four safety principles from the vision: no sandbox escape, no denial of service, no implicit trust, and no eval. Each guarantee includes the specific runtime behavior required, the failure mode when violated, and testable conformance criteria.

## The Four Guarantees

### 1. No Sandbox Escape

Scripts cannot access anything the host has not explicitly exposed through bindings declared in the manifest.

**What this means concretely:**

- Scripts have no access to the host's file system, network, processes, or environment variables unless a binding explicitly provides it
- Scripts cannot import or require modules outside the runtime's provided environment
- Module-format entries may use ES module syntax, but ALL import specifiers (bare, absolute, URL, and relative) are rejected at link time with an `ImportDeniedError`. A module-format mod is a single self-contained entry module with no imports (see [Modules](./modules.md))
- CommonJS is never supported. A mod entry containing `require()`, `module.exports`, or `exports.x` artifacts is rejected at load time with a `CommonJSDetectedError`, in both script and module mode
- Scripts cannot access or modify the host application's internal state except through declared bindings
- Scripts cannot access other scripts' state or memory
- The global scope available to scripts contains only: the language built-ins (as restricted below), the declared bindings, and nothing else

**Host object isolation:**

Objects returned from bindings must be copies or proxies, not direct references to host-internal objects. A script receiving a player position object must not be able to traverse prototype chains or property references to reach host internals. Runtimes should either deep-copy returned values or use membrane patterns that intercept property access.

A copied value's keys are data. A runtime that copies a host object into the sandbox defines each key as an own, enumerable, writable data property; it never assigns it. Assignment runs setters, and an own key spelled `__proto__` (which `JSON.parse` produces) would then replace the copy's prototype instead of arriving as a key: its contents readable through inheritance, the key itself invisible to `Object.keys`. [`marshal-tests.json`](./marshal-tests.json) is the shared corpus every runtime is held to.

**A script function never crosses out to the host as data.** The reverse of the copy rule governs values leaving the sandbox: a function the script returns from an `execute`, an export, a hook or event handler, or a callback carries no data representation and must never reach the host as something callable. Handing one over would let the host invoke sandbox code outside any execution budget and outside the call that produced it. A function marshals to `null` at the top level and as an array element, and is omitted as an object property, exactly as JSON serialization renders the same shape. The only sanctioned way for the host to call into the sandbox is through a declared export (`invokeExport`) or a live callback, both of which run under the budget. [`marshal-out-tests.json`](./marshal-out-tests.json) is the shared corpus every runtime is held to.

**Failure mode:** If a script attempts to access something outside the sandbox (e.g., through a prototype chain exploit or a globalThis property not in the allowed set), the access must return `undefined` or throw a `TypeError`. It must never succeed silently.

**Callbacks widen the boundary in one direction, under the same guarantees:**

A script function passed to a binding reaches the host as a [callback](./bindings.md#callbacks), and the host may call back into the sandbox through it. That is a deliberate widening, and runtimes must hold it to these rules:

- **The host never receives the script's function itself.** It receives a proxy. Calling the proxy runs the script function inside the sandbox, with the same restricted globals, capability grants, and `this` of `undefined`. Nothing about the call gives the script a reference to the host.
- **Lifetime is the binding call.** The proxy is valid only while the binding call that received it is running, and only on the thread running it. Afterwards it fails as expired. No runtime retains a script function past the call, so a host cannot keep a handle into the sandbox alive, and a sandbox's teardown never waits on a host reference.
- **Re-entrancy is synchronous.** A callback runs on the sandbox's own thread, nested inside the binding call. It cannot suspend; an async binding refuses to start inside one, and a callback that returns a promise is refused.
- **Values cross by the data rules.** Arguments and return values are marshalled exactly as binding results and binding arguments are, so a callback opens no new path for host objects to enter the sandbox or for script objects to reach the host. In particular a callback that returns a function returns `null` to the host, by the outbound-function rule above.
- **A callback reference is unforgeable.** A runtime that bridges arguments through JSON (where a function cannot travel as itself) stands a marker in its place and resolves it on the host side. The marker is minted only by the runtime, for a function the script actually passed, and carries a random per-scope nonce; a value the script spells into plain data that merely looks like a marker resolves to nothing, just as the same data shape is inert in a runtime that passes functions directly. A script cannot name a callback it was not given, nor reach one from another binding call. [`callback-tests.json`](./callback-tests.json) is the shared corpus every runtime is held to.

### 2. No Denial of Service

Scripts cannot consume unbounded resources. The manifest's `limits` section declares the bounds, and the runtime enforces them.

**Execution time:**

Every script invocation has a maximum wall-clock duration. The default is 5000ms. When the timeout is reached, the runtime must terminate the script. Termination is immediate — the script does not get a grace period or a chance to clean up.

**Memory:**

Every script invocation has a maximum memory allocation. The default is 64 MB. When the limit is reached, the runtime must terminate the script. The memory limit covers the script's heap allocations, not the runtime's own overhead.

**Stack depth:**

Every script invocation has a maximum call stack depth. The default is 256 frames. When the limit is reached, the runtime must throw a `RangeError` (the standard JavaScript stack overflow error). Unlike timeout and memory violations, stack overflow is catchable — a script can catch the `RangeError` and continue operating within its remaining resource budget.

**Callbacks spend the caller's budget:**

A [callback](./bindings.md#callbacks) the host calls during a binding call runs against the budget of the script that made the binding call. It gets no fresh timeout. A callback that exhausts the budget is stopped like any runaway script, and the host cannot swallow the stop: even if the host catches the callback's failure, the binding call ends with the execution-limit error.

**Infinite loop protection:**

Runtimes must detect and terminate scripts that enter infinite loops or infinite recursion. The timeout limit is the primary mechanism for this, but runtimes may additionally instrument loops with iteration counters for faster detection.

**A script cannot crash the host process:**

A runtime whose sandbox shares the host's engine and process (the Node `vm` runtime shares V8 and the host's unhandled-rejection reporting) must keep a script's floating failures from reaching the host process. A rejected promise the script never settles (`Promise.reject(...)`, an un-awaited async body that throws, a bare `import(...)`) must be contained by the runtime, not surface as a process-level unhandled rejection that the host's default policy turns into an exit. Containment must be scoped to the runtime's own sandbox: a rejection originating in host code keeps the host's own policy. Runtimes that sandbox in a separate engine (QuickJS, Jint) contain floating rejections in that engine's job queue and never reach the host process.

**Failure modes by resource:**

| Resource | Limit Source | Failure | Catchable? |
|----------|-------------|---------|------------|
| Time | `limits.timeout_ms` | Script terminated | No |
| Memory | `limits.memory_mb` | Script terminated | No |
| Stack | `limits.max_stack_depth` | `RangeError` thrown | Yes |

Timeout and memory violations are not catchable because a script that has exhausted these resources cannot be trusted to handle errors correctly. Stack overflow is catchable because the stack unwinds naturally and the script may have legitimate recovery logic (e.g., switching from recursive to iterative algorithms).

### 3. No Implicit Trust

Scripts start with zero capabilities and can only call ungated bindings until capabilities are explicitly granted by the host. This guarantee is the enforcement side of the [capability model](./capabilities.md).

**Default-deny posture:**

When a script is loaded, it has access to ungated bindings only. The host must explicitly grant each capability the script needs. There is no "allow all" shortcut in the spec — if a host application wants to grant everything, it must enumerate every capability.

**Grant immutability:**

Once a script's capability set is determined at load time, it cannot change during execution. Scripts cannot request additional capabilities mid-run. The host cannot revoke capabilities from a running script (it can terminate the script entirely, but not selectively remove access).

**No transitive trust:**

Having capability A does not imply access to capability B, even if A and B are related. Each capability is independent and must be granted individually.

**No script-to-script trust:**

Scripts cannot grant capabilities to other scripts. Only the host makes grant decisions.

**Failure mode:** Calling a gated function without the required capability throws a `CapabilityDeniedError`. The function does not execute — not partially, not with reduced functionality. The error is catchable, and the script continues running with its existing capabilities.

### 4. No Eval

Scripts cannot dynamically generate and execute code. The `eval()` function, the `Function()` constructor, and any other mechanism for runtime code generation must be unavailable.

**What is prohibited:**

- `eval(string)`
- `new Function(string)`
- `setTimeout(string, ms)` and `setInterval(string, ms)` (the string overloads; callback overloads may be allowed if the runtime supports timers)
- `import()` (dynamic import expressions)
- Static `import` of any external specifier in a module-format entry (rejected at link time with `ImportDeniedError`)
- Any runtime-specific mechanism that converts strings to executable code
- The `Function` constructor reached any other way: `(function () {}).constructor`, the async, generator, and async-generator equivalents, and the `.constructor.constructor` of any object, array, or error, whether the script made it or a binding handed it over

Replacing the global `Function` is not enough on its own, because every function's prototype chain still leads to the real constructor. A runtime must also point the `constructor` of each function prototype at something that refuses, and must refuse with a `TypeError`.

A runtime whose sandbox shares the host's engine (the Node runtime's `vm` context) has a second obligation. The context's `codeGeneration` setting governs only the context's own `Function`; a host-realm value handed to a script is one `.constructor` away from the host's `Function`, which compiles anything and runs it with full host authority. Every value crossing host to sandbox there (binding results, thrown errors, promises, hook arguments, event payloads, export arguments, callback arguments, and every global the runtime installs, built-ins included) must be re-created in the context's realm: data copied into context-realm objects, errors and promises re-created as the context's own, and host functions wrapped in context-realm functions. `spec/escape-tests.json` is the shared corpus every runtime asserts.

**Why this matters:**

Dynamic code generation is the primary vector for code injection attacks in scripting environments. A script that can construct and execute arbitrary code can bypass every other security guarantee. Banning eval at the runtime level closes this vector entirely.

**What modders should use instead:**

- Data-driven dispatch: Use objects or maps to select behavior based on runtime values
- Higher-order functions: Pass functions as arguments rather than constructing them from strings
- Configuration objects: Express dynamic behavior through data structures, not code strings

**Failure mode:** Calling `eval()`, `new Function()`, or any prohibited code generation mechanism must throw a `TypeError` with a clear message indicating that dynamic code generation is not permitted. The error is catchable.

## Restricted Global Environment

The runtime must provide a restricted global environment that excludes dangerous APIs while preserving JavaScript's core functionality.

### Must Be Available

These are required for scripts to function as normal JavaScript:

- All primitive types and their prototypes (`String`, `Number`, `Boolean`, `Symbol`, `BigInt`)
- `Object`, `Array`, `Map`, `Set`, `WeakMap`, `WeakSet`
- `Promise`, `async`/`await` support
- `JSON.parse()`, `JSON.stringify()`
- `Math`, `Date` (read-only current time; whether `Date.now()` returns real time or simulated time is host-determined)
- `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`
- `RegExp`
- `console.log()`, `console.warn()`, `console.error()` (output routed to the host's mod console)
- Structured clone algorithm types (`ArrayBuffer`, `DataView`, typed arrays)
- `Proxy`, `Reflect` (scripts may use these on their own objects)
- `globalThis` (pointing to the restricted global, not the host's global)

### Must Be Unavailable

These must not be accessible to scripts:

- `eval`, `Function` constructor (covered by the no-eval guarantee)
- `import`, `require`, `importScripts` (no module loading)
- `fetch`, `XMLHttpRequest`, `WebSocket` (no network access unless provided by a binding)
- `setTimeout`, `setInterval`, `requestAnimationFrame` (no timers unless provided by a binding)
- `process`, `Deno`, `window`, `document`, `navigator` (no platform globals)
- `SharedArrayBuffer`, `Atomics` (no shared memory with host)
- `Worker`, `ServiceWorker` (no thread spawning)
- `__proto__` mutation (prototype chain must be frozen)

### Host-Determined

These may or may not be available depending on the host's security requirements:

- `structuredClone` (safe but some hosts may omit it)
- `TextEncoder`, `TextDecoder` (safe but adds surface area)
- `crypto.getRandomValues()` (safe for generating random data; `crypto.subtle` should be unavailable unless needed)
- `Intl` formatting APIs (safe but adds surface area)
- Iterator and generator support (safe, generally should be available)

## Trust Model

The xript trust model defines the relationships between the four actors in the system.

### Actors

| Actor | Description |
|-------|-------------|
| **Host application** | The software that embeds xript. It defines the manifest and runs the runtime. |
| **Runtime** | The JavaScript execution environment that enforces security guarantees. |
| **Script** | User-authored code that runs inside the runtime. |
| **User** | The person who decides which scripts to run and which capabilities to grant. |

### Trust Relationships

**The user trusts the host application.** By installing and running the application, the user extends trust to it. The host application is responsible for providing accurate manifests and a conformant runtime.

**The host application trusts the runtime.** The host delegates script execution to the runtime and trusts it to enforce the security guarantees. If the runtime is non-conformant, the host's security promises are void.

**Nobody trusts scripts by default.** Scripts are untrusted code from the user's perspective. The capability model exists precisely because scripts cannot be assumed safe. Users grant capabilities based on their own risk assessment, informed by the manifest's capability descriptions and risk levels.

**The runtime does not trust scripts.** The runtime enforces all guarantees regardless of which capabilities a script has been granted. A script with every capability is still sandboxed, still resource-limited, and still prohibited from eval.

### What Trust Does Not Flow Through

- A trusted script does not make other scripts trusted
- A capability grant does not imply trust in the script's intentions, only permission for specific operations
- The host application's trust in the runtime does not extend to scripts the runtime executes

## Conformance Checklist

Runtime implementors must verify their implementation against each item in this checklist. A conformant runtime passes all items.

### Sandbox Isolation

- [ ] Scripts cannot access host file system, network, or environment without explicit bindings
- [ ] Scripts cannot import or require external modules
- [ ] A module-format entry's `import` of any specifier (bare, absolute, URL, relative) is rejected at link time with `ImportDeniedError`
- [ ] A mod entry containing `require()`, `module.exports`, or `exports.x` is rejected at load time with `CommonJSDetectedError`, in both script and module mode
- [ ] Scripts cannot access other scripts' state
- [ ] Objects returned from bindings do not expose host internals through prototype traversal
- [ ] An own `__proto__` key in a binding's return value arrives as an own data property and does not reparent the object (`marshal-tests.json`)
- [ ] The global scope contains only language built-ins, declared bindings, and nothing else
- [ ] Accessing undefined globals returns `undefined` or throws `ReferenceError`, never host data
- [ ] A script function passed to a binding reaches the host only as a proxy, never as the function itself
- [ ] Calling that proxy after the binding call returns, or from another thread, fails as expired

### Resource Limits

- [ ] Scripts exceeding `timeout_ms` are terminated (not catchable)
- [ ] Scripts exceeding `memory_mb` are terminated (not catchable)
- [ ] Scripts exceeding `max_stack_depth` receive a `RangeError` (catchable)
- [ ] Infinite loops are terminated by the timeout mechanism
- [ ] A callback runs against the calling script's budget, and a budget stop inside it ends the binding call even if the host catches the failure
- [ ] Default limits (5000ms, 64MB, 256 stack frames) are applied when the manifest omits `limits`
- [ ] After termination, the runtime is in a clean state (no leaked resources, no corrupted host state)

### Capability Enforcement

- [ ] Scripts start with zero capabilities
- [ ] Calling a gated function without the capability throws `CapabilityDeniedError`
- [ ] The gated function does not partially execute on capability denial
- [ ] Capabilities cannot be added or removed during script execution
- [ ] Scripts cannot grant capabilities to themselves or other scripts

### Eval Prohibition

- [ ] `eval()` throws `TypeError`
- [ ] `new Function()` throws `TypeError`
- [ ] Every constructor chain in `spec/escape-tests.json` ends in a `TypeError`, including through values a binding returned or threw
- [ ] In a runtime that shares the host's engine, no host-realm object, array, function, error, or promise is reachable from a script
- [ ] `setTimeout(string)` throws `TypeError` or is unavailable
- [ ] `setInterval(string)` throws `TypeError` or is unavailable
- [ ] `import()` expressions are unavailable
- [ ] No other mechanism for string-to-code conversion exists

### Global Environment

- [ ] All "must be available" APIs are present and functional
- [ ] All "must be unavailable" APIs are absent or throw on access
- [ ] `__proto__` mutation is prevented
- [ ] `globalThis` points to the restricted global, not the host's
- [ ] Prototype chains of built-in objects are frozen or otherwise tamper-proof

### Error Handling

- [ ] Security violations produce clear, descriptive error messages
- [ ] Error messages do not leak host implementation details (no host stack traces, no internal paths)
- [ ] Catchable errors (`CapabilityDeniedError`, `TypeError` from eval, `RangeError` from stack overflow) allow the script to continue
- [ ] Non-catchable terminations (timeout, memory) fully stop the script with no further execution

## Relationship to Other Specifications

The security guarantees build on and complement the other xript spec documents:

- **[Manifest](./manifest.md)**: Declares `limits` that this document's resource guarantees enforce. Also declares capabilities that the trust model relies on.
- **[Capabilities](./capabilities.md)**: Defines the capability model that this document's "no implicit trust" guarantee enforces. The capability spec covers declaration and lifecycle; this document covers the security properties those mechanisms must provide.
- **[Bindings](./bindings.md)**: Defines how bindings behave at runtime, including the error types (`BindingError`, `CapabilityDeniedError`, `TypeError`, `ImportDeniedError`, `CommonJSDetectedError`) referenced throughout this document.
- **[Modules](./modules.md)**: Defines the `entry.format: "module"` evaluation mode, the no-external-imports rule, and the CommonJS guard this document references.
