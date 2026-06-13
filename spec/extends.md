# Manifest Extension and Inheritance

A manifest may build on one or more base manifests via the optional top-level `extends` field. Inheritance lets a family of manifests share a common floor, a **base manifest** that declares the surface every consuming host has in common, while each consuming host extends that floor with its own additions, fills, and refinements.

This document is the normative reference for the `extends` model: the canon-as-base premise, resolution order, abstract types, the three inheritance moves, the `refines` marker, the collision guard, and the `abstract-type-unfilled` lint.

## Canon as a Base Manifest

A base manifest is a plain data file: an ordinary, schema-valid manifest with no special status. It is sometimes called *canon*: a shared floor that a group of related manifests agree to build on. Canon declares the bindings, capabilities, slots, and types the group holds in common, and nothing in the base is a cage; a consuming host is always free to add surface the base never knew about.

A consuming host (an **extending manifest**) opts in by naming the base:

```jsonc
{
  "xript": "0.7",
  "extends": "./base.json",
  "name": "consuming-host",
  "types": { /* additions, fills, and refinements over the base */ }
}
```

The base has no knowledge of its extenders. Inheritance flows one way: a base is authored standalone, and any number of siblings may extend the same base independently.

## Resolution

`extends` is a path string or an array of path strings, resolved **before** schema validation, identically by loaders and tools. Resolution flattens base-then-child:

- A base is resolved first (recursively, since a base may itself `extends` another).
- The child is then merged on top.
- When `extends` is an array, bases merge left-to-right; the child applies last.

The result is a single flat, schema-valid manifest. The runtime never sees `extends` after resolution; inheritance is a build-time concern, not a runtime one.

- **Maps** (`bindings`, `capabilities`, `hooks`, `types`) are key-merged.
- **Slots** append, keyed by `id`.
- **Scalars** (`name`, `version`, `title`, `description`, `xript`) are child-wins.
- **Paths** are relative to the extending manifest's location. Remote and URL bases are not supported in this version.
- **Cycles error.** A transitive `extends` chain that loops back on itself is a resolution error.

How a name that appears in *both* base and child is resolved depends on which of the three moves applies.

## Abstract Types

A type definition carrying `"abstract": true` is **declared, described, and contract-bearing, but unpopulated**. It supplies neither `fields` nor `values`; it is a typed hole the base leaves open for an extending manifest to fill.

```json
{
  "types": {
    "StatusCode": {
      "description": "A host-defined code classifying the outcome of an operation.",
      "abstract": true
    }
  }
}
```

An abstract type is a *contract*: the base may reference it from concrete surface (a binding return type, a slot's payload schema, another type's field) without committing to its shape. Each extending manifest decides what the contract is filled with.

```json
{
  "types": {
    "StatusCode": {
      "description": "A host-defined code classifying the outcome of an operation.",
      "abstract": true
    },
    "Envelope": {
      "description": "A response wrapper every operation returns.",
      "fields": {
        "status": { "type": "StatusCode", "description": "The outcome classification." },
        "payload": { "type": "string", "optional": true, "description": "The result body, when present." }
      }
    }
  }
}
```

Here the base declares an abstract `StatusCode` and a concrete `Envelope` whose `status` field references it. `Envelope` is complete; `StatusCode` is a hole. An extending manifest must fill `StatusCode` before the resolved manifest is sound; see [the lint](#linting). A slot's payload schema may likewise reference an abstract type by name; the reference resolves to the concrete fill once the extending manifest supplies it.

## The Three Moves: Add, Fill, Refine

When an extending manifest declares a name, exactly one of three moves applies. The moves are distinguished by **intent**, signalled by what the base declared and by the markers the child carries.

### 1. Add New

The child declares a type, slot, or capability name the **base never declared**. This is purely additive: no marker, no collision, no ceremony. A sibling is free to declare whatever the base does not know about; canon is a shared floor, never a cage.

```json
{
  "types": {
    "RetryPolicy": {
      "description": "How a consuming host retries a failed operation.",
      "fields": {
        "maxAttempts": { "type": "number", "default": 3 },
        "backoff": { "type": "string", "enum": ["fixed", "exponential"], "default": "exponential" }
      }
    }
  }
}
```

`RetryPolicy` is unknown to the base, so it simply joins the resolved manifest. This is the existing, unchanged behavior.

### 2. Fill

The child redeclares an **abstract** base type name, supplying concrete `fields` and/or `values`. This is **allowed without any marker**: the base being abstract *is* the opt-in signal. The concrete child definition replaces the abstract stub in the resolved manifest.

```json
{
  "extends": "./base.json",
  "name": "consuming-host",
  "types": {
    "StatusCode": {
      "description": "The set of outcome codes this host recognizes.",
      "values": ["ok", "retry", "denied", "error"]
    }
  }
}
```

After resolution, `StatusCode` is the concrete enum above, and the base's `Envelope.status` reference now resolves to it. Each sibling that extends the same base may fill `StatusCode` with a different concrete shape; the contract is shared, the fill is local.

### 3. Refine

The child redeclares a **concrete** base type (or slot) name carrying `"refines": true`. The child **deep-merges onto the base**: child members win key-by-key, and base members the child omits are retained.

```json
{
  "extends": "./base.json",
  "name": "consuming-host",
  "types": {
    "Envelope": {
      "refines": true,
      "fields": {
        "payload": { "type": "string", "description": "The result body, always present in this host." },
        "traceId": { "type": "string", "description": "Correlation id for this host's tracing." }
      }
    }
  }
}
```

After resolution, `Envelope` retains the base's `status` field, takes the child's overridden `payload` field, and gains the new `traceId` field. The child did not have to restate `status` to keep it.

Without `refines: true`, redeclaring a concrete base name is an **error**; see [collisions](#collisions). The marker is a deliberate opt-in: refinement is intentional, so a refine must say so.

## Deep-Merge Semantics

Refinement deep-merges recursively over `fields`:

- For each field, a child field **replaces** the base field of the same key.
- Base fields the child does not mention are **retained**.
- A field whose value is itself an object is merged recursively by the same rule.
- `values` (enum members) and any other array members are replaced **wholesale**; there is no element-wise array merge.

The `refines` marker itself is consumed during resolution and does not appear in the resolved manifest.

Slots refine by the same shape. A child slot redeclaring a base slot `id` is permitted only with `"refines": true`, and deep-merges onto the base slot, including its `payload` JSON Schema. The merged slot keeps the base's fields the child omits and takes the child's overrides; the `payload` contract itself deep-merges key-by-key like any other object. A base declares the payload its slot fills must satisfy, and an extender tightens it:

```json
{
  "extends": "./base.json",
  "name": "consuming-host",
  "slots": [
    {
      "id": "event.commit",
      "refines": true,
      "payload": {
        "required": ["id", "author"],
        "properties": {
          "author": { "type": "string", "description": "Who authored the commit." }
        }
      }
    }
  ]
}
```

If the base slot's payload was `{ "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } }`, the resolved slot keeps `type` and the base `id` property, takes the child's `required` array wholesale, and gains the `author` property; the schema merges by the same per-key rules as any other object.

## Collisions

A concrete-name collision that is **not** opted into is a hard guard against accidents:

- A child redeclaring a **concrete** base type name **without** `refines: true` is a resolution error.
- A child redeclaring a base **slot** `id` **without** `refines: true` is a resolution error.
- A child redeclaring a base `binding`, `capability`, or `hook` name is a resolution error; these maps are collision-as-error throughout, and fill and refine are type and slot concerns.
- A cross-base collision (two bases in an `extends` array declaring the same concrete name) is a resolution error.

These errors are thrown at resolution time, before validation and before lint. They are not warnings and cannot be suppressed; silently overriding inherited surface is exactly the accident the guard exists to catch. To override deliberately, fill an abstract type or refine a concrete one.

## Linting

Resolution tracks **provenance**: which surface in the resolved manifest is local to the child and which was inherited from a base. One lint draws on that provenance.

- **`abstract-type-unfilled`** (severity: **error**) — a resolved host that inherits an abstract type and leaves it abstract (never fills it) is a defect. An abstract type is a contract hole; shipping a host with the hole still open means a referenced type has no concrete shape. Fill it, or stop inheriting it.

A locally-declared abstract type is **not** flagged; declaring an abstract type for one's own extenders to fill is legitimate authorship, not a defect. The lint fires only when the abstract type was *inherited* and left unfilled.

A filled or refined inherited surface is **legitimately used**. Filling an abstract type or refining a concrete one must not trip dead-slot or vestigial-capability findings; the inherited surface is in active use, not vestigial.
