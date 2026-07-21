# Hosting xript in an application

A host embeds a runtime, loads mods through it, and drives what they contribute. The split is the whole job: **the host provides primitives and decides policy; the runtime owns the sandbox, capability enforcement, sanitization, and resolution.** Mods are loaded *through* the runtime, never reached around it. This record is the umbrella; each hosting concept below has its own.

## The host / runtime split

- **The host provides** the bindings a mod may call, the grant decision (which capabilities are honored), the places contributions mount, and the fragment vocabularies its renderers speak. It renders inert output and routes interaction back into the sandbox.
- **The runtime owns** the sandbox, default-deny capability enforcement, fragment sanitization, hook firing, and slot/role resolution. It is the only thing that executes mod code.

Sanitization is the pair worth reading twice. The runtime *runs* it; the host *declares what it means*. xript cannot know that a `Link.href` eventually navigates and a `Panel.maxHealth` never does, so the host says so in its `formats` block and the runtime enforces it generically. See [declaring a fragment format](/guidance/host-formats/).

The boundary is one-directional: a host drives the runtime and consumes what it returns. It never imports the runtime's internals to do the runtime's job. If a host finds itself wanting to, it is hosting the wrong unit (see [rendering fragments](/guidance/host-fragments/) for the canonical case).

## The lifecycle

1. **Initialize the factory.** `const xript = await initXript()` (or `initXriptAsync()`). The runtime factory is the only import a host needs from `@xriptjs/runtime`.
2. **Create a runtime per app manifest.** `xript.createRuntime(manifest, options)`.
3. **Load mods into it.** `runtime.loadMod(modManifest, { fragmentSources })` for each mod, returning a `ModInstance`.
4. **Drive it.** `invokeExport`, `fireHook`, `fireFragmentHook`, `resolveSlot`, `resolveRole` — the verbs each concept record covers.
5. **Dispose.** `runtime.dispose()` tears down the sandbox. A runtime is per app manifest; create one, load many mods, dispose when done.

## RuntimeOptions at a glance

`createRuntime(manifest, options)` takes:

- `hostBindings` — the functions and namespaces mods may call. The mod-to-host direction.
- `capabilities?` — the allow-list of capabilities this runtime grants. Default-deny: omitted means nothing. See [granting capabilities](/guidance/host-capabilities/).
- `console?` — where sandbox console output is routed.
- `onFragmentDiagnostic?` — a callback fired for every node, prop, or op the fragment sanitizer drops, cleans, or refuses. See [declaring a fragment format](/guidance/host-formats/).
- `strictHtmlVocabulary?` — promotes an undeclared node in an HTML fragment from a warning to a load error. Off by default; HTML is an open language.
- `audit?` — a callback fired on every gated binding call. See [limits, cancellation & audit](/guidance/host-safety/).
- `hardLimits?` — `timeout_ms`, `memory_mb`, `max_stack_depth`. The runtime enforces them.
- `cancellation?` — a `CancellationToken` for cooperative cancellation.
- `rolePreferences?` — preferred provider addon per role. See [resolving roles](/guidance/host-roles/).
- `debug?` — debug-protocol options.

## The host-side records

- [Rendering fragments](/guidance/host-fragments/) — the inert-output seam, and why you never call the processor directly.
- [Declaring a fragment format](/guidance/host-formats/) — the node vocabulary your renderer speaks, and the sink model that decides what gets sanitized.
- [Granting capabilities](/guidance/host-capabilities/) — default-deny, what granting means, and why the grant decision is the host's.
- [Mounting slots](/guidance/host-slots/) — `resolveSlot`, the `SlotContribution` shape, and honoring `priority` and `multiple`.
- [Resolving roles](/guidance/host-roles/) — `resolveRole`, the `RoleResolution` shape, and picking among providers.
- [Firing hooks & events](/guidance/host-hooks/) — `fireHook`, event-typed slots, and how they differ from the `events` catalog.
- [Offering commands](/guidance/host-commands/) — command slots, `resolveCommands` / `invokeCommand`, bound arguments, and where per-action authority lives.
- [Limits, cancellation & audit](/guidance/host-safety/) — the caps the runtime enforces and the signals it hands back.
