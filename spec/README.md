# xript Specification

The xript specification defines how applications expose functionality to scripts in a safe, consistent, and well-documented way.

## Contents

- [vision.md](./vision.md): the guiding vision for xript
- [manifest.md](./manifest.md): the manifest format specification
- [manifest.schema.json](./manifest.schema.json): the manifest JSON Schema
- [capabilities.md](./capabilities.md): the capability model
- [bindings.md](./bindings.md): binding conventions and type mapping
- [hooks.md](./hooks.md): hook conventions, lifecycle phases, and registration
- [execution.md](./execution.md): execution limits, what can and cannot be interrupted, host bindings, pool wedge detection, and Rust async mode
- [commands.md](./commands.md): the command slot kind (`application/x-xript-command`), bound arguments, resolution, and invocation
- [security.md](./security.md): security guarantees and conformance checklist
- [deprecations.md](./deprecations.md): the deprecation channel, every code it raises, and the deprecated APIs with what to use instead
- [fragments.md](./fragments.md): the fragment protocol (the semantics of fragment-format slots)
- [fragment-formats.md](./fragment-formats.md): fragment-format vocabularies, the prop-sink safety model, and the tree contract
- [expressions.md](./expressions.md): the xript Expression Grammar (XEG) behind `data-if`, `data-bind`, and `{{ }}` interpolation
- [mod-manifest.md](./mod-manifest.md): the mod manifest format (capabilities, entry, and the `fills` contribution surface)
- [mod-manifest.schema.json](./mod-manifest.schema.json): the mod manifest JSON Schema
- [sanitizer-tests.json](./sanitizer-tests.json): HTML sanitizer conformance test suite
- [command-tests.json](./command-tests.json): command slot conformance corpus (branch order, normalization, bound args, resolution)
- [expression-tests.json](./expression-tests.json): expression conformance corpus (evaluation, refused sources, interpolation, and the safety cases)
- [marshal-tests.json](./marshal-tests.json): host-to-sandbox marshalling conformance corpus (a host value's keys are data, an own `__proto__` included)
- [callback-tests.json](./callback-tests.json): callback conformance corpus (script functions passed into host bindings, call-scoped and retained)
- [deprecation-tests.json](./deprecation-tests.json): deprecation channel conformance corpus (the notice shape, once-per-runtime delivery, and `binding-shadows-builtin`)
- [event-bus-tests.json](./event-bus-tests.json): events bus conformance corpus (every bus verb, ownership, id resolution, and caller-aware bindings)
- [optional-binding-tests.json](./optional-binding-tests.json): optional binding conformance corpus (an omitted optional binding is `undefined`, the missing-bindings report, and the `xript.has` probe)
- [accessor-tests.json](./accessor-tests.json): accessor binding conformance corpus (a getter per read, a setter per write, read-only refusal, gating, and error marshalling)
- [value-fidelity-tests.json](./value-fidelity-tests.json): `undefined`, `NaN` and the infinities across the host boundary, in marker spelling, under value fidelity
- [key-order-tests.json](./key-order-tests.json): authored object key order across the host boundary and through a hook payload spread
- [hook-phase-tests.json](./hook-phase-tests.json): firing one phase of a phased hook (which handlers run, how `data` spreads, refused phases)
- [console-tests.json](./console-tests.json): sandbox `console` conformance corpus (no argument makes a console call throw, and how each argument reaches the handler as data or as text)
- [escape-tests.json](./escape-tests.json): code-generation conformance corpus (every `.constructor` chain a script can walk, through its own values and the host's, ends in a `TypeError`)
- [names-as-data-tests.json](./names-as-data-tests.json): every name a manifest, mod manifest, or host call carries reaches the sandbox as data (quotes, line breaks, crafted breakouts, and the names a plain object inherits)
- [isolation-tests.json](./isolation-tests.json): isolation between mods sharing a runtime (whatever a second mod rewrites, deletes, forges, or monkeypatches, the first mod's handlers, exports, bindings, and console behave exactly as before, and no runtime internal is visible to scripts)
- [host-events-tests.json](./host-events-tests.json): host events mode (a host-declared `events` binding reaches mods in place of the built-in bus and stays sealed, construction is refused without one, a manifest `events` catalogue is allowed beside it, the built-in bus's host API is refused, and nothing changes when the option is off)
- [fragment-applier-tests.json](./fragment-applier-tests.json): fragment op applier conformance table, run by a host through `runFragmentApplierConformance`
