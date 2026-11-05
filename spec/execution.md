# Execution Limits and Interruption

This document states what bounds a running script, what xript can stop, and what it cannot. The short version: xript's limits bound **script execution**. Once control is inside a host binding, it belongs to the host, and nothing xript owns can take it back until the binding returns.

## Limits

A manifest's `limits` block sets the default budget for every call into the sandbox:

| Field | Bounds | Enforced by |
| --- | --- | --- |
| `timeout_ms` | wall-clock time of one call | the engine's interrupt mechanism (see below) |
| `memory_mb` | heap of the whole runtime | the engine's allocator limit |
| `max_stack_depth` | recursion of the whole runtime | the engine's stack limit |
| `max_retained_callbacks` | retained callbacks held by the whole runtime | the runtime, refusing a retain beyond it |

A retained callback the host calls between script calls gets a fresh `timeout_ms` budget of its own, like an export invocation; one it calls from inside a binding call spends that script call's budget (see [Retained callbacks](./bindings.md#retained-callbacks)).

The embedder may pass **hard limits** that clamp the manifest's: the effective value of each is the smaller of the two, so a manifest can never buy more than the application embedding the runtime allows. A slot may declare its own `limits.timeout_ms`, which replaces the manifest's for calls into that slot's fills and is clamped by the hard limit the same way (see [manifest.md](./manifest.md)). `memory_mb` and `max_stack_depth` are properties of a runtime at the moment it is created, so they have no per-call or per-slot form.

`limits` is enforcement. A manifest's `execution` block (`duration`, `affinity`) is advisory routing intent and enforces nothing; see [manifest.md](./manifest.md) and `execution-tests.json`.

## `execute` and `executeAsync`

`execute` runs a script synchronously, and its result is the script's completion value. `executeAsync` (`execute_async` and `execute_within_async` in Rust) runs its source as the body of an async function: `return` gives the result, `await` works at the top level, and a body that returns nothing yields `undefined`. A script that awaits an async binding belongs in `executeAsync`.

A synchronous `execute` whose script ends in a promise has nothing settled to hand over, and the runtimes treat it differently:

| Runtime | `execute` ending in a promise |
| --- | --- |
| JS/WASM (`@xriptjs/runtime`, both QuickJS builds) | refused: `execute` throws an error pointing at `executeAsync` |
| Node.js (`@xriptjs/runtime-node`) | the host receives a promise that settles to the copied value |
| Rust (`xript-runtime`) | awaited: the call drives the promise to completion, the way `RuntimeMode::Sync` drives an async host binding with `pollster::block_on`, and returns what it settles to |
| C# (`Xript.Runtime`) | settled in line: Jint drains its job queue before `Execute` (and `InvokeExport`) returns, so a fulfilled promise crosses as its value, a rejected one fails the call with the rejection, and one still pending fails with an error saying C# runs scripts synchronously and cannot await |

Invoking a mod's export follows the same rules. The async invocation awaits a promise the export returns, and the async bindings an export reaches hand it real promises, in every runtime that has one. The universal runtime's synchronous invocation (`invokeExport`, `invokeModExport`, `invokeCommand`) refuses an export that ends in a promise, pointing at the async invocation, and refuses an async binding the export reaches, as `execute` does; firing a hook whose fill is an export is unaffected, and a promise a hook handler returns still reaches the host as `{}`.

The refusal is a JavaScript-runtime rule only. The universal runtime also refuses an async binding called during `execute`: the call throws a `BindingError` naming the binding in the script, the host binding is not called, and the runtime stays usable for the next call (see [bindings.md](./bindings.md#async-bindings)). `spec/async-tests.json` pins both, the async function body, and export invocation in both forms.

## Re-entering a running runtime

A host binding may call back into the runtime that is running it: `execute`, `executeAsync`, `invokeExport`, `invokeModExport`, `fireHook`, and `emit` (and their Rust and C# equivalents) all re-enter. The inner call runs to completion before the binding gets control back, sharing the outer call's globals. Its result comes back to the binding, and a failure it raises is the binding's to handle or let escape, in which case the script sees it as that binding's failure and can catch it. An inner call runs under its own budget, inside the outer call's: an inner fire stopped by its hook's own `timeout_ms` fails the binding and leaves the outer call running, while the outer call's deadline still governs everything nested inside it. Caller identity follows the inner call: an export reports its own mod, an inner host script reports none, and the outer frame's caller is back once the inner call returns. Re-entry also works from a retained callback's binding, and from inside a nested re-entry. No entry point hangs or refuses. `spec/reentrancy-tests.json` pins it.

A synchronous binding cannot wait for `executeAsync`. The JavaScript runtimes run the async body up to its first `await` before handing the promise back, which the host settles later. Rust drives an async entry point re-entered this way to completion in place, and an async binding that an inner call awaits on an async-mode runtime settles in place too, as on a sync-mode runtime, because the outer call cannot yield to the executor while it sits inside the binding.

## Stack exhaustion

A script that recurses too deeply gets an error it can catch, and the runtime stays usable afterwards: plain recursion, recursion through the engine's own built-ins (a getter, `toString`, `toJSON`), recursive descent over deeply nested data, and the built-ins that recurse on nested data themselves (`JSON.stringify`, `JSON.parse`, converting a nested array to a string, `flat`, a chain of proxies or bound functions). Which of those succeed and at what depth differs between engines; that they never take down the engine, the host process, or a later call does not. `spec/stack-tests.json` pins it.

The universal runtime needs two measures for this. QuickJS measures its stack in WebAssembly linear memory, while its built-ins that recurse in C spend far more of the host engine's own stack per level than that measure sees, so under the QuickJS default limit a script could exhaust the host's stack before QuickJS noticed and leave the engine unusable. The runtime therefore sets QuickJS's stack limit to 128 KiB in the synchronous build and 64 KiB in the asyncify build, whose instrumented functions spend more host stack per level once the host engine's optimizing compiler takes them over (a tighter `max_stack_depth`, in KiB, still applies; a looser one is capped there). `JSON.stringify` and `JSON.parse`, whose descent QuickJS's measure barely sees, refuse nesting deeper than 1000 levels with the engine's own catchable stack-overflow error. If the host itself calls into the runtime with almost no stack left, the engine can still run out underneath the call; the runtime then refuses that call and every later one with `EngineStackExhaustedError`, and `dispose()` releases nothing it would have to walk, so no other runtime is affected. Calling from a shallower host stack avoids it.

On Node.js 20, the asyncify build cannot meet this. Once V8 11.3's optimizing compiler takes over the instrumented engine, each level of script recursion costs about 40 KB of host stack, so about 20 levels exhaust V8's default stack and the runtime retires with `EngineStackExhaustedError`; the host is never harmed. The synchronous build and `@xriptjs/runtime-node` are unaffected, and Node.js 22 and later meet it in both builds.

## What can be interrupted

Every engine stops a script only at points where it is running script code:

| Runtime | Mechanism | Reaches |
| --- | --- | --- |
| JS/WASM (`@xriptjs/runtime`) | QuickJS interrupt handler, polled while bytecode runs | running bytecode |
| Node.js (`@xriptjs/runtime-node`) | the `vm` module's `timeout` | the synchronous part of a run; time spent awaiting a host promise is not counted |
| Rust (`xript-runtime`) | QuickJS interrupt handler (rquickjs) | running bytecode; in async mode, also a call parked on an async host binding (see below) |
| C# (`Xript.Runtime`) | Jint constraints (timeout, memory, recursion, cancellation) | running script statements |

A timeout surfaces as the runtime's execution-limit error naming `timeout_ms`. Host-driven **cancellation** (a cancellation token on the runtime options, and in Rust a per-call token on each handle call) reuses the same mechanism and surfaces as a distinct cancellation error, never as a timeout. Cancellation is sticky and idempotent: a fresh call on a cancelled runtime token fails immediately.

## What cannot be interrupted: host bindings

A host binding is host code. While a call is inside one:

- the interrupt mechanism does not fire, so neither `timeout_ms` nor cancellation is observed until the binding returns;
- a Rust handle's drop-cancel and `kill()` do not reach it;
- no runtime can safely kill the thread, because the host code holding it may own locks, files, or other state.

This is a property of every engine, not a gap in one. `limits` is therefore declarable on a slot and on a hook, never on a binding: a binding's budget is the host's to bound, by timing out its own I/O or by routing long work elsewhere.

On a synchronous runtime this includes **async** host bindings in the engines that settle them in line: Rust's default `RuntimeMode::Sync` drives the host future to completion on the interpreter thread, and C# host functions are synchronous. See the per-runtime table in [bindings.md](./bindings.md#async-bindings).

## Waiting is not stopping

Bounding how long a caller waits is different from bounding the call. A Rust `Pending::wait_timeout` that expires reports `Timeout { still_running: true }`: the caller stopped waiting, and the call may still be running. Likewise a handle's `shutdown()` drains the queue and stops the runtime thread only once it is free, and `kill()` sheds the queue and cancels what it can; when the thread is inside a host binding, each reports what it achieved (`ShutdownReport`) rather than claiming a clean teardown.

## Wedge detection in a pool

A Rust `XriptPool` tells a slow call from a wedged one with two signals, both required:

1. an in-flight call older than its threshold (longer for a call whose declared `execution.duration` is `unbounded`);
2. a stalled **heartbeat**. The heartbeat is bumped by the interrupt handler, which runs only while bytecode runs, so a script legitimately grinding for minutes keeps it moving and is never marked wedged.

A worker meeting both is marked unhealthy, leaves routing, and has its queued calls answered with `WorkerWedged` by the pool itself, naming the binding the thread is inside. Retiring it abandons the thread rather than killing it, and the shutdown report says so.

## Async mode (Rust)

`RuntimeMode::Async` changes what a call awaiting an async host binding is. Its host future runs on the runtime's own executor and the script holds a pending promise, so the call is **parked**, not blocked: it holds neither the interpreter nor the thread, and other calls on the same runtime run meanwhile. Because nothing is stuck in host code:

- `timeout_ms` bounds the whole call, time spent awaiting included;
- the runtime's cancellation token, a handle's per-call token, and dropping an in-flight call all reach a parked call, observed within a few milliseconds;
- a pool does not count a parked call as wedged. A yielding worker is wedged only when its thread is inside a **sync** binding, which still runs in line and still cannot be interrupted.

Promise jobs belonging to one call can run while another is being driven. Each call has a caller lane of its own, and the interrupt handler applies only the budget of the lane whose work is running, so a continuation is charged to the call it belongs to: a slow call keeps running under its own deadline even inside another call's poll, and another call's tighter deadline never stops it. The same lane credits the work to the right mod (see [Caller Identity](./bindings.md#caller-identity)). `timeout_ms` is still wall-clock, so a call that is ready to continue while the thread is busy with another call's bytecode keeps spending its own time while it waits; that is waiting, not being charged for the other call's work. Work in the lane of a call that has already finished, a continuation that outlived it, runs under the budget of whichever call is being driven, so nothing runs unbudgeted.
