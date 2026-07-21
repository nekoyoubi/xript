# xript-tree

The `xript-tree/1` contract: the engine-free node, condition, diagnostic, and op shapes a fragment renderer consumes.

A renderer walks a tree it is handed and draws it. It does not load mods, hold capabilities, evaluate expressions, or own storage. This crate carries the types that make that sentence true, without dragging a JavaScript engine along with them.

See `spec/renderers.md` for the normative contract.
