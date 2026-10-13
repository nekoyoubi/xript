# Execution Limits and Interruption

This document states what bounds a running script, what xript can stop, and what it cannot. The short version: xript's limits bound **script execution**. Once control is inside a host binding, it belongs to the host, and nothing xript owns can take it back until the binding returns.

## Limits

A manifest's `limits` block sets the default budget for every call into the sandbox:

| Field | Bounds | Enforced by |
| --- | --- | --- |
| `timeout_ms` | wall-clock time of one call | the engine's interrupt mechanism (see below) |
| `memory_mb` | heap of the whole runtime | the engine's allocator limit |
| `max_stack_depth` | recursion of the whole runtime | the engine's stack limit |

The embedder may pass **hard limits** that clamp the manifest's: the effective value of each is the smaller of the two, so a manifest can never buy more than the application embedding the runtime allows. A slot may declare its own `limits.timeout_ms`, which replaces the manifest's for calls into that slot's fills and is clamped by the hard limit the same way (see [manifest.md](./manifest.md)). `memory_mb` and `max_stack_depth` are properties of a runtime at the moment it is created, so they have no per-call or per-slot form.

`limits` is enforcement. A manifest's `execution` block (`duration`, `affinity`) is advisory routing intent and enforces nothing; see [manifest.md](./manifest.md) and `execution-tests.json`.

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

Promise jobs belonging to one call can run while another is being driven, and count against the call being driven for that slice. Every budget stays bounded; attribution across interleaved calls is approximate.
