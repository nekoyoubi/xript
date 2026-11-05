# Deprecations

Every runtime reports deprecated usage through one channel, and every deprecated API carries its language's own marker. This page lists both: the codes the channel raises at runtime, and the APIs a compiler or editor will flag.

## The deprecation channel

A host passes a handler to receive notices:

| Runtime | Option | Notice |
|---------|--------|--------|
| `@xriptjs/runtime`, `@xriptjs/runtime-node` | `onDeprecation(notice)` in the runtime options | `{ code, message, replacement }` |
| `xript-runtime` (Rust) | `RuntimeOptions::on_deprecation: Option<DeprecationSink>` | `Deprecation { code, message, replacement }` |
| `Xript.Runtime` (C#) | `RuntimeOptions.OnDeprecation : Action<Deprecation>?` | `Deprecation(Code, Message, Replacement)` |

All three fields are strings: `code` is one of the codes below, `message` says what happened, and `replacement` says what to do instead. A runtime raises each code at most once, whether or not a handler is set. With no handler it writes the notice once as a warning: `console.warn` in JS and Node, standard error in Rust and C#, formatted `xript: {message} ({code}). {replacement}`. A handler that throws never changes what the runtime does. `spec/deprecation-tests.json` pins the notice shape and the once-per-runtime rule in every runtime.

A deprecation notice never changes behavior. It reports a pattern that works today and is not the supported way to do it.

## Codes

| Code | Raised when | What to do instead | Added |
|------|-------------|--------------------|-------|
| `binding-shadows-builtin` | At construction, when the runtime installs its own `events`, `hooks`, or `xript` global over a top-level host binding of the same name, so mods never see the host's binding. One notice names every replaced binding, in the order events, hooks, xript. A binding named `console` wins over the runtime's console and raises nothing. | Rename the binding or move it under a namespace. A host that wanted an events binding declares its events in the manifest's `events` and lets mods use the bus; a host that runs its own bus keeps the binding and opts into [host events mode](./hooks.md#a-hosts-own-bus), under which nothing is replaced and no notice is raised. See [Built-in Globals](./bindings.md#built-in-globals). | 0.10 |
| `unbudgeted-handler` | The first time one hook or event handler runs longer than the script timeout while handlers run without a budget. Raised only by runtimes whose handlers are unbudgeted by default (JS and Node). | Create the runtime with `budgetHandlers: true`, so every hook and event fire runs under the script timeout, a fresh budget per fire; and keep handlers short. See [Execution Limits](./hooks.md#execution-limits). | 0.10 |

## Deprecated APIs

These are still accepted and still populated, and each carries the runtime's own marker: `@deprecated` in TypeScript, `#[deprecated]` in Rust, `[Obsolete]` in C#.

| API | Runtimes | Use instead | Why |
|-----|----------|-------------|-----|
| A fragment fill's `events` array (`FragmentDeclaration.events`, `Events`) | all | `handlers` | renamed; `handlers` wins when both are present |
| `FragmentEventDeclaration`, `FragmentEvent` (type aliases) | JS, Node | `FragmentHandlerDeclaration`, `FragmentHandler` | renamed with the fill field |
| `getEvents()` on a fragment instance | all | `getHandlers()` | renamed with the fill field |
| `visibility` on a fragment result and a bound tree | all | `conditions` | keyed by `data-if` expression text, so two nodes with the same condition collide |
| `sanitizedSource` on a fragment instance | JS, Node, C# | `sanitizedTree` | an HTML projection, empty for a host-declared vocabulary |
| `attr` on a fragment op | JS, Node, C# | `prop` | an alias populated only for `setAttr` and `removeAttr` |
| `processFragment` (the legacy string bind pass) | JS, Node | a fragment instance's `getContent()` | no longer on any render path, and blind to interpolation |

## Building Rust manifest structs

The Rust manifest structs have public fields, and 0.10 added fields to several of them, so a host that builds one with a struct literal stops compiling whenever a field is added. Build them with their constructors instead: `new` takes the required fields and `with_*` setters take the rest, so a field added later never breaks the call.

| Struct | Constructor | Setters |
|--------|-------------|---------|
| `Parameter` | `new(name, ty)` | `with_description`, `with_default`, `with_required`, `with_optional`, `with_variadic`, `with_retain` |
| `FieldDefinition` | `new(ty)` | `with_description`, `with_optional`, `with_default`, `with_enum`, `with_retain` |
| `Limits` | `new()` or `Default` | `with_timeout_ms`, `with_memory_mb`, `with_max_stack_depth`, `with_max_retained_callbacks` |
| `FunctionBinding` | `new(description)` | `with_params`, `with_param`, `with_returns`, `with_async`, `with_capability`, `with_deprecated`, `with_execution`, `with_optional` |
| `NamespaceBinding` | `new(description)` | `with_member`, `with_members`, `with_optional` |
| `EventDefinition` | `new(id)` | `with_description`, `with_payload`, `with_capability`, `with_emit`, `with_pattern`, `with_addressed`, `with_keys` |

Struct literals still compile today. The constructors are the path that keeps compiling.
