# Hosting: limits, cancellation & audit

A host runs untrusted code. The runtime gives it the caps to bound that code and the signals to watch it. **The runtime provides the mechanism; the host sets the policy** — what the limits are, when to cancel, what to do with an audit trail.

## Hard limits

Set `hardLimits` on `createRuntime`:

- `timeout_ms` — wall-clock ceiling for a single execution.
- `memory_mb` — sandbox memory ceiling.
- `max_stack_depth` — recursion ceiling.

Exceeding any of them throws `ExecutionLimitError`. Run without a timeout and a mod can hang the host; set one. Limits are per runtime, enforced by the runtime — the host does not police them by hand.

## Cooperative cancellation

Pass a `CancellationToken` as `cancellation`. Call `token.cancel()` to request a stop; long-running sandbox work observes the flag and throws `CancellationError`. Cancellation is *cooperative*, not preemptive — it unwinds at the runtime's check points, not instantly. Some engines require the async sandbox (`initXriptAsync`) for cancellation to bite mid-execution; see the [runtime overview](/runtimes/overview/) for per-engine fidelity.

## Audit

Pass an `audit` callback: `(event: AuditEvent) => void`. The runtime fires it on every gated binding call, with `{ binding, capability, at }` — which binding ran, which capability gated it, and when. Wire it to the host's logging to keep a record of what a mod actually exercised. Pair it with [granting capabilities](/guidance/host-capabilities/): grants are what you *allowed*, audit is what was *used*.

## Console

Route sandbox console output through the `console` handler — `log`, `info`, `warn`, `error`, `debug`, `trace`, or a single `onLog(severity, ...args)`. Without it, a mod's console output goes nowhere.

## Common mistakes

- **No timeout.** A mod with an infinite loop hangs the host. Always set `timeout_ms`.
- **Assuming cancellation is preemptive.** It is cooperative; it unwinds at check points. For mid-execution cancellation on some engines, use the async sandbox.
- **Ignoring the audit channel.** Without it you have grants but no record of use — half the security story.
