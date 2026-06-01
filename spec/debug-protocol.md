# Runtime Debug Protocol

xript runtimes expose a host-driven step/breakpoint/inspect surface using Debug Adapter Protocol (DAP) vocabulary. The shape is identical across all four runtimes; naming is idiomatic per language but field names and semantics are the same everywhere.

xript provides the **mechanism** — pause, resume, and inspect. It does **not** own a transport, a debug UI, or a wire socket. The host wires these struct-shaped messages to its own debugger UI (e.g. Monaco). There is no socket in xript; events flow through a host-registered callback sink.

## Single Logical Thread

xript scripts are single-threaded per execution, so `threadId` is the constant `1` everywhere. It is present in every message for DAP conformance and forward compatibility with multi-context hosts.

## Attaching

Debug is an optional, default-off field on the runtime options (`debug` / `debug` / `Debug`), mirroring the audit channel: zero overhead when absent, and a production (no-debug) execution is byte-identical to today's behavior. When set, the host obtains a `DebugSession` handle from the runtime (`debug_session()` / `debugSession()` / `DebugSession`) and drives the verbs below.

The session is gated host-side. A host should not attach a debugger to untrusted production scripts — but xript imposes no capability for it; it is purely a `RuntimeOptions` toggle.

## Structs

| Struct | Fields |
|--------|--------|
| `SourceBreakpoint` | `line` (1-based int), `column?` (1-based int), `condition?` (string) |
| `Breakpoint` | `id` (int), `verified` (bool), `line` (int), `column?` (int), `source` (string — script id/path) |
| `StackFrame` | `id` (int), `name` (string), `line` (1-based int), `column` (1-based int), `source` (string) |
| `Scope` | `name` (`"Local"` \| `"Closure"` \| `"Global"`), `variablesReference` (int), `expensive` (bool) |
| `Variable` | `name` (string), `value` (string — display), `type?` (string), `variablesReference` (int — `0` = leaf, `>0` = expandable) |
| `StoppedEvent` | `reason` (`breakpoint` \| `step` \| `pause` \| `entry` \| `exception`), `threadId` (int, `=1`), `hitBreakpointIds?` (int[]), `description?` (string) |

All integer fields are `i64` / `number` / `long` per language. The structs serialize to DAP-shaped JSON; `spec/debug-messages.schema.json` is the canonical JSON Schema for hosts validating a DAP bridge.

## Verbs

Host-driven methods on the `DebugSession` handle. Names are identical, casing idiomatic per language.

| Verb | Signature | Notes |
|------|-----------|-------|
| `setBreakpoints` | `(source: string, breakpoints: SourceBreakpoint[]) -> Breakpoint[]` | Clears and replaces all breakpoints for `source`. `verified=false` when a line can't bind. |
| `clearBreakpoints` | `(source: string) -> void` | Removes all breakpoints for `source`. |
| `pause` | `() -> void` | Request a stop at the next checkpoint. |
| `continue` / `resume` | `() -> void` | Resume execution. |
| `stepIn` | `() -> void` | |
| `stepOver` | `() -> void` | |
| `stepOut` | `() -> void` | |
| `stackTrace` | `() -> StackFrame[]` | Innermost frame first. Valid only while paused. |
| `scopes` | `(frameId: int) -> Scope[]` | |
| `variables` | `(variablesReference: int) -> Variable[]` | |
| `evaluate` | `(expression: string, frameId?: int) -> Variable` | Optional, inspect-only. Uniformly reports `unsupported` where a runtime can't honor it. |

## Events

Runtime → host, via a host-registered callback sink set on the session. **No socket or transport in xript.**

- `stopped` — carries a `StoppedEvent`.
- `continued` — carries `threadId`.
- `terminated`.
- `breakpointChanged` — carries a `Breakpoint`.

## variablesReference Handle Protocol

`variablesReference` is a runtime-assigned, monotonic integer handle into a per-pause object registry. It is reset on resume. `variables(ref)` returns the children of the object behind `ref`. A leaf value has `variablesReference: 0`. The handle protocol is identical across all four runtimes.

## Deadline Clock Suspension

While stopped at a breakpoint, the deadline/timeout clock **must be suspended** on every runtime that folds the debug check into its deadline checkpoint, or a paused script would trip the timeout. The clock-suspension path is reachable only when a `DebugSession` is attached, so production (no-debug) executions are unaffected and cannot use it to evade cancellation or timeout.

## Mechanism per Runtime

The protocol shape is byte-identical regardless of which mechanism realizes it. The implementations differ:

- **Rust (`rquickjs`)** — extends the existing `set_interrupt_handler` closure (which already checks cancellation and deadline) with a third branch: on a breakpoint match at the current source position or a pending step, it blocks the calling thread on a condvar until the host issues a resume verb. While blocked, `stackTrace` / `scopes` / `variables` read frame state through rquickjs.
- **JS (QuickJS-WASM)** — same shape via `setInterruptHandler`, but WASM is single-threaded and cannot block synchronously. Debug therefore requires the **async sandbox** (`createSandboxAsync` / `newAsyncContext`) with an async await-gate that the host's resume verb unblocks on the JS event loop. `createSandboxSync` throws a clear "debug requires async runtime" error if `debug` is set.
- **Node (`vm`)** — has no native stepping. The runtime instruments the source before `new vm.Script`, injecting `globalThis.__xript_dbg(line, col)` probe calls at statement boundaries; the probe is a host-bridged function that consults breakpoint/step state and blocks. Stack frames, scopes, and variables are reconstructed from the instrumentation's tracked frame stack and a captured locals snapshot. This is the heaviest implementation; debug is flagged `instrumented` so the host knows fidelity differs (variables may be snapshot-based, `evaluate` may be limited). The vm timeout is suspended/extended while stopped.
- **C# (Jint 4.x)** — most native of the four: `cfg.DebugMode()` plus `DebugHandler` `Break`/`Step` events; Jint's `CallStack` maps to `StackFrame[]`, its scope chain to `Scope[]` / `Variable[]`, and its breakpoints to `setBreakpoints`.

### Fidelity

| Runtime | Mechanism | Fidelity |
|---------|-----------|----------|
| Rust | rquickjs interrupt handler + condvar | native |
| JS | QuickJS-WASM async await-gate (async sandbox only) | native (async only) |
| Node | source instrumentation | instrumented (snapshot-based) |
| C# | Jint `DebugMode` + `DebugHandler` | native |
