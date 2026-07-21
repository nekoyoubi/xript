# Expressions (XEG)

**XEG** — the xript Expression Grammar — is the one expression language a fragment carries.
`data-if` evaluates it, `data-bind` evaluates it, and an `interpolate` fill evaluates it
inside `{{ … }}` in text. Every runtime and every fragment renderer implements the same
grammar with the same semantics, held to `spec/expression-tests.json`.

That corpus is the point of this document. Before it existed, "the expression in `data-if`"
meant five different things: `new Function` in the browser and Node runtimes, a `Jint`
engine in C#, a ladder of regexes in the Rust runtime, and a two-operand comparison helper
in the Ratatui renderer. `alive && health < 50` was true in a browser and silently `false`
in a terminal. Nothing caught it, because nothing asserted the five agreed.

## Production

```
expr           := ternary
ternary        := nullish ( "?" expr ":" expr )?
nullish        := or ( "??" or )*
or             := and ( "||" and )*
and            := equality ( "&&" equality )*
equality       := relational ( ("===" | "!==" | "==" | "!=") relational )*
relational     := additive ( ("<=" | ">=" | "<" | ">") additive )*
additive       := multiplicative ( ("+" | "-") multiplicative )*
multiplicative := unary ( ("*" | "/" | "%") unary )*
unary          := ("!" | "-" | "+") unary | postfix
postfix        := primary ( "." IdentName | "[" expr "]" )*
primary        := Number | String | "true" | "false" | "null"
                | Builtin "(" ( expr ("," expr)* )? ")"
                | Identifier
                | "(" expr ")"
```

`Identifier` resolves **only** against the fill's declared `bindings` map. `Builtin`
resolves **only** against the fixed table below. The two namespaces are disjoint and
position-determined: an identifier in call position is never looked up in bindings, and a
binding value is never callable. There is no syntax that reaches a host global, because
there is no production that yields one.

## What is deliberately absent

No assignment, no `++`/`--`, no comma operator, no `=>`, no `function`, no `new`, no
`typeof`/`in`/`instanceof`/`delete`, no regex literals, no template literals, no object or
array literals, no optional chaining, no bitwise operators, and no method calls on values.

Every XEG expression is a **total pure function of the bindings map**. It cannot mutate, it
cannot observe anything but its arguments, and it terminates: the grammar has no loop and
no recursion, so evaluation cost is bounded by AST size, which is bounded at parse time
(`maxExpressionNodes`, default 256).

A source outside the grammar is a parse error with a message that names the missing
capability — `hp = 1` says assignment is not in the grammar, `{{#if x}}` says block helpers
do not exist — rather than an anonymous syntax error two tokens later.

## Builtins

A closed table. Pure, total, no host access.

| | |
|---|---|
| numeric | `abs` `round` `floor` `ceil` `min(…)` `max(…)` `clamp(x,lo,hi)` `fixed(x,n)` |
| string | `upper` `lower` `trim` `pad(s,n,ch)` `slice(s,a,b)` |
| collection | `len` `has(coll,key)` `join(arr,sep)` `at(coll,i)` |
| coercion | `str` `num` `bool` |

Extensible only by spec revision. A host cannot register a builtin: that would be a
capability channel wearing a formatter's clothes, and formatting is not where a capability
boundary belongs.

Notes on the less obvious ones:

- `round` rounds half **up**, matching JavaScript's `Math.round`, not half-away-from-zero and
  not half-to-even. `round(-2.5)` is `-2`.
- `fixed(x, n)` returns a **string** with exactly `n` decimal places, rounding half away
  from zero, matching `Number.prototype.toFixed`.
- `pad(s, n, ch)` pads at the **start**, so numbers align right. `ch` defaults to a space.
- `has` reads as membership: substring for a string, element for an array, own key for an
  object. An inherited key is never found.
- `at` and `[…]` accept a negative index, counting from the end.

## Semantics

Deliberately **not** "whatever JavaScript does". "It's just JavaScript" is precisely how
five implementations drifted, so the corpus pins each rule:

- `+` is numeric addition when both sides are numbers, string concatenation when either side
  is a string, and `null` otherwise. No array-to-string coercion.
- `-`, `*`, `/`, `%` are defined on numbers only; anything else is `null`.
- Division or modulo by zero is `null`, not `Infinity` or `NaN`. Any non-finite result is
  `null`: a computation that leaves the reals leaves the value domain.
- Ordering comparisons are defined on two numbers or two strings. Mixed types yield `false`,
  not a coercion cascade.
- `==` is `===`. The loose form is accepted as a spelling of the strict one, so existing
  `data-if` bodies keep working; the corpus asserts identical results.
- Two arrays or two objects are never equal, even to themselves. XEG has no identity to
  compare, and structural equality over an unbounded value would make an expression's cost
  depend on the data rather than on the AST.
- Reading a member of `null`, a key an object does not own, or an index past the end yields
  `null`. Nothing throws.
- An undeclared identifier is a **validate-time error** and a runtime `null`.
- Truthiness follows JavaScript: `null`, `false`, `0`, `NaN`, and `""` are falsy; an empty
  array or object is truthy.
- Any evaluation failure yields `null`, which is falsy for `data-if` and renders as the
  empty string for `data-bind` and interpolation. No exception escapes an expression.

## `data-bind` is classified, not just accepted

`data-bind` accepts any XEG expression. A bare identifier is a member of the grammar, so
every `data-bind` written before this existed keeps working unchanged — no migration, no
deprecation, no second parse path.

The parser also **classifies** the body, and the classification is load-bearing:

- **`name`** — an lvalue. Two-way binding stays available: an `input` or `change` handler can
  push the value back through the binding's `path`. A bare name whose binding is absent
  writes nothing, so the fragment's authored fallback content survives.
- **`expression`** — read-only. A computed value has no inverse, so the runtime refuses to
  register write-back on it and `xript lint` reports a handler that tries as an error rather
  than silently dropping the write. An expression always writes, because a computed result
  has no "absent" state to fall back from; `null` renders as the empty string.

A bare name stays valid *and stays privileged*, because writability is a real property that
only a name has.

The computed value lands exactly where the node's vocabulary says a bound value lands —
into children as a single text node, or into the node's `bindTo` prop **through that prop's
sink**. An expression cannot reach a prop the vocabulary does not expose and cannot skip the
sink, because it produces a value and hands it to the same writer a bare name uses.

## Inline interpolation: `{{ expr }}`

A fill sets `"interpolate": true` to parse `{{ … }}` sites in its **text nodes**.

```html
<p>Health: {{ hp }}/{{ maxHp }} ({{ round(hp / maxHp * 100) }}%)</p>
<p>Status: {{ hp <= 0 ? 'down' : hp / maxHp < 0.2 ? 'critical' : 'fine' }}</p>
```

The inline conditional is XEG's ternary. It selects a **value**, never a branch of markup,
and that distinction is the whole reason it is admissible. There is no `{{#if}}…{{/if}}`
block form and there will not be: a block form selects markup, which is control flow, which
is [the hard wall](./fragments.md#hard-wall). The parser has no `#` production at all, so
`{{#if x}}` is a parse error that names the rule rather than a silently unsupported feature.

### Why it is opt-in

Not a preference — a compatibility requirement. A fragment published before this mode
existed may carry `{{` in prose or a code sample, and turning interpolation on globally
would change the meaning of an already-shipped mod. Opt-in makes those fragments
byte-identical by construction, and gives a documentation author the correct default: leave
it off and `{{` is never special.

The flag lives on the fill rather than on the format or the manifest root, because
interpolation is a property of the *source text*: one mod can legitimately have a status
fragment that interpolates and a help fragment that does not.

### The exact lexing rule

Within a text node, when `interpolate` is on:

1. The literal three-character sequence `\{{` emits a literal `{{` and consumes the
   backslash. This is the **only** escape sequence that exists, so a backslash anywhere else
   is an ordinary character: `C:\Users`, a `\n` in a code sample, and a lone `\` are all
   untouched.
2. Otherwise `{{` opens a site. The site closes at the first `}}`.
3. **An unclosed `{{` is literal text, not an error.** Prose that says "use `{{` to
   interpolate" and never closes it survives intact. This is the rule that makes the syntax
   safe for documentation fragments.
4. `}}` outside a site is always literal.
5. Single `{` and `}` are never special, anywhere.
6. A site that opens **and closes** but whose body is not an XEG expression is a
   validate-time error. Once both delimiters are present the author's intent is unambiguous,
   so failing loudly beats guessing. Contrast rule 3, where intent genuinely is ambiguous.
7. A nested `{{` inside a site is an error. XEG has no production containing a brace, so
   there is no legitimate nesting.

### Text nodes only

Attribute-value interpolation is **refused**, and the argument is specifically about sinks.

A prop's sink validates a **whole value**: `sanitizeUri` decides whether `href="…"` is
admissible by looking at the complete string. Interpolation would fragment that value into
pieces the sink never sees together:

```html
<a href="{{ scheme }}:{{ rest }}">        <!-- each half innocent; the join is not -->
<a href="javascript:{{ payload }}">       <!-- a literal half poisons the whole -->
<div style="width:{{ w }}px; {{ more }}"> <!-- CSS injection through a value slot -->
```

Making that safe would mean re-running the sink after every substitution on every binding
change, which is a *check* rather than a structural guarantee, and would still be wrong: a
sink that sees `javascript:alert(1)` cannot tell it was assembled from a trusted literal and
an untrusted value.

The correct surface for a computed attribute value already exists and is **wholesale**:
`data-bind` with the node's `bindTo` prop. One expression, one complete value, one sink
call, one validation. Widening `data-bind` and refusing attribute interpolation are the same
decision seen from two sides.

### How "value slot, never markup slot" is enforced

Two structural properties, neither of which is a check:

1. **Segmentation happens in the sanitizer, before the tree is validated.** The pipeline is
   `source → tokenize → tree → vocabulary check → segment text nodes`. Substitution happens
   later, in a runtime's bind pass, over the already-validated tree. There is no code path
   from a binding value back into the tokenizer, because the tokenizer has already run and
   is never called again. A value that itself contains `{{ … }}` is therefore inert text.
2. **A segment is a leaf.** An `expr` segment lives inside a text node, and a text node has
   no props and no children. There is no field a substituted value could land in that would
   make it an element or an attribute — not because the runtime declines to put it there,
   but because the type has nowhere to put it.

Concretely, `{{ evil }}` resolving to `<script>x</script>` yields a text node whose resolved
content is that eighteen-character string. The HTML projection escapes it on the way out and
a DOM host writes it with `textContent`. Both are already how a `data-bind` value reaches a
text node; interpolation adds no new sink and no new writer.

## Tree representation

A text node gains one optional field:

```ts
export type TextSegment =
  | { kind: "literal"; value: string }
  | { kind: "expr"; source: string };

export interface FragmentText {
  kind: "text";
  /** The authored source, escapes intact. Round-trips byte-exact through serialization. */
  value: string;
  /** Present iff the node opened at least one interpolation site. */
  segments?: TextSegment[];
}
```

- `value` stays the **authored source**, not a pre-rendered fallback, so
  `parse(serialize(parse(x)))` is lossless. The tree already carries serialization-only
  hints; `selfClosing` is the precedent.
- `segments` is **absent, not empty**, when there are no sites, so a non-interpolating
  fragment produces a tree identical to one parsed without the mode.
- A segment stores its **source**, not a serialized AST. The AST is a runtime concern with
  five implementations, and freezing its shape into the wire format would force every parser
  change through a tree-contract revision. Runtimes parse and cache per fill.
- The JSML array form gets the feature from the same parse: `["p", "Health: {{ hp }}"]` is a
  string child and segments identically.

## Conditions are keyed by position

`getContent()` returns a `conditions` array alongside the deprecated `visibility` map:

```ts
interface FragmentCondition {
  path: number[];      // child-index path into the bound tree
  expression: string;
  visible: boolean;
}
```

`visibility` is keyed by expression text, so two nodes carrying the same `data-if` collapse
into one entry and a host cannot map a result back to a node. Widening the expression
surface makes that collision more likely, not less. `visibility` stays populated
(last-write-wins, as before) and is deprecated.

## Tooling

- **`xript lint`** runs an `expressions` analyzer from `@xriptjs/validate` over the same AST
  the runtimes walk, reporting an unparseable body, an identifier no binding declares, a
  write-back handler aimed at a computed value, a declared binding nothing reads, and a
  well-formed site in a fill that never set `interpolate`.
- **`xript typegen --ambient`** emits a `XriptFragments` namespace with a per-fill bindings
  interface and a `keyof` alias, which is what an editor completes against inside `{{ … }}`,
  `data-if`, and `data-bind`. Binding value types come from the fill's optional `type` field;
  an absent type is `unknown`, and the type-aware lint checks stay silent rather than
  inventing a shape.

TypeScript cannot type-check a string embedded in markup, and faking it with
template-literal type gymnastics would produce error messages no author could read. So the
work splits: typegen emits the types, the analyzer does the checking.

## Conformance

`spec/expression-tests.json` holds the corpus every implementation runs:

| section | what it pins |
|---|---|
| `cases` | evaluation results, including every semantic rule above |
| `rejects` | sources that must fail to parse, and evaluate to `null` if asked anyway |
| `interpolation` | segmentation, the escape, the unclosed-`{{` literal rule, and the site errors |
| `safety` | that a resolved value cannot introduce markup, escape its text node, or re-enter the tokenizer |
| `attributes` | that an attribute value is never segmented and never reaches a sink it was not declared for |
| `conditions` | that `data-if` results are addressed by tree position |
| `bind` | which `data-bind` bodies are writable |

The `safety` and `attributes` sections are written to fail against an implementation that
substitutes values into the source string and re-parses. That is the failure mode the design
is built to make impossible, so it is the one the corpus checks hardest.
