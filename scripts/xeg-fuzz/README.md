# XEG differential fuzzer

XEG has three implementations held to one corpus: TypeScript (`tools/sanitize`, used by the JS
and Node runtimes), Rust (`crates/xript-expr`, used by the Rust runtime and the Ratatui
renderer), and C# (`Xript.Runtime`). The corpus pins the cases someone thought of. This tool
looks for the ones nobody did: it generates expressions, interpolation texts, and `data-each`
headers, runs each through all three, and reports every case where they disagree.

```sh
npm run fuzz:xeg                               # 5000 cases, random seed, all three implementations
npm run fuzz:xeg -- --seed 42 --count 50000    # a reproducible large run
npm run fuzz:xeg -- --seed 42 --case 1234      # replay one case
npm run fuzz:xeg -- --impls ts,rust            # compare a subset
npm run fuzz:xeg -- --ts-only --count 20000    # TypeScript invariants only (no Rust or .NET needed)
```

Needs Node, a Rust toolchain, and the .NET 8 SDK for a full run. The first run builds
`tools/sanitize`, the `xeg_fuzz` example in `crates/xript-expr` (release), and the console
project in `csharp/`; `--no-build` skips that.

## What it compares

| case | compared |
|---|---|
| expression | parse acceptance, `kind` (`name` or `expression`), the names read, node count, the value, `str()` of it, and `data-if` truthiness |
| interpolation text | the segments, whether any site is an error, and the resolved text |
| `data-each` header | acceptance, the item and index names, the expression source, and the items it repeats |

Numbers compare exactly (`-0` and `0` are equal; no XEG operation tells them apart). A result
outside the value domain (a non-finite number, a host type) is tagged so it shows up as a
difference rather than as `null`. Strings compare after replacing lone surrogates with U+FFFD:
inside an expression every implementation holds UTF-16 exactly, but a Rust `String` cannot
hold a lone surrogate, so one leaves `xript-expr` as U+FFFD.

## Known divergences

`known.mjs` lists divergences that are understood and waiting on a decision. A matching case
is reported under `known:` with the reason and does not fail the run, so a clean run means
nothing new turned up. Delete an entry when its decision lands, and the fuzzer holds the fix.

## What it generates

Random ASTs over the whole production, printed with and without parentheses so precedence is
exercised; number forms (`.5`, `5.`, `1.e5`, `1e999`, hex-looking, overlong); string escapes
including surrogate pairs and lone surrogates; member and index access with negative,
fractional, huge, and string-numeric keys; calls with wrong arity; whitespace outside ASCII;
sources aimed at the node cap and nesting depth; random edits that make a source malformed;
and random bindings with astral and case-mapping-sensitive strings, extreme floats, nested
arrays and objects, and keys like `__proto__` and `constructor`.

Every case is a pure function of `(seed, index)`, so `--seed S --case I` replays it. Each
group of divergences prints a minimal reproduction, shrunk by deleting source characters and
binding values while the same implementation keeps disagreeing.

## When it finds something

The TypeScript implementation is canonical: it is what the web runtimes run, and the spec
follows JavaScript. Move Rust or C# to what TypeScript does, unless TypeScript is not total
(it throws) or not deterministic; when TypeScript itself looks wrong, record it in
`known.mjs` and raise it rather than changing it. Then pin the minimal case in
`spec/expression-tests.json` so every implementation is held to it from then on.

`--ts-only` checks what TypeScript can check alone: that nothing throws out of the evaluator,
segmenter, or header parser, that a value is never non-finite, and that rendering and
truthiness agree with the value. It takes a couple of seconds for 20000 cases, and CI runs it
with a fixed seed after the sanitizer's tests.
