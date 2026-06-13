# Authoring a mod against a host

A mod is a manifest plus the scripts it declares. The host's manifest tells you exactly what you can call and what you can fill. Read it first; do not guess.

## The loop

1. **Read the host's surface.** Get the host manifest and have it described: what bindings exist, what slots the host declares, what each slot `accepts`, and what capabilities gate them. This is the whole contract — there is nothing to call and nothing to fill that is not declared here.
2. **Declare the mod manifest.** Name the mod, declare the capabilities it requests, and declare its entry script and exports. Requested capabilities are explicit; default-deny means anything not requested is denied.
3. **Write the entry script.** Implement the exports the host will call: fragment event handlers, role functions, lifecycle handlers. Call host bindings. Keep logic here, in the sandbox — never in fragments.
4. **Fill the host's slots.** In the mod manifest's `fills`, key each entry by a host slot `id` and provide the fill the slot's `accepts` type calls for: a fragment into a fragment-format slot, a function map into a role slot, a handler export into an event slot. A fragment, a role, and a lifecycle handler are all just fills — pick the slot whose type matches.
5. **Validate.** Run the mod manifest through validation, and cross-validate it against the host manifest — requested capabilities must be grantable, and every slot you fill must exist in the host and not require a capability you don't hold. Validation checks that the slot exists and that you hold its gate; the host owns the inner shape of each fill.
6. **Run it.** Load the mod in a runtime and exercise its exports, its fills, and the events the host fires before shipping.

## Everything you contribute is a fill

There is one contribution surface: `fills`, keyed by host slot `id`. A panel of UI is a fill of a fragment-format slot. Satisfying a host role (a transcriber, a formatter, a provider) is a fill of a role slot. Reacting to startup or to a state change is a fill of an event slot. Don't reach for a separate `fragments` or `provides` or `hooks` field; the slot's `accepts` type already says what the fill must look like.

## Fragments carry no logic

A fragment is an inert template you fill into a fragment-format slot. Bind a value with `data-bind`. Toggle visibility with `data-if`. For anything else, events and mutations and computed content, route through the sandbox fragment API. A fragment that tries to branch or compute on its own is the most common authoring mistake; move that logic into the entry script.

## Capabilities are requested, not assumed

If a binding call or a gated slot needs a capability, the mod must request it in its manifest, and the host must be willing to grant it. Validation catches a fill into a gated slot the manifest never requested the capability for, and an export that uses a capability the manifest never requested. Request the narrowest set that makes the mod work.

## Keep types in the loop

Generate TypeScript definitions from the host manifest and author against them. The types describe the real surface: the bindings you can call and the slots you can fill. If a call or a fill does not typecheck, it is not something the host declares. This closes the gap between what an author assumes exists and what the manifest actually declares.
