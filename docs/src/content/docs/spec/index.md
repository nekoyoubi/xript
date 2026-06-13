---
title: Specification
description: The normative xript documents — manifest formats, the capability model, fragments, modules, and the conformance schemas.
---

The specification is the contract every runtime, tool, and host implements. The manifest is the center of gravity; everything else derives from it.

## Documents

- [Manifest](/spec/manifest/) — the app manifest: bindings, capabilities, types, slots, events, libraries
- [Manifest Inheritance](/spec/extends/) — `extends`: add-new, fill, refine, and the collision rules
- [Mod Manifest](/spec/mod-manifest/) — what a mod declares: capabilities, entry, and `fills` keyed by host slot id
- [Fragments](/spec/fragments/) — the inert-template protocol: `data-bind`, `data-if`, handlers, and the command buffer
- [Fragment Formats](/spec/fragment-formats/) — the format catalog a slot's `accepts` names
- [Capabilities](/spec/capabilities/) — default-deny grants, prefix subsumption, and the read/write mode lattice
- [Bindings](/spec/bindings/) — host functions and namespaces, error vocabulary, naming grammars
- [Hooks](/spec/hooks/) — event-typed slots and the dispatch contract
- [Module-Format Mods](/spec/modules/) — ES module entries, the import deny, and approved libraries
- [Host Harness](/spec/harness/) — synthetic hosts: stub bindings, journals, and replayable step scenarios
- [Debugging](/spec/debugging/) — the DAP-shaped debug protocol
- [Security](/spec/security/) — the sandbox guarantees and threat model
- [Annotations](/spec/annotations/) — `@xript` source annotations scanned into manifests

## Schemas

Every schema is served at its `$id` URL, with prior version ids resolving as aliases:

- [`/schema/manifest/v0.7.json`](/schema/manifest/v0.7.json) — the app manifest schema
- [`/schema/mod-manifest/v0.7.json`](/schema/mod-manifest/v0.7.json) — the mod manifest schema
- [`/schema/harness/v0.7.json`](/schema/harness/v0.7.json) and [`/schema/harness-steps/v0.7.json`](/schema/harness-steps/v0.7.json) — the harness descriptor and scenario shapes
- [`/schema/capability-prompt/v0.5.json`](/schema/capability-prompt/v0.5.json), [`/schema/install-descriptor/v0.5.json`](/schema/install-descriptor/v0.5.json), [`/schema/discovery-result/v0.5.json`](/schema/discovery-result/v0.5.json), [`/schema/debug-messages/v0.5.json`](/schema/debug-messages/v0.5.json) — the host-side data shapes

Point a manifest's `$schema` at the matching URL and editors pick up validation and autocomplete.
