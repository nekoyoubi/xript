# xript — Vision

**eXtensible Runtime Interface Protocol Tooling**

---

## The Problem

Software is closed by default.

Every application is an island. Every game reinvents modding from scratch — or doesn't bother. Every tool locks its users into whatever the original developers imagined. And when extensibility does exist, it's bespoke: a unique API, a unique sandbox (or none at all), a unique set of conventions that modders must learn from zero.

The result is a world where the people who *use* software have no voice in how it *works*.

The Elder Scrolls series proved something decades ago: when you give a community the tools to extend your work, they don't just use it — they *sustain* it. Skyrim lives not because Bethesda perfected it, but because they had the foresight to let others finish what they started. Modders turned a game into a living ecosystem.

That principle shouldn't be limited to one franchise, or to games at all.

---

## The Vision

**Every application should be moddable. xript exists to make that inevitable.**

xript is not a programming language. It is a *platform specification* — a standard for how software exposes functionality to its users in a safe, consistent, and well-documented way.

Users write JavaScript. They already know it, their tools already support it, and LLMs already speak it fluently. xript doesn't reinvent the language. It standardizes *everything else*: the bindings, the capability model, the sandboxing guarantees, the documentation, and the tooling.

When an application is xript-enabled, modders get:

- A familiar language with nothing to install
- Type-safe bindings with editor support
- Beautiful, generated documentation
- A sandbox they can't escape and don't need to fear
- Confidence that their work won't break the host — or anyone using it

When a developer integrates xript, they get:

- A declarative manifest that *is* the documentation
- Sandboxed execution with fine-grained capability gating
- Generated types, docs, and validation — from a single source of truth
- A growing community of modders who already know the system

---

## Guiding Principles

### 1. The Modder Is the Customer's Customer

Every decision flows through one question: *How does this affect the person writing the script?*

Integrators adopt xript to access a community of modders. Modders stay because the experience respects their time. The modder's joy is the entire flywheel.

### 2. Safety Is Not Optional

Extensibility without safety is a liability. xript-enabled applications guarantee:

- **No escape from the sandbox.** Scripts cannot access anything the host hasn't explicitly exposed.
- **No denial of service.** Execution limits prevent runaway scripts.
- **No implicit trust.** Capabilities are denied by default and granted deliberately.
- **No eval.** Ever.

A user running someone else's mod should never have to wonder if it's safe. It is safe. That's the contract.

### 3. The Manifest Is the Product

The xript manifest is not configuration — it *is* the API. It defines bindings, capabilities, types, descriptions, and examples in one place. From it, everything else is derived:

- Documentation sites
- TypeScript definitions
- Validation rules
- Interactive playgrounds (planned)

If it's not in the manifest, it doesn't exist. If it is, it's documented, typed, and enforceable.

### 4. Incremental Adoption, Always

No application should need to go all-in. xript is useful at every level of commitment:

- **Expressions only** — Safe eval replacement. Five minutes to integrate.
- **Simple bindings** — Expose a few functions. An afternoon.
- **Full scripting with capabilities** — The complete model. A few days.

Each level stands on its own. Each level is a reason to adopt.

### 5. The Language Is Commodity

JavaScript is the runtime language — not because it's perfect, but because it's *known*. Modders don't want to learn a new syntax to add a feature to their favorite app. They want to open an editor and start writing.

xript's value is never in the syntax. It is in the bindings, the safety model, the tooling, and the ecosystem.

### 6. Standards Outlive Implementations

The xript specification is more important than any single runtime. Runtimes will come and go — QuickJS today, something else tomorrow. The spec endures.

A manifest written for xript-spec v1.0 should be implementable in any language, on any platform, for decades. That's the bar.

### 7. Documentation Is Not an Afterthought

If a modder can't find how to use a binding, it doesn't matter that it exists. xript treats documentation as a first-class output — generated, versioned, and always in sync with the manifest.

The quality of xript.dev and every generated doc site is as much a part of the product as the runtime itself.

---

## The Analogy

**xript is the USB of software extensibility.**

Before USB, every device had its own connector, its own driver model, its own limitations. After USB, you plug things in and they work.

Before xript, every application reinvents extensibility from scratch — or ships without it. After xript, developers declare a manifest and their software becomes a platform. Modders learn one system and can extend *anything*.

---

## What xript Is

- A specification for declaring extensibility manifests
- A capability-based security model for sandboxed scripting
- A toolchain for generating documentation, types, and interactive demos
- A set of runtime implementations for major platforms
- A community standard for moddable software

## What xript Is Not

- A programming language
- A general-purpose application framework
- A replacement for WebAssembly components
- A build system, database, or deployment platform

---

## The Measure of Success

xript succeeds when:

- A modder can look at any xript-enabled application and immediately know how to extend it.
- A developer can make their application moddable in an afternoon.
- A community can sustain and transform a product beyond what its creators imagined.
- The question changes from *"Can users extend this?"* to *"Why can't they?"*

---

*xript.dev — mod the it*
