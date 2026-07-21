# xript-expr

The xript Expression Grammar (XEG): one total, pure expression language for `data-if`,
`data-bind`, and `{{ … }}` text interpolation in xript fragments.

Identifiers resolve only against a fill's declared bindings and calls resolve only against
a closed builtin table, so no production names a host global and no evaluation reaches a
value's methods. There is no code generation anywhere: the parser produces an AST and the
evaluator walks it.

Semantics are pinned by `spec/expression-tests.json` in the xript repository, which every
xript runtime and fragment renderer runs. This crate is consumed by both `xript-runtime`
and `xript-ratatui`; it is a separate crate so a terminal renderer does not have to take a
JavaScript engine along for the ride.

```rust
use serde_json::json;
use xript_expr::{evaluate, is_truthy};

let bindings = serde_json::from_value(json!({ "hp": 35, "maxHp": 100 })).unwrap();
assert!(is_truthy(&evaluate("hp / maxHp < 0.5", &bindings)));
```

## License

MIT
