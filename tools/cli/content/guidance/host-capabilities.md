# Hosting: granting capabilities

Capabilities are default-deny. A mod requests the ones it needs in its manifest; the host decides which to honor. **Granting is host policy; enforcement is runtime mechanism.** The runtime never grants on its own and never prompts — it enforces exactly the allow-list the host hands it.

## How a host grants

Pass the allow-list to the runtime: `createRuntime(manifest, { capabilities: ["clipboard.read", "net"] })`. That array is the complete set of capabilities this runtime honors. Omit it and the runtime grants nothing — a default-deny floor, not an oversight.

A mod's requested capabilities (from its manifest) are a *request*, not a grant. The host reads what the mod asks for, decides what it is willing to honor, and grants the intersection it chooses. Granting more than the mod requested is pointless; granting less than it requested means the mod's gated calls will fail loudly.

## What the runtime enforces

A binding gated by a capability the runtime was not granted throws `CapabilityDeniedError` when the mod calls it. A gated slot a mod fills without holding the gate fails [cross-validation](/guidance/authoring/) at load. The runtime is the only thing that checks; the host is the only thing that decides.

Every gated binding call is observable through the `audit` callback — see [limits, cancellation & audit](/guidance/host-safety/). Wire it if you want a record of which capabilities a mod actually exercised.

## Grant UX is host-side

The spec ships capability-grant *data shapes* only — `capability-prompt`, `install-descriptor`, `discovery-result` — and no prompt implementation. Whether to show a consent dialog, remember a decision, or grant silently from a trusted manifest is entirely the host's call. The runtime takes a finished allow-list; how the host arrived at it is out of scope. See the [security model](/spec/security/) and [capability reference](/spec/capabilities/).

## Common mistakes

- **Granting the union of everything every mod requests.** Grant the narrowest set you intend to honor. A blanket grant defeats default-deny.
- **Treating capabilities as mod-side enforcement.** The mod *declares* what it needs; the runtime *enforces*; the host *decides*. A mod cannot grant itself anything.
- **Expecting the runtime to prompt.** It will not. If a host wants consent UX, the host builds it and hands the runtime the resulting allow-list.
