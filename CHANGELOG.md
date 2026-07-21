# Changelog

## v0.8.0 — Nameless

The fragment protocol had always been documented as format-agnostic while every runtime collapsed a
fragment to an HTML string before the host saw it; v0.8.0 makes that true.
A host declares which formats it intakes and which vocabularies each one speaks, the runtime returns
a validated tree instead of a flattened string, and an unregistered format is a hard error rather
than a silent pass. Arbitrary JSML vocabularies are first-class, so a PascalCase component node
arrives intact instead of being lowercased and dropped against an HTML allowlist.

Under that pillar runs a long security and correctness pass, where most of the work and nearly all
of the new tests went. A real sandbox escape closed: a `data-if` expression had been evaluated as
host JavaScript outside QuickJS. The three expression sites were unified under one grammar, XEG,
held to a single shared corpus across all five evaluators. The HTML sanitizer was rebuilt on a
shared allow-list port with its mXSS and content-loss holes closed, and a URI scheme allow-list now
refuses `javascript:` and `vbscript:` outright. `@xriptjs/runtime` stopped shipping wasm nobody
runs, cutting its install from 9.32 MiB to 1.52 MiB by depending on `quickjs-emscripten-core` and
loading only the variant a host selects. The suite grew from 1612 tests to 5106, almost entirely
corpus-driven.

- **Fragment formats become real.** This cycle's pillar. The fragment protocol documented itself
  as format-agnostic and was not: every runtime collapsed a fragment to an HTML string, and an
  unrecognized format silently fell through to `sanitizeHTML()` instead of erroring, so a non-HTML
  format worked only by bypassing the runtime entirely.
  - **A format registry.** A host declares which fragment formats it will intake and
    what vocabulary each one accepts; the runtime hands back a validated tree rather than a
    flattened string. An unregistered format becomes a hard error, not a silent HTML pass.
  - **Arbitrary JSML vocabularies.** JSML was never an HTML format. It represents any markup,
    it is case-sensitive, and its tag namespace is open; a component-shaped node has always been
    legal. xript is what narrowed it, in four places, all of them silent: node names are
    lowercased (so a PascalCase component name is destroyed on arrival), anything outside the HTML
    element allowlist is dropped rather than rejected (so an unknown node _vanishes_ with no
    diagnostic), attribute names are lowercased and filtered against an HTML attribute allowlist
    (so a camelCase prop dies the same quiet death), and every value is stringified into an HTML
    attribute (so a node can never receive a number, an array, or an object). Make all four
    vocabulary-driven instead of hardcoded, and a host can declare the node set it speaks.
  - **Vocabularies are declared once and scoped into formats.** A fragment format used to
    weld its authoring syntax to its node vocabulary, so neither could vary without the other:
    a component set authored as HTML could not also be offered as J5ML, and a second format
    wanting the same nodes had to restate them. A new top-level `vocabularies` block declares
    reusable node vocabularies, and a format names its syntax plus the ordered list of
    vocabularies in scope.
    - `html` is now a built-in vocabulary referenced like any other, which removed the separate
      `base` field entirely; a format asks for HTML nodes by name, and a format that wants none
      of them simply leaves them out of scope
    - one vocabulary can be shared by several formats under different syntaxes and different
      neighboring scope, so a component set can be authored as HTML by its own library and
      handed to modders under J5ML with no HTML in reach
    - containment is documented as a separate axis, defaulting open; scoping a vocabulary into
      a format says what nodes exist, not what may nest inside what
    - `lint` gained findings over the _resolved_ vocabulary scope rather than the declaration
      site, so shared and inherited vocabularies keep their safety checks: `unknown-vocabulary`,
      `invalid-format-scope`, `dead-vocabulary`, `vocabulary-node-shadowed`,
      `stripped-name-shadowed`, and `undescribed-vocabulary`
    - `score` counts the distinct nodes reachable from an accepted format, so a format declared
      but wired to nothing no longer inflates the number
  - **Stop discarding the tree we already build.** The sanitizer returns a sanitized `tree`
    alongside its `html`; the runtime keeps the string and throws the tree away one line later.
    The tree contract is half-built already; it just never reaches the host.
  - **Vocabulary validation.** `slot.payload` validates a _fill_; nothing validates a
    fragment _tree_ against its format's vocabulary. A typo'd node or an unknown variant
    should fail at `xript validate`, not vanish at mount.
  - **A declared vocabulary is checkable, typeable, and documentable.** The whole point of
    declaring a node set is that the toolchain can hold a mod author to it. `xript validate`
    rejects a misspelled node at CI time; `docgen` publishes a node table per format, listing
    each node's props and what it may parent; and `typegen` now types the tree itself, emitting a
    `[name, props, ...children]` tuple per node and a union over the vocabulary. A mod author
    writes `["Panel", { heading }, ...]` and the compiler checks the props, the children, and the
    nesting. Children nest as openly as a node declares: a container leaving `children` unset
    accepts any node to any depth, a `text` node takes strings, a childless node is a leaf, and a
    named allow-list narrows to exactly its set. Two formats sharing one vocabulary type it once.
  - **All four runtimes, one release.** The vocabulary model, the tree contract, and the
    sink model landed in `xript-runtime` (Rust, on the `j5ml` crate) and `Xript.Runtime` (C#,
    hand-rolled on `System.Text.Json`), so v0.8.0 cuts at parity rather than shipping a
    JavaScript-only feature with the other two documented as debt. Two shared conformance
    corpora (`spec/fragment-vocabulary-tests.json` and `spec/fragment-op-tests.json`) are
    generated from the reference implementation and asserted by every runtime _including_ the
    reference, so no implementation can fork from the contract without failing the others.
  - **Closed a typed-prop XSS at the HTML sinks.** The `href`/`src`/`style` sinks in the
    built-in HTML vocabulary only sanitized values that were already strings, so a JSML prop
    could wrap a payload in an array (`{"href": ["javascript:alert(1)"]}`) and land it in the
    rendered attribute unchecked: the HTML projection stringifies with JavaScript's `String()`
    semantics, and a one-element array stringifies to its element verbatim. Every value that
    projects into an attribute is now coerced _before_ the sink sees it, on all four runtimes.
    `true`, `false`, and `null` are untouched: they never carry text into the document.
  - **Replaced the C# HTML sanitizer with the shared allow-list port.** This is a deliberate
    behavior change on the .NET HTML surface, not a refactor. The old `SanitizeHtml` was a
    deny-list pipeline (anything not on a strip list passed through), which let
    `href="data:text/html,<script>…</script>"` reach the host. The allow-list port closes that,
    and as a consequence elements that used to survive because nothing stripped them (`<canvas>`,
    `<marquee>`, custom elements like `<my-widget>`) are now unwrapped to their children. Hosts
    relying on an element outside the shared allow-list should declare a vocabulary for it.
  - **The sanitizer serializes from the tree it already builds.** Every runtime kept two
    readers of the same HTML: a tree walk for the vocabulary pass, and an independent string
    scanner that produced the markup a host actually mounted. The scanners are gone; the markup
    and the report of what was removed both come from one traversal.
    - The scanners could emit unbalanced markup, which is not a cosmetic problem: a caller
      inserts the output into a document, and the browser re-parses it against that context
      rather than against the tree the sanitizer inspected. An unclosed stripped element sent the
      reader to the end of input, so `<svg><animate onbegin="…"></svg><p>after</p>` came back as
      a bare `<svg>` with the trailing content silently dropped. Output is now always
      well-formed. This is the one to upgrade for.
    - Raw-text handling is now spec-shaped rather than uniform. An unclosed `<script>` genuinely
      does read to the end of input (a browser treats a `</div>` inside it as text), and so do
      `style`, `title`, `textarea`, `noscript`, `iframe`, `xmp`, `noembed`, and `noframes`.
      Everything else closes with its parent.
    - Character references are decoded at the tokenizer, so a text node carries real characters
      and a round trip no longer double-escapes them.
    - The shared sanitizer corpus grew cases for unclosed elements, character references, and
      characters above the basic multilingual plane. The character-reference case caught the same
      defect in the C# reader, which had no test of its own.
  - **J5ML output conforms to the format we declare we speak.** J5ML orders attribute names
    by Unicode code point on serialization; every runtime was emitting them in source order.
    - The ordering rule is normative because the format's conformance corpus asserts byte-exact
      output, and attribute order carries no meaning that would otherwise settle it. This changes
      the bytes of J5ML documents xript emits for any element carrying two or more attributes not
      already in that order. HTML output is unaffected.
    - Every runtime now depends on the published j5ml implementation (`@nxis/j5ml` on the JS and
      Node paths, the `j5ml` crate for Rust, the `J5ml` package for C#) instead of restating the
      rule four times. Ordering is by code point, not by a language's default string comparison,
      and JavaScript's UTF-16 comparison parts company with it above U+FFFF.
    - The shared vocabulary corpus gained an optional `jsml` expectation, asserted by all four
      runtimes. It had pinned the tree and the HTML projection but never the J5ML projection,
      which is how non-conformant output shipped without a failing test.
  - **A tree contract worth writing a renderer against.** A renderer should be a small
    tree-walk, written **once per vocabulary** and reused by every app that speaks it — not once
    per app, and not once per renderer author who gave up and went around us. The tree types now
    live in `crates/xript-tree`, which carries the node, prop, condition, diagnostic and op types
    plus a stated contract version and depends only on `serde_json`. A renderer belongs to whoever
    owns the vocabulary; xript owns the mechanism and stays ignorant of any particular component
    set by design.
    - the types used to live inside the Rust runtime, so drawing a terminal widget meant linking
      a JavaScript engine to get at them
    - the terminal renderer is folded onto the contract, and the proof is what is gone: it no
      longer resolves bindings, evaluates visibility, or re-parses a serialized tree, and its
      production code dropped from 868 lines to 581. It no longer depends on `xript-expr` at all,
      so it cannot evaluate an expression even by accident
    - the reason recorded for the original bypass was wrong, and the correction matters more than
      the item: the pipeline _could_ already hold a tree. `FragmentResult` carried one alongside
      conditions and diagnostics, and `get_content` had no callers outside tests. The host was
      serializing the runtime's tree back to JSON and handing it over to be parsed again — and it
      read the _unbound_ tree, so conditions and diagnostics never left the runtime at all
    - two bespoke resolvers that survived the expression unification are gone, on the gauge and
      the sparkline, both of which took a bare name where the same widget took a full expression
  - **One expression grammar, and inline interpolation in prose.** `data-if` took a full
    expression and `data-bind` took only a name, so a fragment could _branch_ on `score > 50`
    but not _display_ `score * 10` without the host pre-computing it and exposing it as
    another binding. Displaying a value at all meant wrapping it in its own element. Both are
    closed, and the fix went deeper than the asymmetry: "the expression in `data-if`" meant
    five different things, and `alive && health < 50` was true in a browser and silently
    `false` in a terminal.
    - **XEG**, the xript Expression Grammar, is specified in `spec/expressions.md`,
      corpus-locked in `spec/expression-tests.json`, and implemented once per runtime. The
      corpus pins semantics rule by rule rather than deferring to "whatever JavaScript does",
      which is exactly how the five readings drifted apart with nothing to catch them
    - `data-bind` now takes any expression. A bare name is a member of the grammar, so every
      existing binding works unchanged — and stays privileged: the parser classifies the body,
      a name keeps two-way write-back, and a computed value is read-only, with a write-back
      handler aimed at one reported as a lint error instead of silently dropped
    - a fill can set `"interpolate": true` and write `{{ hp }}/{{ maxHp }}` in prose.
      Opt-in, because a fragment published before the mode existed may quote the delimiter and
      must keep its meaning; `{{` escapes, and an _unclosed_ `{{` is ordinary text, so a
      page documenting the syntax survives being one
    - interpolation is text-only. A prop's sink judges a whole value and cannot judge one
      assembled from halves, so `href="{{ scheme }}:{{ rest }}"` is not a thing; the wholesale
      surface for a computed attribute is `data-bind` through the node's `bindTo` prop. That a
      value can never become markup is structural rather than checked: segmentation runs in the
      sanitizer before validation, and a segment lives in a text node, which has no props and
      no children to put it in
    - the new zero-dependency `xript-expr` crate carries the grammar for both the Rust runtime
      and the Ratatui renderer, so a terminal renderer gets it without taking a JavaScript
      engine along. Rust's six-regex ladder, Ratatui's two-operand comparison helper, and C#'s
      per-evaluation `Jint.Engine` are all gone
    - `getContent()` returns a `conditions` array keyed by tree position. The `visibility`
      map it deprecates is keyed by expression text, so two nodes carrying the same `data-if`
      collapsed into one entry and a host could not map a result back to a node
    - `xript lint` gained an `expressions` analyzer in `@xriptjs/validate`, and
      `typegen --ambient` emits a per-fill bindings interface with a `keyof` alias for editor
      completion inside `{{ … }}`
    - a render-time "statement to run for effect" was considered and refused. A fragment is an
      inert description of what should be shown; a statement triggered by rendering makes
      render order into API and takes re-rendering, caching, and sandbox-free renderers with
      it. `handlers` already covers the real need, in the sandbox, where the capability model
      can see it
- **Commands became a slot kind.** `command` was canonical vocabulary in the guidance
  ("a named, invocable action with typed inputs and outputs") with no home in the schema, so
  every adopter reinvented it, usually as a top-level `commands` block that validated clean
  and was consumed by nothing. It is now the fifth slot kind
  (`application/x-xript-command`, alongside role and event slots): a host declares a slot,
  a mod contributes through the same `fills` object it already uses, and a command is a fill
  like everything else. The guidance page that claimed "this is the whole extensibility
  surface" and then listed a command as neither a binding nor a slot is finally telling the
  truth.
  - **Bound arguments on a command fill**, so one export backs several parameterized
    commands instead of forcing a closure per variant. `effective = { ...fill.args,
    ...callArgs }`, shallow, and the caller always wins a conflict
    - `input` describes the _effective_ argument object rather than the caller's slice, so a
      bound key satisfies a `required` entry and typegen relaxes bound keys to optional in
      the call-time type
  - **Authority lives on the export, not on the fill.** A command fill carrying a
    `capability` is a hard error in all four runtimes rather than a silently ignored key. A
    per-fill narrowing could never deny anything (the slot gate the mod already holds
    subsumes it by prefix), and the monotonic-privilege invariant mandates re-rooting a
    genuine escalation under a separate top-level scope, which a "must be subsumed by the
    slot's" rule would have rejected. Contribution is gated by the slot; invocation is gated
    by `entry.exports[<handler>].capability`
    - the consequence, stated plainly: two commands differ in authority only by naming
      different exports, because authority is a property of code rather than of a manifest
      label pointing at code
  - **Host-side resolution** (`resolveCommands` / `resolveCommand` and the `*All`
    variants) that conforms to the existing slot resolver instead of forking it, plus
    `invokeCommand` routing through the addressed, per-mod export path so two mods can each
    back a command with an export named `run` and neither invocation is ambiguous
    - slot ordering gained a third comparator, owning mod name ascending, applied to every
      slot kind. It closes a real nondeterminism in fragment resolution too: fills that omit
      an `id` get one synthesized from the slot id and index, so two mods filling the same
      slot at the same index had the same id and the second comparator was never total
    - `multiple: false` means one _command_, the same way it means one fragment. A palette
      slot wants `multiple: true`, and `xript lint` warns when a command slot omits it
    - a failing command propagates its error to the caller. Hook dispatch swallows a handler
      error and contributes `undefined`, which is right for a lifecycle notification and
      wrong for something a user just clicked
  - **A `score` signal for the exposed command surface**, reported alongside the headline
    rather than folded into it. A command slot is a slot and is already counted; adding a
    sixth capacity surface would double-count it and would silently move every existing
    host's denominator. Declared fragment formats are reported for the same reason
  - **typegen catalog output**: a `commandSlots` namespace and `CommandSlotId` union on
    the host side, a `commands.Catalog` interface keyed by command id on the mod side
  - **docgen catalog output**: a `## Commands` section on both pages, folded out of the
    generic UI-slots table, with a Requires column that makes authority visibly track the
    handler — the narrowest gate that applies, the handler's export capability where it declares
    one and the slot's contribution gate otherwise.
- **Long-running work stops freezing the host.** Three different problems have been wearing
  each other's clothes, and the loudest one was the least important. The runtime handle's API is
  **blocking on the caller's thread** (`rx.recv()`), so a host that drives it from its UI thread
  freezes, with or without async bindings; the freeze happens at the handle boundary before the
  sandbox is even reached. Separately, one handle is one thread and one queue, so a single slow
  call stalls every action, tick, and event behind it. And separately again, an `async` binding
  does not actually yield: it blocks the interpreter and hands JS a pre-resolved promise, so
  `async` changes the generated type and nothing else. The answer is not to make the sandbox
  interleave (that buys cooperative concurrency at the price of permanent reentrancy, and threads
  already give real parallelism). The answer is to make the good path the easy path.
  - **A non-blocking handle API**, so driving the runtime from a host's UI thread is not a
    trap laid for whoever gets there first. A call returns a pending value that is a future, with
    an immediate-mode take and a callback form beside it; blocking is now the thing a caller asks
    for by name. Dropping a pending cancels its call unless it was detached.
  - **A runtime pool.** Long-running or networked work gets its own runtime on its own
    thread: genuinely parallel, no shared-state surprises, no reentrancy.
    - a mod has exactly one home worker, so a hook handler runs exactly once no matter how many
      workers exist. The router governs `execute` and `invoke` placement only; hook and event
      fan-out always targets home workers, which the trait now says plainly
    - a wedged worker is detected from an overdue call plus a stalled heartbeat, then abandoned
      and reported. A thread cannot be reclaimed, and pretending otherwise would be a lie
  - **Declared intent, in the manifest.** A binding, hook, slot or export can declare how long
    it may run, so a host can _route_ it instead of finding out the hard way. The intent is
    routing input, not enforcement; `limits` stays enforcement.
  - **Be overt about the rest.** The spec and the generated types now say plainly that `async`
    declares the shape of a binding's value and not the cost of its call.
    - the "promise never resolved" error blamed the promise for a collision with an execution
      budget. A workflow left holding an outstanding promise reported a broken promise whether it
      had been interrupted by its budget, cancelled, or genuinely awaited something that never
      settles — three different problems with one misleading message, and the two that had a real
      cause reported the wrong one. The budget and the cancel are now reported as themselves, and
      what remains says what it means
    - the module-evaluation path had this right already and the workflow path had forked from it,
      which is the whole reason it went unnoticed: the correct handling was sitting fifty lines
      away, in the code that ran for a different kind of entry
    - also scoped the interrupt frame stack per thread. The guard popped whichever frame was
      pushed last rather than its own, so a call finishing on one thread removed another thread's
      live frame, and the handler scanned every thread's frames, so one expired deadline
      interrupted calls that had not timed out
    - a poisoned frame lock is recovered rather than given up on. A single panic while the lock
      was held silently disarmed every limit for the rest of the runtime's life
- **Adopter feedback fold.** Gaps reported from real integrations:
  - **ESM-native mod authoring.** Adopters were still wrapping mod code in IIFEs instead of
    using `entry.format: "module"`, and walking the scaffolded path shows why: it did not work.
    - **`typegen --ambient` could not describe a mod's own environment.** `log`, `hooks`,
      `events`, slot ids and capability names are surfaces the _host_ installs on the sandbox
      global, and a mod manifest declares none of them. Ambient mode read them off whichever
      manifest it was handed, so generating for a mod emitted an environment with none of it, and
      `--host` was accepted but consulted only for the command catalog. The scaffold's own stub
      told the author to run the command; running it replaced a working file with one that failed
      to compile. The environment now comes from the host, and only `fills` and `entry.exports`
      come from the mod. A host manifest with no `--host` generates exactly what it did before
    - **the TypeScript scaffold declared an entry no host could load.** It compiled `src/**` to
      `dist/` and then wrote `entry.script: "src/mod.ts"`. The demo worked only because
      `demo/steps.json` separately named `../dist/mod.js`, which is how the two disagreed without
      anyone noticing. `entry.script` names the artifact a host loads, and a test now asserts the
      manifest and the demo steps name the same file in both languages
    - **`xript init` scaffolded the previous release's manifests, permanently.** `templates.ts`
      hardcoded `0.7` in eleven places and the release script never touched it, so every version
      shipped an `init` a minor behind itself. The version, the schema URLs and the dependency
      pins are read from the package that generates them, and the tests assert consistency with
      that package rather than a literal of their own
    - `spec/modules.md` claimed the host manifest was optional while promising it would type the
      host bindings and hooks. It is required, and now says so
  - **`xript lint` reported findings about a capability called "0".** A mod's `capabilities`
    is an array of requested names, not a record of declarations, so `Object.entries` named each
    one by its index. Linting a mod at all was the deeper problem: passed in the host position it
    linted as a host, where almost no rule applies, and reported that everything lined up
    cleanly — while linting it against an absent host turns every fill and capability into an
    error the real host would have satisfied. A mod cannot be checked without its host, and the
    tool now says so instead of guessing.
  - **Capability scopes could not _describe_ runtime-configured roots.** They could already
    reference them: prefix subsumption is structural and consults no declaration, so a host
    declaring `fs.workspace` grants `write:fs.workspace.my-project` for a root the manifest could
    never have named, and a mod requesting a descendant of a declared scope validated clean while
    an undeclared _root_ still errored. The mechanism was never the gap.
    - what was missing was discoverability. A mod author reading the manifest saw `fs.workspace`
      and could not tell whether `fs.workspace.my-project` was a meaningful request or a scope
      they had invented, and generated docs described only the static half of the surface
    - a capability declaration takes an `instances` block saying its children are created by the
      host at run time, what one child corresponds to, and an illustrative example. It resolves
      nothing and validates nothing — no runtime reads it, and the matcher is unchanged
    - `xript lint` gained `dynamic-scope-undeclared`: a mod naming a scope strictly below a
      declared node that never claims runtime children is guessing at something the host does not
      model, and the grant will not be there. Declaring `instances` on the parent is the statement
      that makes the request intentional, and silences it. An undeclared _root_ is still reported
      once, as `undeclared-capability`
    - `docgen` gains a Runtime-configured scopes table and `describe` reports
      `dynamicCapabilities`, so the dynamic half of the surface is finally visible to tooling
    - the spec says plainly what subsumption means here: a grant on the parent sweeps every
      instance under it, **including ones that do not exist yet**. "Grant the parent, it is only
      one workspace today" is how a broad grant gets issued by accident
  - **Per-slot execution limits.** `limits` was global, so a slot whose fills legitimately run
    long inherited a budget tuned for something briefer, and a slot handling untrusted input
    inherited one tuned for something trusted. A slot now declares its own `limits`, replacing the
    manifest's for calls into that slot's fills.
    - a slot may **raise** the budget as well as lower it. The host declares both numbers, so
      neither direction is an escalation: a mod cannot buy itself more time by filling a slot,
      because it never wrote the number. The embedder's hard limits still clamp the result
    - it carries `timeout_ms` and nothing else, on purpose. `memory_mb` and `max_stack_depth` are
      properties of a runtime at the moment it is created in all four engines, so a per-slot value
      for either could not be enforced without standing up a separate runtime — a path that
      already exists, as `execution.affinity` plus a pool worker. Declaring keys no engine can
      honour would promise enforcement and deliver nothing, which is the mistake `async` made
    - `spec/slot-limit-tests.json` pins the resolution rule and is asserted by all four runtimes.
      It deliberately does not pin _enforcement_: that is wall-clock behaviour, proved per runtime
      by timing tests, and a shared corpus asserting it would be flaky rather than normative
    - **the Node runtime turned out to apply no deadline to an export invocation at all.**
      `execute` ran its code through `vm` with a timeout, but `invokeExport` reached into the
      context, pulled the function out, and called it from the host, where `vm` has nothing to
      interrupt. A command handler with a 50ms budget declared ran a 2000ms spin to completion,
      and every hook and command fill in `@xriptjs/runtime-node` had the same freedom. It now
      calls through `runInContext`. The deadline bounds synchronous work, as it does for
      `execute`; an `await` that never settles is not something `vm` can interrupt
    - the JS runtime reported an invocation stopped by its deadline as `InvokeError: interrupted`,
      blaming the export for the host's budget, while `execute` on the same runtime reported an
      execution limit. Both now build the error through one constructor
    - Jint fixes its `TimeoutInterval` when the engine is constructed, so the C# runtime's
      interval is now sized to the widest budget any slot could ask for and serves as a backstop,
      with the real per-call deadline carried by the cancellation constraint. Two readings of
      Jint's API that its shipped documentation supported and its assembly did not were corrected
      along the way: `CancellationConstraint.Token` is not public (`Reset` is the swap), and
      `cfg.CancellationToken` installs no constraint at all for a token that cannot be cancelled
    - `xript lint` told a _binding_ author to "add a `limits` override", which fails
      `xript validate` with `unexpected property "limits"` — the schema has no such key on a
      binding, and a timeout would not reach inside host code if it did. A long binding now gets
      `execution-long-binding-blocks`, which says what actually happens and asks the host to route
      the call. The same rule had never read a slot's `limits` either, so a slot was warned
      whether or not it declared one
    - `docgen` gains a Budget column on both slot tables, and `typegen --intent` carries
      `timeoutMs` on a slot that declares one. `score` deliberately does not count it: a budget
      tunes a surface rather than exposing one, and folding it in would move every existing host's
      number for no gain in moddability
  - **Same-named handler exports collide** across fills sharing a sandbox. Export identity is
    now `(mod, name)` rather than a bare name: the sandbox registry is namespaced per mod, the
    capability map is keyed by owning mod, and a hook fill records the mod that declared it, so a
    declaration lands in its own slot and is structurally unable to reach another mod's.
    `invokeExport(name, args)` still serves the single-owner case, and `invokeModExport(mod, name,
    args)` addresses the ambiguous one; two mods owning a name raises an error naming both instead
    of silently picking the last one loaded. Rejected at the call site rather than at load, since
    two providers of the same role legitimately export the same function name.
  - **Binding registration drift.** A binding the manifest declares and the host never
    supplies still installs (as a stub that throws when a mod calls it), so the contract a mod
    author reads and the surface a host actually wired could disagree indefinitely with nothing to
    catch it. A mod author reads the manifest, ships against a binding that is documented and
    absent, and the failure lands on a user.
    - every runtime computes the missing set at construction and exposes it (`missingBindings` /
      `missing_bindings()` / `MissingBindings`), fully qualified and sorted, walking nested
      namespace members the same way registration does so the two can never disagree
    - `strictBindings` refuses to construct the runtime instead, naming everything missing at
      once. **Off by default**: a host may under-supply deliberately (a feature-flagged binding,
      a surface still being built), and the missing set is visible either way
    - the drift is one-directional, which is worth recording: a host function the manifest does
      _not_ declare is never installed at all, so the manifest remains the gate on what a mod can
      reach. Only the declared-but-absent direction was silent
    - the Rust `RuntimeOptions` gained a field, and the integration tests that enumerate every
      field rather than spreading `Default` needed it. `cargo build` compiles the library and not
      the tests, so this only surfaced under `cargo test` — the counts caught it
  - **Dotted capability names in fragment callers.** Swept, and there is nothing stale: the
    fragment path adopted `grantedSatisfies` in the v0.7.0 hierarchy release itself rather than
    being left behind by it, no runtime compares a capability by set membership or equality
    anywhere, and every example and spec capability is a single hyphenated segment with no dotted
    name to have gone stale.
    - the coverage the item implies was real, though. Subsumption was pinned at the _binding_
      gate and nowhere else, so the fragment/slot gate (where a mod's contribution is actually
      admitted, and the gate a dotted scope has to reach to mean anything on a fill) was correct
      by construction and unguarded. All four runtimes now assert both axes there: a parent grant
      subsumes, an exact grant is admitted, a `read:` grant is refused against a `write:` gate,
      and a scope sharing only a character prefix (`uiother` against `ui`) is refused
    - the guard earns its place: regressing the gate to a set-membership check fails it at all
      five sites in the JS runtime
- **The JS runtime stopped shipping wasm nobody runs.** `@xriptjs/runtime` imported the
  `quickjs-emscripten` barrel, which top-level-`require()`d all four `@jitl` variants behind
  getters no bundler can see through. Every consumer installed **9.32 MiB of wasm across four
  files** and only ever ran one. The runtime now depends on `quickjs-emscripten-core` and imports
  the two release variants from separate modules, so `initXript()` never pulls the async build.
  - **Installed wasm: 9.32 MiB → 1.52 MiB, a 83.7% cut.** `debug-sync` (6.62 MiB) and
    `debug-asyncify` (1.56 MiB) are gone; nothing ever selected them. This is a shipped-size win,
    not a network one: the variants already lazy-loaded, so a browser only ever fetched the one
    it picked. The rest were orphan assets no chunk referenced.
  - `initXript()` and `initXriptAsync()` still work zero-arg; both gain an optional `variant`,
    the seam for passing a `singlefile-*` build that inlines its wasm as base64
  - **Vite dev servers need a one-line edit.** Production builds are unaffected. The `@jitl`
    packages locate their binary with `new URL("emscripten-module.wasm", import.meta.url)`, which
    Vite's dep pre-bundling breaks by rewriting the module into `node_modules/.vite/deps/`. That
    hazard is why hosts already carry `optimizeDeps.exclude: ["quickjs-emscripten"]`, but the
    barrel is no longer in the graph, so that entry becomes a dead no-op while the `@jitl`
    packages doing the `new URL()` go unexcluded. Name them instead:

    ```js
    optimizeDeps: {
      exclude: [
        "@xriptjs/runtime",
        "@jitl/quickjs-wasmfile-release-sync",
        // add "@jitl/quickjs-wasmfile-release-asyncify" only if the app calls initXriptAsync()
      ],
    }
    ```

  - Known residue, flagged rather than fixed: a Vite build still emits the 1.05 MiB asyncify wasm
    as an orphan asset no chunk references, because Vite emits assets at transform time and does
    not collect them after tree-shaking. It is never fetched. Removing it would need an
    `@xriptjs/runtime/async` subpath export, which is a public API change.
- **Every schema id serves the schema that version actually shipped.** xript.dev answered
  the historical alias URLs with the current in-development body, so a manifest pinned to an
  older `$schema` was validated and autocompleted against a schema that version never had, and
  the mismatch grew with every change on the branch. Each version id now serves its own frozen
  body; only the current line moves.
  - also silenced the two JSON Schema strict-mode warnings that printed on every `validate` run
- **Docs.** Both halves were already written: the fragment-hosting page carries a minimal
  end-to-end host snippet, and "Roles across isolated runtimes" states plainly that a host with
  per-mod runtimes implements role resolution itself and that this is canon rather than a
  workaround. What the sweep found was that the snippet taught the wrong API.
  - the canonical host loop read `result.visibility`, the text-keyed map this cycle deprecated
    _because it collides_: two nodes carrying the same `data-if` fold into one entry, last write
    wins, and nothing maps an entry back to a node. Two `data-if="warning"` nodes is enough. The
    snippet now reads `conditions`, which is keyed by tree position, and says why
  - the result shape was documented without the deprecation in both the hosting guidance and
    `spec/fragment-formats.md`; `spec/renderers.md` and `spec/expressions.md` already had it right

- **A scaffolded TypeScript app did not type-check.** `xript init` is the front door, and the
  project it produced failed `tsc` four ways. Every adopter who type-checks (which is every
  adopter who opens the project in an editor) met all four at once.
  - the demo imported `./host.ts`, and a `.ts` specifier needs `allowImportingTsExtensions`. An
    ESM import names the emitted module; it is `./host.js`, which TypeScript resolves back to the
    source
  - it read `e.message` off a `catch` binding, which is `unknown` under `strict`
  - it imported `node:fs/promises` without depending on `@types/node`
  - **its own host bindings did not satisfy `HostBindings`.** `HostFunction` was
    `(...args: unknown[]) => unknown`, and under `strictFunctionTypes` parameters are
    contravariant, so the idiomatic `(message: string) => void` was not assignable — every host
    writing typed bindings had to widen to `unknown` and narrow again inside. The parameter list
    is now `any[]`, which accepts both shapes and still rejects a non-function. Arguments arrive
    as JSON-derived values whatever the signature claims, so the stricter type was never
    enforcing anything a host could rely on, and the relaxation is non-breaking: everything that
    satisfied the old type satisfies the new one

- **A binding could gate on a capability the host never declared.** `undeclared-capability`
  was checked for slots, libraries and a mod's requests, and for nothing else — so a host could
  gate a binding, a nested namespace member, a hook, or an event on a scope absent from
  `capabilities`, and both `validate` and `lint` passed it clean. `xript scan` had been reporting
  exactly this as a "capability gap" all along, which is the tool disagreeing with the linter
  about the same manifest.
  - such a gate is undiscoverable: it appears in no generated documentation, and a mod that asks
    for the scope is told the host does not declare it. The gate is real and nothing can be
    written against it on purpose
  - all four surfaces are now reported, nested members by their qualified name (`ns.deep`). A gate
    subsumed by a declared parent scope stays clean, since prefix subsumption is what makes
    runtime-configured roots work

- **`xript score` told a host with no slots that it had filled all of them.** The coverage
  fractions score an empty surface as `1` (vacuously, nothing is uncovered), which is the right
  value for a gate and the wrong thing to draw as a full bar reading "100% of own non-reserved
  slots filled". A host that declares no slots, or inherits every slot it has through `extends`,
  read as perfectly covered.
  - `UtilizationMetric` carries a `total` so a presenter can tell an empty surface from a covered
    one; the vacuous `score` is unchanged, so no gate moves
  - the CLI renders `n/a — this host declares no slots of its own` instead of a full bar
  - `score-diff` had the same defect in its own renderer: deleting the only slot rendered
    `slots 0% → 100% (+1)`, so a regression read as an improvement. `MetricDiff` carries each
    side's total and a side with nothing to cover reads `n/a`
  - found by checking the stated invariant that `extends` must never lower the score. The headline
    is identical either way (67/100 in both), and the discrepancy was entirely in the
    informational coverage line

- **A manifest could name a type that does not exist.** A `typeRef` string is just a string to
  the schema, so `"returns": "NoSuchType"` validated clean, linted clean, and then `typegen`
  emitted it verbatim into a declaration file that would not compile —
  `Cannot find name 'NoSuchType'`. The same shape as an undeclared capability gate: a reference to
  something absent, sailing through validation and breaking downstream.
  - `xript lint` gained `undeclared-type`, covering binding parameters and returns through nested
    namespaces, hook parameters, event payloads, and the fields of a declared type, since a type
    may reference another
  - primitives, the `[]` shorthand, and the `{ "array": … }` / `{ "union": [...] }` object forms
    all resolve first, so only a bare custom name is reported. The primitive set is the one
    `typegen` itself resolves, so the two agree by construction
  - found by compiling typegen's output, which nothing had ever done

- **A host type or binding could shadow a name `typegen` generates.** A manifest declaring a
  type or binding named `Capability`, `Slot`, `CapabilityRef`, or `FragmentProxy` validated clean and
  then emitted a `.d.ts` with two declarations of the same identifier — a `TS2300` duplicate the
  adopter met only at compile time, three steps from the manifest, and one `--skipLibCheck` masked
  entirely. The generated helpers now live in a reserved `Xript` identifier namespace, and the
  namespace itself is what a host is told to stay out of, not a growing list of names.
  - **the four unprefixed helpers moved under the prefix** (breaking): `Capability` → `XriptCapability`,
    `CapabilityRef` → `XriptCapabilityRef`, `Slot` → `XriptSlot`, and `FragmentProxy` →
    `XriptFragmentProxy`. `XriptSlots` and `XriptEventId` already conformed. An adopter referencing one
    of the four by name updates the reference; the names read the same, just namespaced
  - `xript lint` gained `reserved-identifier`: a host type or binding whose name starts with `xript`
    (matched case-insensitively, so both the `Xript`-cased helpers and the `xript`-cased sandbox global
    and execution tables are covered) is an error. Reserving the prefix rather than a fixed list keeps
    every future generated name collision-safe with no new rule
  - `xript lint` gained `generated-accessor-collision`: a record type `Foo` emits a `FooAccessor`
    interface, so a second type literally named `FooAccessor` collides. That one is the host's own two
    names, not a framework imposition, so it is surfaced rather than reserved away — the accessor stays
    unprefixed and readable
  - the reserved prefix is a single constant in `@xriptjs/validate` that `typegen` emits from and `lint`
    checks against, so the two cannot drift
  - slot ids, capability scopes, and event ids are string _literals_ in the emitted unions, never
    identifiers, so they are deliberately not reserved

- **Both generators emitted the wrong type for an array of a union.**
  `{ "array": { "union": ["string", "number"] } }` came out as `string | number[]`, which
  TypeScript reads as `string | (number[])` — a union with an array rather than an array of a
  union. **It compiled**, which is what made it worse than a syntax error: an adopter got a
  silently incorrect type with no diagnostic. Element types are parenthesised before `[]` when
  they are a union or intersection; a plain element type is untouched.
  - the suite now compiles what typegen emits, the way it compiles what `init` scaffolds. Nothing
    had ever done so, which is how both this and `undeclared-type` survived
  - the compile check runs in memory against the real lib, so it needs no temp directory and no
    install, and it is probed: a binding returning an undeclared type fails it with the
    compiler's own `TS2552`
  - `spec/type-ref-tests.json` now pins how a `typeRef` renders, asserted by both generators. It
    deliberately fixes the _expected text_ rather than asserting the two agree: when this bug
    shipped they agreed perfectly and were both wrong, so agreement proves nothing
  - the corpus also caught `docgen` backticking every type name except `undefined`, which now
    matches the rest
  - **`docgen` had it in both renderers**, found by cross-checking the two generators against one
    manifest. Its signature block is fenced as TypeScript, so the wrong type was published as code
    an adopter copies, and its parameter table said the same thing in prose. Both parenthesise now,
    decided from the type reference rather than by inspecting the rendered string — the escaped
    pipes the table emits make that string unreliable to match on

- **`xript sanitize` stripped a script tag and said nothing.** `--quiet` documented itself as
  "output sanitized HTML only (no diagnostics)", which means the default documented itself as
  having diagnostics — and it printed none. The two modes differed only by a trailing newline. In
  a project that calls a silent drop the failure mode the fragment contract exists to end, the
  tool named after that contract was the one staying silent.
  - the default now reports what it removed, **on stderr**, so `xript sanitize f.html > out.html`
    still yields nothing but markup and existing pipelines are unaffected
  - `--quiet` silences it, which is what it always claimed to do, and a clean fragment still says
    nothing at all

- **The harness spoke two dialects; now it speaks one.** `spec/harness.md` and the
  `xript_host_step` MCP tool both promised that an interactive session "transcribes directly to a
  replayable steps file", and it did not. The two front doors named the same concepts differently
  (`export` versus `exportName`), and worse, `source` and `sources` meant a _path_ on the
  steps-file side and _inline content_ on the MCP side, so a verbatim transcription read inline
  JavaScript as a filename and dropped the export name in silence.
  - one parallel, unambiguous vocabulary now serves both: `sourceText` / `sourceTexts` for inline
    content, `sourcePath` / `sourcePaths` for paths, and `export` for the invoke
  - `source`, `sources`, and `exportName` still work as deprecated aliases and say so, on stderr
    for the CLI so a redirected stdout stays clean JSON, as a leading note for the MCP tool
  - `runSessionStep` became the single load-mod path; the MCP tool resolves its client-side paths
    to inline and delegates to it, so the two cannot drift apart again
  - `xript init` scaffolds the canonical names, and the promise the spec made is now true: a
    session built with them transcribes verbatim into a steps file

- **Walked every adopter path and fixed what broke.** A pass that ran each tool the way its own
  docs tell an adopter to, and mended the front-door papercuts that turned up.
  - `score-diff` met a manifest where a saved score belonged with a raw `Cannot read properties of
    undefined`; it now names the mistake and points at `xript score --json`
  - a failed manifest `oneOf` reported every branch at once, including `unexpected property
    "members"` on a namespace, advice that deletes the key that makes it a namespace; it now keeps
    only the branch that came closest and drops the bare meta-error
  - a description-less binding made `typegen --ambient` emit `/** * undefined */` and `docgen`
    publish `fs — undefined (1 function)`; both now omit an absent description rather than print the
    word
  - `describe` printed every page's heading twice, and `spec/expressions` and `spec/renderers` were
    reachable through neither `xript guide` nor the `xript://spec/*` resources, the third surface to
    lose them, so the content sync now derives its page list from the directory and a test fails if
    a page is left unserved
  - the rust runtime's README example stopped compiling once `RuntimeOptions` grew; each runtime's
    front-page example is now run-verified, and the rust and csharp ones are guarded by a test that
    builds the snippet so it cannot silently rot again

### Behaviour changes

- **Command fills left `dataFills`.** Before v0.8.0, `application/x-xript-command` was reserved
  in name only: a slot could accept it, and its fills were delivered untyped in
  `mod.dataFills[slotId]` with no shape checks beyond "is an object" and the slot's capability
  gate. From v0.8.0 they are parsed as command fills and delivered in `mod.commandFills`. **A
  host reading them out of `dataFills` must read `commandFills`, or resolve them with
  `resolveCommands`, instead.**
  - normalization also got strict: a fill that used to load as an opaque object now fails to
    load without a valid `handler` and a valid `id`. That is the point of typing the accept,
    and it is a load-time error carrying a fix-it message rather than a runtime surprise
  - there is no dual delivery. `dataFills` is the escape hatch for slot kinds the runtime has
    no typed reading of, and a typed kind appearing there too would make the field mean two
    things. Neither role nor hook fills dual-deliver either
  - the same latent hazard existed for role and hook when those accepts were typed. This is
    the one-time cost of turning a reserved-by-convention string into a
    reserved-by-implementation one, and no third occurrence is pending
- **Role resolution stopped depending on load order.** `resolveRole` used to return the first
  candidate in the order the host happened to pass its mods in, so reordering that array
  silently changed which implementation of a role ran. Candidates are now ordered by owning
  mod name ascending, the third key of the shared slot comparator, which is the only one of
  the three that applies to a role fill. `rolePreferences` still outranks the tiebreak, so a
  host that was relying on array order should name its choice there.

### Test counts

| Package | v0.7.0 | v0.8.0 |
|---------|-------:|-------:|
| `@xriptjs/runtime` (js) | 256 | 879 |
| `@xriptjs/runtime-node` | 252 | 880 |
| `xript-runtime` (rust) | 185 | 385 |
| `Xript.Runtime` (csharp) | 298 | 1304 |
| `@xriptjs/sanitize` | 93 | 679 |
| `@xriptjs/validate` | 169 | 430 |
| `@xriptjs/typegen` | 82 | 163 |
| `@xriptjs/docgen` | 61 | 109 |
| `@xriptjs/init` | 44 | 53 |
| `@xriptjs/cli` | 76 | 115 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 38 | 38 |
| `xript-expr` | n/a | 13 |
| **Total** | **1612** | **5106** |

## v0.7.0 — Capability Hierarchy & Live Events

The security-and-reactivity chapter, and then some. v0.7.0 started as two pillars and finished as five: **hierarchical capabilities** (grant broad or narrow without a flat-cap explosion), **live events** (the `events` catalog actually reaches subscribing mods now), **xript libs** (whole approved libraries, imported in-sandbox), the **host harness** (test a mod end-to-end with no application running), and **`fills` landing in every runtime** (the canonical contribution surface finally loads as authored). Around the pillars: the static tooling reasons about capabilities the same way the runtimes do, the docs reorganized around who's reading them, and the site now serves every schema and spec page it used to 404 on.

### Hierarchical capabilities

- reshaped capability matching from flat string equality to **prefix subsumption with a read/write mode axis**: a capability reference is `[<mode>:]<scope>`, where the scope is a dotted tree matched on whole segments (`run` covers `run.command`, never `runner`) and the mode is a two-point lattice (`write` covers `read`; a bare reference means `write`)
  - declared capability keys stay scope-only; the mode axis lives on references and grants, so every existing flat capability keeps its meaning with zero migration
  - a granted set satisfies a requirement when **any single grant** covers both axes; there is no cross-grant composition
  - defined the `capabilityRef` grammar in the schema (`^(read:|write:)?[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$`) and applied it to every `capability` reference field, where declarations were previously unvalidated free text
- pinned the model with a shared conformance corpus (`spec/capability-tests.json`, 33 cases) that all four runtimes load and assert, the same cross-runtime oracle pattern as the extends and sanitizer corpora
- wrote the **monotonic-privilege invariant** into `spec/capabilities.md` as a normative MUST, with the honest caveat that it cannot be statically proven; `xript lint` carries a heuristic `capability-escalation` warning for escalation-named children under broad grantable ancestors
- documented the **two-grammars rule** in `spec/bindings.md`: binding and member names are JavaScript identifiers (deliberately unconstrained, since kebab would parse as subtraction), capability scopes are kebab dotted paths, and tooling constrains only the capability side

### Live events & hook dispatch

- made the `events` catalog deliverable: a sandbox script subscribes with `events.on(id, handler)` (alias `events.subscribe`), the host broadcasts with `emit(id, payload)`, and delivery rides the same keyed-registry fan-out engine hooks already use rather than a parallel subsystem
  - an event's optional `capability` gates subscription at registration time, reusing the hook gate model under subsumption; events without a gate stay open to any script
  - the fan-out contract is byte-for-byte `fireHook`'s: object payloads spread positionally, handlers run in registration order, per-handler errors are swallowed
- closed #112: event-typed slots (`accepts: application/x-xript-hook`) now register the `hooks` global and fire through `fireHook` across all four runtimes, so a manifest that declares its hooks as slots no longer silently no-ops; an explicit `hooks` entry still wins over a same-id slot

### Adoption gaps — the asks that came back from real hosts

- gave xript.dev a `/changelog/` page, synced from the repo `CHANGELOG.md` at build time and linked from Start Here, so release notes live at the conventional URL instead of taking version spelunking to find
- served every schema at its `$id` URL: `/schema/manifest/v0.7.json`, `/schema/mod-manifest/v0.7.json`, the harness pair, and the four host-side data shapes now resolve on xript.dev, with prior version ids (v0.6/v0.3/v0.1) answering as aliases; previously only a single stale manifest version was served, so the `$schema` URL every manifest declares was a 404 and editor autocomplete had nothing to fetch
- mapped the `/spec/` URLs readers guess at: a `/spec/` overview landing (documents + schema directory), plus `/spec/extends/` and `/spec/harness/` pages that existed in the repo but never made it onto the site; internal spec cross-links now resolve on-site instead of pointing at the repository
- added a minimal end-to-end example to the "Rendering fragments" guidance: a host manifest with one fragment slot, an inert two-binding template, and the ~10-line host loop, every command verified against the real runtime, declared `bindings` and all
- blessed **host-side role resolution across isolated runtimes** as canon in the "Resolving roles" guidance: a host that gives each mod its own runtime for grant isolation implements `resolveRole` semantics natively over its own registry; the load-bearing invariant is the `{ addon, role, fns }` fill contract and invoke-by-name, not which code path selects the provider
- fixed `score`'s last string-equality capability checks: its integrity and utilization figures compared slot gates and capability references literally, spuriously flagging mode-prefixed or child-scope gates; they reason by subsumption now, same as `lint` and `crossValidate`
- blessed **data fills** in the mod-manifest spec: a slot whose `accepts` names a data format takes pure-metadata fills validated by the slot's `payload` schema, the canonical shape for grouping/pack/curation surfaces, with the discovery policy staying host-side; no new primitive needed

### `fills` lands in the runtimes — the canonical surface finally loads

- implemented `fills` consumption in all four runtimes: `loadMod` now resolves the canonical contribution surface against the host's slot types, closing the gap where the validator, lint, spec, and docs all pushed mods toward `fills` while every runtime silently ignored it
  - a fragment-format fill becomes a fragment declaration (an id-less fill gets a stable synthesized id), a role fill (`application/x-xript-role`) becomes a provider role, and an event/hook fill (`application/x-xript-hook`) registers its named `handler` export so `fireHook` invokes it after in-sandbox-registered handlers, same swallow-errors contract
  - fills are capability-gated at load against the slot's declared gate (subsumption applies), a fill targeting an undeclared slot fails loudly, and a mod mixing `fills` with the deprecated `fragments`/`contributions` surfaces is rejected rather than silently double-contributing
  - the `ui-dashboard` and `svelte-fragment-renderer` examples dropped their hand-rolled fills→legacy conversion shims; mods now load as authored
- made the static capability checks subsumption-aware, matching the runtimes: `crossValidate` accepts a mod requesting a child scope of a declared capability (`fs.addon` under a declared `fs`) or holding a broader grant than a slot's gate, and `lint`'s undeclared/vestigial checks reason over the scope tree instead of string equality
  - the `satisfies` / `grantedSatisfies` predicate now lives in `@xriptjs/validate` (exported for host import), bound to the shared `spec/capability-tests.json` corpus, and `docgen` reuses it instead of carrying a third copy
- folded event-typed slots into the tooling's hook surfaces, mirroring the runtimes' dispatch: `typegen` emits a `hooks` registration function for each hook slot (with a bracket-access note for non-identifier ids) and `docgen` lists hook slots in the Hooks section; an explicit hook still wins over a same-id slot
- modernized the `xript init` scaffolds end to end
  - manifests author the current shape: `fills` keyed by slot id, `xript: "0.7"`, v0.7 schema ids, slots with explicit `accepts`, the lifecycle hook declared as an event-typed slot
  - the tier-4 demo now actually runs; it loaded mods without fragment sources and called a `runtime.processFragment` method that doesn't exist, and now loads through `loadMod` + `fragmentSources` and renders via `updateBindings`
  - the mod scaffold gained a runnable harness-powered demo (`demo/host-manifest.json` + `demo/steps.json`, wired to `npm run demo`), which also exposed and fixed a wrong `hooks.fragment.update` signature the entry script taught
  - dependencies reference the current release line instead of `^0.2.0`
- grew the harness steps format a `sources` map on `load-mod`, so a mod whose fills reference file-sourced fragments can load through a steps file or `xript_host_step`
- advanced the manifest and mod-manifest schema `$id`s to the v0.7 line, with the v0.6 and v0.3 ids kept as resolvable aliases; spec prose, docs examples, and the bundled example manifests now author `xript: "0.7"` against the new ids

### Docs restructure — sections by reader, entry pages for everyone

- reorganized the docs sidebar by reader role: the seven host-implementation pages moved out of Doctrine into their own **Hosting xript** section (the "Hosting:" title prefixes dropped, since the section says it now), a new **Authoring Mods** section pairs the authoring doctrine with a walkthrough, and Doctrine keeps the actual philosophy
  - the retitles happened at the source, the `xript guide` topic catalog, so the CLI and the docs site stay one set of content
- added **Your first mod**: zero to a running, sandboxed mod in two files and three commands, no host application required, with every command's expected output shown
- geared the entry pages for less-technical readers: Getting Started and the CLI page now open with explicit prerequisites (Node check, CLI install, a verify step), a hosting-vs-modding orientation callout, and a `command not found` rescue note; the runtime-vs-CLI install split is now stated instead of assumed

### xript libs — approved in-sandbox libraries

- added the `libraries` manifest surface: a curated allow-list of whole libraries mod code may `import`, the capability model applied to modules
  - imports stay default-deny; an allow-list entry is the only thing that lifts it, and only for mods whose grants satisfy the entry's capability under subsumption (`lib` ⊇ `lib.doc`); an ungated entry is importable by every mod
  - the host supplies each library's pre-bundled ES module source at runtime construction; an approved library links **inside the sandbox at the importing mod's own privilege**: full-fidelity calls, no JSON boundary, no new power granted
  - registration is guarded: a source for an undeclared specifier, a library carrying CommonJS artifacts, or one that is not **import-clean** (it has imports of its own) fails loudly at construction; a declared-but-unregistered library fails a mod's import as a named host bug
  - dynamic `import()` stays dead: literal dynamic forms are rejected by the static scan, and loaders only answer during entry-module linking
- implemented the loader in all four runtimes at parity: a QuickJS-WASM module loader (`@xriptjs/runtime`), a `SourceTextModule` linker (`@xriptjs/runtime-node`), an rquickjs resolver/loader pair with a load-phase gate (`xript-runtime`), and Jint module registration (`Xript.Runtime`), all with matching error identities (`ImportDeniedError`, `CapabilityDeniedError`, `LibraryUnavailableError`, `LibraryRegistrationError`) and ~11 tests each
- taught the toolchain the new surface: `validate` checks the schema shape, `lint` errors on a library gating an undeclared capability and counts library gates as capability use, `score` counts `libraries` as a fifth capacity surface, `describe` lists libraries (and events), `docgen` renders a Libraries table, and `typegen --ambient` emits `declare module` declarations so a TypeScript mod can import approved libraries without type errors
- documented the model in `spec/manifest.md` (Libraries section) and `spec/modules.md` (Approved Libraries: resolution order, in-sandbox execution semantics, the import-clean rule, and the pure-compute-vs-host-binding line)

### Host harness

- added the host harness: a host manifest executed with stub bindings instead of a live application, so mods, fills, events, and hooks are testable end-to-end with no app running
  - two spec data shapes define the whole contract: `spec/harness.schema.json` (binding stubs `returns` / `throws` / `sequence` / `script` / `record`, plus capability grants) and `spec/harness-steps.schema.json` (an ordered, replayable scenario: load mods, invoke exports, emit events, fire hooks, resolve slots and roles, read the journal)
  - every stubbed binding call is journaled in order alongside capability audit events and sandbox console logs; the journal is the scenario's assertion surface
  - when no grants are listed, every capability scope the host declares is granted in full; capability-denial testing sets the list explicitly
- taught `xript run` batch harnessing: `xript run --app host.json --harness harness.json --steps steps.json` runs a scenario file against a synthetic host and exits non-zero if any step fails
- gave the MCP server persistent harnessed sessions: `xript_host_load` holds a live runtime across tool calls, `xript_host_step` speaks the same step vocabulary as the steps file, and `xript_host_journal` / `xript_host_list` / `xript_host_unload` round out the family; an interactive session transcribes directly to a replayable steps file, so nothing is expressible over MCP that the CLI can't replay
- harness descriptors carry library sources too: `libraries` entries (inline `source` or `path` relative to the harness file) stand in for the host's registration step, so a scenario can exercise a mod that imports an approved library with no app running; the session summary reports each declared library's registration state
- exposed the harness spec over MCP resources (`xript://spec/harness` and both schemas) and exported the session API (`createHarnessSession`, `runSteps`, `runSessionStep`, `loadStepsFile`) from `@xriptjs/cli` for host import

### Test counts

| Package | v0.6.0 | v0.7.0 |
|---------|-------:|-------:|
| `@xriptjs/runtime` (js) | 187 | 256 |
| `@xriptjs/runtime-node` | 185 | 252 |
| `xript-runtime` (rust) | 150 | 185 |
| `Xript.Runtime` (csharp) | 229 | 298 |
| `@xriptjs/sanitize` | 93 | 93 |
| `@xriptjs/validate` | 155 | 169 |
| `@xriptjs/typegen` | 64 | 82 |
| `@xriptjs/docgen` | 42 | 61 |
| `@xriptjs/init` | 41 | 44 |
| `@xriptjs/cli` | 60 | 76 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 35 | 38 |
| **Total** | **1299** | **1612** |

## v0.6.0 — Manifest Inheritance & the Agent CLI

Two stories in one release. Manifests learned to **inherit**: a manifest can `extends` a base, fill the abstract holes the base leaves open, refine the concrete pieces it declares, and the same resolution runs identically across all four runtimes. The CLI grew an **agent**: `@xriptjs/cli` now speaks Model Context Protocol, exposing every capability a human runs at the terminal to an agent over stdio. No separate package, no logic to drift.

### Manifest inheritance (`extends`)

- added manifest inheritance: a manifest names one or more base manifests in `extends`, resolved and deep-merged base-then-child before validation, transitively, with cycle detection
  - three moves on a name that collides with the base; **add-new** introduces a name the base does not have (additive, no marker), **fill** redeclares an `abstract: true` base type with concrete fields or values (abstractness is the opt-in, so no marker), and **refine** redeclares a concrete base type or slot with `refines: true` to deep-merge (child wins per key, nested objects recurse, arrays and scalars replace wholesale)
  - any other collision is an error, so inheritance never silently clobbers; concrete-on-concrete without `refines`, a duplicate binding, a duplicate capability, or a duplicate hook all fail
  - an inherited abstract type left unfilled is an `abstract-type-unfilled` error, so a base can declare a typed hole a child is required to concretize
- made a slot's `payload` carry a full JSON Schema, so a slot can describe exactly what a valid fill looks like (patterns, nested `required`, the lot) instead of a flat field list
- added open enums: a type's `values` or a field's inline `enum` can set `open: true` to mean "these known values, plus any other string"; `typegen` emits `... | (string & {})` so the known values autocomplete while any string still type-checks, and `docgen` marks the type extensible
- brought `extends` resolution to parity across all four runtimes (the universal QuickJS-WASM, Node, Rust, and C#) against an 18-case conformance corpus, so a manifest resolves identically wherever it loads
- consolidated the resolver: `typegen` and `docgen` now reuse `@xriptjs/validate`'s resolver instead of carrying their own copies; one resolution implementation per language, not one per tool
- taught the analyzers (`validate`, `score`, `cross-validate`) to resolve `extends` before they run, so inherited slots and capabilities are seen rather than reported missing

### Contribution model

- redesigned the contribution surface around "host declares typed slots, mod fills them"; a host slot's `accepts` type governs what a valid fill looks like and what the host does with it (mount, call, resolve, or fire)
  - folded fragments, provider roles, and hook handlers into one concept: each is a fill of a slot of a particular type, not a separate top-level surface
  - mods now contribute through a single `fills` object keyed by host slot id; a fragment is a fill of a fragment-format slot, a provider role is a fill of a role-typed slot, a lifecycle hook handler is a fill of an event-typed slot
  - standalone `hooks` is deprecated in favor of event-typed slots; a hook is a slot whose `accepts` is the event-handler kind, and firing it calls that slot's fills, with host-side hook firing unchanged
  - validation stays tolerant of legacy `fragments[]` and `contributions` for smooth migration (still validated, now with a deprecation warning); the fill contract checks that a filled slot exists and the mod holds its capability, and leaves the inner fill shape to the slot's type
  - clarified that format renderers (`xript-ratatui`, the DOM fragment processor) are runtime infrastructure, not manifest concepts; a slot's `accepts` names the format the runtime must be able to paint

### Manifest surfaces

- renamed a fragment fill's DOM event handler array from `events` to `handlers`; the entries are event _handlers_, not events, and the old name said the wrong thing
  - `events` stays accepted as a deprecated alias for back-compat (mirroring the standalone-`hooks` to event-slot precedent): a reader takes `handlers` or `events`, `handlers` wins if both are present, and `events` warns; the entry shape (`selector`, `on`, `handler`) is unchanged, so migration is a key rename
- added a top-level `events` catalog: an optional array declaring the named events a host broadcasts and each one's payload type
  - it is a consumer-agnostic discovery declaration (what the host emits, with no listener presupposed) and is deliberately distinct from event-typed slots (extension points a mod fills) and fragment `handlers` (DOM responses on a fill); one line: bindings are what you can call, slots and handlers are what handles, `events` is what the host emits
  - `typegen` emits a typed event catalog and `docgen` renders an events section
- let a domain extend the top-level manifest vocabulary with a schema overlay, and taught the validator to honor a manifest's declared `$schema`
  - the core manifest's top level no longer rejects unknown top-level properties, so an `allOf` overlay can add domain surfaces and still validate; deeper objects stay closed, so typos inside known surfaces are still caught
  - schema resolution leans open: a known schema id resolves to bundled core, a local path resolves relative to the manifest the way `extends` does, and a remote `http(s)` URL is fetched and cached (keyed by URL, pinned per run); offline or uncached-remote falls back to bundled core with a surfaced warning rather than hard-failing
  - remote resolution is allowed unless a host opts out (allowlist or disable-remote); you opt out of openness, not into it, and honoring a declared schema grants no power, since the capability model, not schema validation, is the security boundary
- bumped the manifest schema `$id` from the v0.3 line to v0.6, with a legacy-id alias so a manifest or overlay still pinning the old id resolves
- added an optional `license` field to the mod manifest (an SPDX id or short label); forbidding it bought nothing under the openness doctrine

### Extensibility scoring & lint

- reshaped `xript score` to measure **moddability capacity**: how much of the extension surface a host exposes (bindings to call, slots to fill, events to observe, a capability model to gate them), against a ceiling of exposing all of it, rather than how much a supplied mod set happens to exercise it
  - exposing a slot the host does not fill itself now reads as moddability, not waste, and resolving `extends` can only raise the score, never drag it down; "find the unused surface" stays `lint`'s job
  - slot and capability utilization survive as informational mod-coverage, now excluding `reserved` and inherited surface from their denominators
  - `score-diff` diffs capacity too, and its regression gate keys off the capacity headline
- taught `cross-validate` to check each fill's payload against the target slot's `payload` schema, closing the gap where a fill could name a real slot, hold its capability, and still carry a payload the slot forbids
  - the schema is applied as authored: a fill carrying more than the payload declares still passes unless the slot explicitly closes its payload; only declared shape is enforced, extras are not policed
  - on by default; `--no-fill-payloads` on the CLI and `checkFillPayloads` in the library and MCP tool flex it off
- added `xript lint`, a findings-based reviewer that complements `score`: where score is the number, lint is the actionable list behind it
  - checks are set arithmetic over manifest fields; filled-but-undeclared slots and undeclared capabilities are errors, dead slots and vestigial capabilities are warnings, ungated and undescribed surfaces are info
  - each finding carries a severity, a stable code, a message, and a suggestion; `--strict` promotes warnings to failures for CI, and the exit code gates accordingly
  - a `legacy-shape` finding flags a mod still on the deprecated `fragments` / `contributions` shape, so migration progress is visible in the linter instead of by grep
- added `xript score-diff`: it compares a current run against a saved baseline and reports whether the surface moved toward or away from xript, naming the capacity delta, the slots and capabilities gained or lost, and the integrity violations introduced or fixed; `--min-delta N` is the regression gate
- added a `reserved` flag to slots and capabilities, so a surface declared ahead of a filler (for forward-compat or inherited parity) is treated as aspirational, never flagged dead or vestigial, and is excluded from coverage
- counted capabilities that gate bindings and hooks (not just slots and mod requests) toward "used," so a capability doing real gating work is never called vestigial
- moved the analyzers (`scoreManifests`, `diffScores`, `lintManifests`) out of the CLI into `@xriptjs/validate`, so a host application can surface a modder's problems in its own UI by importing the validation library it already depends on; the CLI commands and MCP tools are thin front-ends over them

### Agent tooling

- taught `@xriptjs/cli` to run as a Model Context Protocol server via `xript mcp`
  - tools mirror the CLI one-to-one (`xript_validate`, `xript_cross_validate`, `xript_typegen`, `xript_docgen`, `xript_sanitize`, `xript_scaffold`, `xript_scan`, `xript_manifest_describe`, `xript_run`, `xript_score`, `xript_score_diff`, `xript_lint`, and `xript_guide`), each calling the same core its matching command does
  - resources serve the spec straight from source (`xript://spec/*`) alongside authoring guidance (`xript://guidance/*`), and prompts (`adopt-xript`, `is-this-xript-native`, `choose-a-surface`, `author-a-mod`) carry the doctrine as reusable templates
  - manifest-taking tools accept a file path or inline JSON, so a large host manifest needn't ride through the tool-call tokens; relative paths resolve against the client's workspace root
- added `xript_server_info`, reporting the server's name, version, build timestamp, and runtime; the timestamp comes from the running module's own file mtime, so a stale server process whose binary predates a repo change is detectable rather than silently serving old results
- added four commands so the human gets every capability too, not just the agent
  - `xript run` loads a mod into the QuickJS-WASM sandbox and optionally invokes an export
  - `xript describe` summarizes what a host manifest exposes: bindings, hooks, slots, capabilities
  - `xript score` rates a host's moddability capacity, with a `--min` gate for CI
  - `xript guide` prints xript's authoring doctrine by topic
- authored the doctrine as markdown content rather than code; one source of truth behind the `xript guide` command, the `xript_guide` tool, and the `xript://guidance/*` resources

### Doctrine

- added xript's "More extensible, not less" doctrine: the framework defaults toward openness, and a restriction is permitted only when it genuinely buys convenience or security the framework couldn't otherwise provide, and must justify itself plainly
  - authored as guidance content like the other doctrine topics, so it surfaces through the `xript guide` command, the `xript_guide` MCP tool, the `xript://guidance/*` resources, and a Doctrine page on the site from one source

### Docs

- surfaced three subsystems that lived in the spec but never reached the site: Hooks, Module-Format Mods (the TypeScript authoring guide v0.5 promised), and the DAP-shaped Debugging protocol
- documented the v0.5 manifest surfaces the site had missed: provider roles, owned record types, manifest `extends`, the mod `family` field, and the `entry` module form
- added an `extends` / inheritance page, MCP server, Extensibility Score, and Lint pages, surfaced the authoring doctrine as a Doctrine section (derived from one source), and expanded the CLI reference with the new commands
- reframed the manifest, mod-manifest, fragments, and hooks spec pages around the host-slots / mod-fills model; fragments and provider roles and hooks are now documented as typed slot fills, with `fills` as the canonical contribution surface
- generated `llms.txt` and `llms-full.txt` at build time: a curated index and a full-corpus one-pager for agents, linked from the home page
- fixed the CommonJS error in `@xriptjs/validate` pointing at a guide URL that never existed; it now points at the published Module-Format Mods page

### Tests

| Package | Before | After |
|---------|--------|-------|
| `@xriptjs/validate` | 68 | 155 |
| `@xriptjs/typegen` | 52 | 64 |
| `@xriptjs/docgen` | 35 | 42 |
| `@xriptjs/cli` | 38 | 60 |
| `@xriptjs/runtime` | 166 | 187 |
| `@xriptjs/runtime-node` | 165 | 185 |
| `xript-runtime` (Rust) | 125 | 150 |
| `Xript.Runtime` (C#) | 201 | 229 |

## v0.5.0 — Hardening, Roles & a Debugger

The biggest release since the fragment protocol: a security fix that touches every host, a full pass of runtime lifecycle controls, a clutch of new extensibility surfaces, a DAP-shaped debugger across all four runtimes, and first-class TypeScript authoring with real ES module evaluation. Every runtime kept in lockstep against a shared contract.

### Security

- closed a `data:` URI XSS hole in the Rust sanitizer that any host embedding the runtime inherited
  - `xript_runtime::sanitize_html` registered `data:` as a blanket allowed scheme, so `data:text/html,<script>…</script>` survived on `<img src>` and `<a href>`
  - added a subtype gate that keeps only `data:image/{png,jpeg,gif,svg+xml}` and strips everything else, matching the TS and C# runtimes that already conformed
  - brought the Rust serializer the rest of the way onto the canonical 56-case corpus: XHTML self-closing void elements and bare boolean attributes, byte-for-byte

### Runtime lifecycle

- added host-driven cooperative cancellation: a `CancellationToken` on `RuntimeOptions` that interrupts in-flight execution at the next check point and surfaces a distinct cancellation error (not a timeout)
  - QuickJS, rquickjs, and Jint interrupt mid-run; Node's `vm` has no mid-run hook, so it checks the token at execute/invoke entry
- added an opt-in per-capability audit channel: a fire-and-forget hook that reports every allowed binding invocation as `{ binding, capability, at }`
- gave `ConsoleHandler` a severity enum (log/info/warn/error/debug) and a trace channel
- finished the sandbox hard caps (memory, CPU time, and stack depth) and brought every runtime to parity

### Extensibility

- added the host-invoke export seam: mods declare named exports the host can call and whose return value it honors (the non-streaming core; streaming is reserved)
- gave slots runtime teeth (ordering by priority, single/multiple cardinality, and capability enforcement on contributions); they were advisory-only before
- added provider-role resolution as a first-class mechanism, retiring the pattern of core UI hardcoding addon-specific globals
  - mods declare `contributions.provides: [{ role, fns }]` where `fns` maps logical names to concrete exports
  - the host calls `resolve_role(role) → { addon, fns }` (first-installed-wins, settings-overridable) or `resolve_role_all` to build its own picker
  - declaring a role grants nothing; the named fns stay gated by their own capabilities
- let addons describe owned record types through the existing `types` surface rather than a new persistence concept
  - `fieldDefinition` gained `default` and inline `enum`; `typegen` emits typed accessors; the runtimes stay persistence-agnostic
- added manifest `extends` with deep-merge so a manifest can inherit and override host bindings
- added an optional top-level `family` field to the mod-manifest schema for addon grouping
- added capability-grant data shapes (schemas only): a prompt payload (capability + description + risk + scope), an install descriptor, and a discovery result; grant policy and prompt UX stay host-side

### Debugging

- added a DAP-shaped debug protocol the host can drive: set/clear breakpoints by source position, pause/resume/step in/over/out, and inspect scopes, locals, and stack frames
  - implemented across rquickjs (Rust), QuickJS-WASM (the async sandbox), Node's `vm` (AST instrumentation), and Jint (C#) using Debug Adapter Protocol vocabulary
  - engine fidelity differs and is documented per runtime; rquickjs 0.10 exposes no per-line hook, QuickJS-WASM debugging requires the async sandbox, Jint pauses synchronously on the engine thread

### TypeScript & ES modules

- made `entry.format: "module"` real: the runtimes now evaluate a mod entry as an ES module instead of treating the value as a reserved no-op
  - implemented across rquickjs (Rust), QuickJS-WASM (async sandbox), Node's `vm` (`SourceTextModule`), and Jint (C#)
  - top-level named function exports become host-invokable exports automatically; `export function transcribe()` needs no `xript.exports.register` call, the two paths coexist, and an explicit `register` wins on a name collision
  - external imports stay denied (`import x from "fs"` fails at load); the sandbox's no-external-modules guarantee is unchanged
- added a CommonJS guardrail: `require(`, `module.exports`, and top-level `exports.` in a mod entry now fail loudly with a fix-it message instead of breaking silently, so a mis-set `tsconfig` can't quietly produce unrunnable output
- added first-class typed authoring for TypeScript mods
  - `@xriptjs/typegen --ambient` emits a `.d.ts` declaring the `xript` global (host bindings, `exports.register`, and the mod's own declared exports and types), so authors get real intellisense and typecheck
  - `xript init --mod --typescript` now scaffolds an ESM `tsconfig`, an `export`-based example, and the ambient types wired in
  - a new "Authoring Mods in TypeScript" guide documents the canon: compile to ESM, use top-level exports, no external imports, no CommonJS

### Tooling & ergonomics

- added a reference Svelte fragment renderer under `examples/svelte-fragment-renderer/`: copy-adaptable host glue that renders inert fragment output (`html` + visibility + command-buffer dispatch) as Svelte, staying inside the inert-fragment wall (not a published package, not core-runtime code)
- fixed `@xriptjs/validate` and the CLI failing to locate `manifest.schema.json` from the published package, with a packaging regression test
- updated `@xriptjs/typegen` and `@xriptjs/docgen` for the new manifest surfaces (provider roles, record accessors, grant payloads)
- added a `namespace_builder` combinator for async namespaces and `add_mixed_namespace` (property values alongside callable functions) to the Rust runtime
- made the Rust runtime recurse into nested namespace members instead of silently dropping them
- fixed the Rust runtime swallowing uncaught throws in async workflows; a rejected top-level promise read as a successful `undefined`, but now surfaces the real rejection

### Test counts

| package | v0.4.2 | v0.5.0 |
|---------|--------|--------|
| `@xriptjs/sanitize` | 93 | 93 |
| `@xriptjs/validate` | 25 | 68 |
| `@xriptjs/typegen` | 31 | 52 |
| `@xriptjs/docgen` | 28 | 35 |
| `@xriptjs/init` | 34 | 41 |
| `@xriptjs/cli` | 29 | 38 |
| `@xriptjs/runtime` | 97 | 166 |
| `@xriptjs/runtime-node` | 97 | 165 |
| `xript-runtime` (Rust) | 48 | 125 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 35 | 35 |
| `Xript.Runtime` (C#) | 116 | 201 |
| **total** | **691** | **1077** |

## v0.4.2 — Sanitizer + Rust Runtime Fixes

- expanded the sanitizer's allowed element list across all four implementations (TypeScript, Rust/ammonia, C#)
  - added `button`, `progress`, `meter`, `output`, `fieldset`, and `legend`; `button` was the big miss since it's the primary element for `data-action` event handlers in fragments
  - added 14 SVG elements: `svg`, `g`, `defs`, `symbol`, `use`, `circle`, `ellipse`, `path`, `rect`, `line`, `polygon`, `polyline`, `text`, `tspan` for icons and data visualization in mod UIs
  - added `foreignObject`, `animate`, and `set` to the stripped elements list (dangerous SVG elements that shouldn't survive sanitization)
- added missing attributes: `open` for `<details>`, `low`/`high`/`optimum` for `<meter>`, plus 18 SVG attributes covering geometry and presentation
- fixed SVG attribute casing; `viewBox` and `preserveAspectRatio` were being lowercased by the tokenizer, which silently breaks SVG rendering in browsers
- updated the fragment spec documentation in `fragments.md` with the new element and attribute lists
- added 11 new conformance test cases to `spec/sanitizer-tests.json` and 11 new unit tests across the implementations
- fixed a serialization bug in `xript-runtime` (Rust) where `js_value_to_json` silently returned `Null` for objects and arrays from `execute()` (#89)
  - the fallback code evaluated `((v) => JSON.stringify(v))` which returned the function's _string representation_ instead of actually calling it with the value
  - replaced the broken eval with a proper `Function::call` through rquickjs's API
  - added 3 new tests for object, array, and nested object serialization

### Test counts

| package | v0.4.1 | v0.4.2 |
|---------|--------|--------|
| `@xriptjs/sanitize` | 71 | 93 |
| `@xriptjs/validate` | 25 | 25 |
| `@xriptjs/typegen` | 31 | 31 |
| `@xriptjs/docgen` | 28 | 28 |
| `@xriptjs/init` | 34 | 34 |
| `@xriptjs/cli` | 29 | 29 |
| `@xriptjs/runtime` | 97 | 97 |
| `@xriptjs/runtime-node` | 97 | 97 |
| `xript-runtime` (Rust) | 45 | 48 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 35 | 35 |
| `Xript.Runtime` (C#) | 116 | 116 |
| **total** | **666** | **691** |

## v0.4.1 — npm housekeeping

- added a README for `@xriptjs/cli` so the npm package page isn't a blank stare
- bootstrapped `@xriptjs/cli` on the npm registry; it was built and published in CI but had never been seeded locally, so npm didn't know it existed
- all eight `@xriptjs/*` packages now have READMEs on npmjs.com

## v0.4.0 — Unified CLI, Tier 4 & Rust Runtime

- consolidated five separate CLI tools into `@xriptjs/cli`, published as the `xript` command
  - `xript validate`, `xript typegen`, `xript docgen`, `xript init`, `xript sanitize` all route to the existing library packages
  - individual tool packages (`@xriptjs/validate`, `@xriptjs/typegen`, etc.) dropped their `bin` entries but remain published as libraries
  - one command to remember instead of five separate `npx xript-*` invocations
- added `xript scan`, a new subcommand that reads `@xript` and `@xript-cap` JSDoc tags from TypeScript source and generates manifest bindings and capabilities
  - spec document at `spec/annotations.md` defining the tag convention
  - scanner parses TypeScript ASTs via `ts-morph` (optional dependency; the CLI prompts if it's missing)
  - merge mode reads an existing manifest, adds new bindings, warns about removals, and auto-generates capability entries
  - outputs to stdout, to a file, or directly into an existing manifest with `--write`
- `xript-runtime` (Rust) gained three headline features
  - `load_mod()` now executes mod entry scripts after fragment validation (#87)
  - async host bindings with `Promise`/`await` support via `pollster` (#86); host functions return real Promises, JS callers can `await` them, chained awaits work
  - `XriptHandle`, a `Send + Sync` wrapper that owns an `XriptRuntime` on a dedicated thread, communicates via `mpsc` channels, mirrors the full runtime API (#88)
- introduced **tier 4 "Full Feature"** adoption tier covering slots, mod manifests, fragments, and the sandbox fragment API
  - updated adoption tiers docs, spec, vision, README, and CONTRIBUTING
  - `xript init` scaffolds tier 4 apps with slots, companion mod manifests, and fragment HTML
  - UI Dashboard example linked as the tier 4 reference implementation
- improved `@xriptjs/docgen` with two new flags
  - `--link-format no-extension` strips `.md` from generated links for static site generators that don't want them
  - `--frontmatter` injects YAML frontmatter into all generated files
- built the **Fragment Workbench** (#85), an interactive tool page on the docs site for building and testing xript UI fragments
  - tabbed workflow (Manifest, Author, Preview, Export) with collapsible inline guides
  - CodeJar syntax highlighting for manifest JSON and fragment HTML editors
  - slot contract panel, JSML toggle, validation-as-you-type, dynamic state simulation
  - Export tab with live mod manifest preview and one-click download
- overhauled the **Fragment Builder** demo
  - RPG dungeon theme ("Realm of Xript") with ASCII roguelike map
  - radio-pill slot selection, individual fragment close buttons, CodeJar editor
- added two new screens to `xript-wiz`
  - audit: capability coverage analysis showing ungated bindings, unused capabilities, capability gaps, and risk distribution
  - diff: compares the current manifest against the last git tag, surfacing added/removed bindings, capabilities, and slots
  - home menu expanded from 4 to 6 items
- consolidated docs site tool pages from 6 separate pages to 3 (CLI, TUI Wizard, Fragment Workbench)
  - unified CLI reference page with all subcommands, flags, examples, and programmatic API links
  - new TUI Wizard page with `Terminal.astro` component mockups for home, audit, and diff screens
  - added Annotations spec page to the Specification sidebar section
  - updated all four runtime doc pages with `loadMod`, fragment hooks, async bindings, and `XriptHandle`
  - fixed stale tool references (`xript-validate` to `xript validate`, etc.) across the entire docs site
- updated the publish pipeline for 8 npm packages (added `@xriptjs/cli`); `scripts/bump-version.mjs` now handles 14 files

### Test counts

| package | v0.3.1 | v0.4.0 |
|---------|--------|--------|
| `@xriptjs/sanitize` | 71 | 71 |
| `@xriptjs/validate` | 25 | 25 |
| `@xriptjs/typegen` | 31 | 31 |
| `@xriptjs/docgen` | 22 | 28 |
| `@xriptjs/init` | 27 | 34 |
| `@xriptjs/cli` | — | 29 |
| `@xriptjs/runtime` | 97 | 97 |
| `@xriptjs/runtime-node` | 97 | 97 |
| `xript-runtime` (Rust) | 31 | 45 |
| `xript-ratatui` | 58 | 58 |
| `xript-wiz` | 33 | 35 |
| `Xript.Runtime` (C#) | 116 | 116 |
| **total** | **608** | **666** |

## v0.3.1 — Publishing & Release Tooling

- fixed the docs deploy workflow; `@xriptjs/sanitize` wasn't being built before the runtime, so the docs site build was failing
- switched all publish workflows to fire on GitHub Release creation (`release: published`) with `workflow_dispatch` as a manual fallback
  - `publish.yml` (npm), `publish-nuget.yml`, and `publish-crates.yml` all use the same trigger pattern now
  - previously npm and NuGet were manual-only; crates.io had no workflow at all
- created `publish-crates.yml` for crates.io publishing
  - publishes `xript-runtime`, `xript-ratatui`, and `xript-wiz` in dependency order
- unified all 11 published packages (7 npm, 3 Rust crates, 1 NuGet) to version `0.3.1`
  - internal dependency references updated to match
- created `scripts/bump-version.mjs` (`npm run version:bump <version>`) to sync versions across all 12 package files
  - covers `package.json`, `Cargo.toml`, and `.csproj` files plus their internal dependency references
- created `scripts/release.mjs` (`npm run release`) to cut a GitHub Release from the current package version and matching `CHANGELOG.md` section
- added `readme`, `keywords`, and `categories` to `xript-ratatui` and `xript-wiz` Cargo.toml files; added `version` fields to path dependencies so `cargo publish` works
- wrote package READMEs for `@xriptjs/sanitize`, `xript-ratatui`, `xript-wiz`, and `Xript.Runtime` so they're not bare on their respective registries
- wired `PackageReadmeFile` in the C# `.csproj` so the README shows on nuget.org
- documented the full release process in `CLAUDE.md`

## v0.3.0 — Fragment Protocol

- introduced **mod manifests**: mods declare themselves, their capabilities, entry scripts, and UI fragment contributions in a single JSON file (`spec/mod-manifest.schema.json`)
- extended app manifests with **slots**: host-declared UI mounting points where mods contribute fragments
  - each slot declares accepted formats, capability gating, multiplicity, and styling mode (`inherit`, `isolated`, `scoped`)
- added the **fragment protocol** to the spec (`spec/fragments.md`): the full lifecycle for host-declared slots, mod-contributed UI, sanitization, data binding, conditional visibility, event routing, and the sandbox fragment API
  - `data-bind` for value binding: attributes persist in the DOM for O(1) updates at game-loop speed
  - `data-if` for conditional visibility: expressions evaluated by the same tier 1 engine
  - only two "smart" attributes; everything else goes through the sandbox fragment API
- built `@xriptjs/sanitize`: a pure string-based HTML sanitizer with no DOM dependency (`tools/sanitize/`)
  - works inside QuickJS WASM, Node, Deno, and browsers, anywhere
  - 45-case conformance test suite at `spec/sanitizer-tests.json` that all runtime implementations must pass
  - JSML support (`application/jsml+json`): JSON Markup Language as a native fragment format, no escaping needed
- added `loadMod()` to all four runtimes
  - `@xriptjs/runtime`: JS/WASM via QuickJS, JSML support, sandbox fragment API with command buffer pattern
  - `@xriptjs/runtime-node`: Node.js vm-based, same API surface
  - `xript-runtime` (Rust): `load_mod()` with ammonia-based sanitization, cross-validation, fragment hooks
  - `Xript.Runtime` (C#): `LoadMod()` with regex-based sanitization, Jint fragment hooks
- added the **sandbox fragment API** to the JS and Node runtimes: `hooks.fragment.update(id, callback)` with a command buffer proxy (`toggle`, `addClass`, `setText`, `setAttr`, `replaceChildren`)
- `@xriptjs/validate` gained mod manifest validation, auto-detection (app vs mod), and `--cross` flag for cross-validation against app slots
- `@xriptjs/typegen` now generates `FragmentProxy` interface, `hooks.fragment` namespace, and `XriptSlots` types
- `@xriptjs/docgen` produces slot documentation tables and a Fragment API reference page
- `@xriptjs/init` gained a `--mod` flag for mod project scaffolding: generates `mod-manifest.json`, fragment HTML, and entry script
- built `xript-ratatui`: a fragment renderer for Ratatui terminal applications (`renderers/ratatui/`)
  - parses `application/x-ratatui+json` fragment trees into native Ratatui widgets
  - layout engine, style mapper, color/modifier support, `data-bind`/`data-if` processing
  - reusable logo module with ANSI art rendered via `ansi-to-tui`
- built `xript-wiz`: an interactive TUI wizard for the xript toolchain (`tools/wiz/`)
  - dogfoods the xript ecosystem: app manifest with slots, fragments rendered by `xript-ratatui`
  - card-style menu with icons, tab-completion file input, scaffold form with toggle cards
  - validate, scaffold, and sanitize workflows
- added `examples/ui-dashboard/`: a full fragment protocol demo with two mods (health panel, inventory panel)
  - demonstrates `data-bind`, `data-if`, sandbox fragment API iteration, cross-validation, and mod loading
- added four new fragment format examples to the docs: HTML, JSML, Ratatui JSON, WinForms JSON
  - same health panel rendered in four formats showing the protocol is rendering-agnostic
- added 6 new docs pages: mod manifest spec, fragment protocol spec, fragment formats, sanitizer tool, UI dashboard example, Fragment Builder interactive demo
  - updated all tool docs pages (validator, typegen, docgen, init) with v0.3 features
  - sidebar expanded to 30 pages
- fixed a binding-name injection vulnerability in `evaluateCondition`: mod-authored binding names are now validated against a safe identifier pattern before interpolation
- created tracking issues for future fragment renderer packages (#76 hub, #77 xript-ratatui, #78 xript-winforms)

### Test counts

| package | v0.2 | v0.3 |
|---------|------|------|
| `@xriptjs/sanitize` | — | 71 |
| `@xriptjs/runtime` | 69 | 97 |
| `@xriptjs/runtime-node` | 71 | 97 |
| `xript-runtime` (Rust) | 17 | 31 |
| `xript-ratatui` | — | 58 |
| `xript-wiz` | — | 33 |
| `Xript.Runtime` (C#) | 72 | 116 |
| `@xriptjs/validate` | 11 | 25 |
| `@xriptjs/typegen` | 24 | 31 |
| `@xriptjs/docgen` | 17 | 22 |
| `@xriptjs/init` | 20 | 27 |
| **total** | **301** | **608** |
