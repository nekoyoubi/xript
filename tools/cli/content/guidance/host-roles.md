# Resolving roles

A role is a named set of functions a mod promises to provide — a transcriber, a formatter, a data provider. Cross-mod collaboration goes through roles, not hardcoded globals. The host resolves the active provider and calls its functions. **Declaring a role grants nothing; each named function stays gated by its own capability.**

## Resolving a provider

- `runtime.resolveRole(role)` returns the active `RoleResolution`, or `null` when no mod provides it.
- `runtime.resolveRoleAll(role)` returns every provider, for when the host wants to fan out rather than pick one.

A `RoleResolution` is `{ addon, role, fns }`, where `fns` maps each role-function name to the provider mod's export name. The host calls them through `runtime.invokeExport(fns[name], args)` — it never assumes a global of that name exists.

## Picking among providers

When more than one mod provides a role, the host chooses. Set `rolePreferences` on `createRuntime` (`{ "transcriber": "my-whisper-addon" }`) to prefer a named provider per role; `resolveRole` honors it, falling back to the highest-priority provider otherwise. Use `resolveRoleAll` when every provider should run.

## Roles grant nothing on their own

Providing a role is not a capability. A role function that reaches a gated binding still needs that capability granted to its mod ([granting capabilities](/guidance/host-capabilities/)). Resolving a role tells the host *who* provides it and *what to call*; it never widens what those functions may do.

## Roles across isolated runtimes

Some hosts load every mod into one shared runtime; others give each mod its own runtime for per-mod grant isolation. Both postures are fully supported, and in the isolated case, **the host implements role resolution itself, natively, over its own mod registry.** That is canon, not a workaround.

A role is defined by its fill contract, the `{ addon, role, fns }` resolution plus invoke-by-name through the provider's own runtime handle, not by which code path performs the selection. `resolveRole` / `resolveRoleAll` / `rolePreferences` are *semantics*; the single-shared-runtime methods are one implementation of them. A host with per-mod runtimes reproduces the same semantics host-side: iterate the loaded mods, match the role's fills, apply the preference policy, and call the chosen provider's exports via `invokeExport` on *that mod's* handle. Every invariant survives: the typed fill, the `fns` map, invoke-by-name, and per-function capability gating (each provider's functions stay gated by its own grants).

Do not collapse per-mod isolation into one shared runtime just to call `runtime.resolveRole` literally. That trades a real security property for spec-literalism. High isolation is the stronger posture, and roles work there by design.

## Common mistakes

- **Assuming a provider exists.** `resolveRole` returns `null` when nothing provides the role. Handle absence; do not call into a null resolution.
- **Calling role functions by their role name.** Call the *export* name from `fns`, through `invokeExport`. The role name is a label, not a global.
- **Treating a role as a grant.** A provider's functions are still gated by the capabilities its mod was granted.
