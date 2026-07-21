# xript Examples

Example manifests and integrations demonstrating xript in action.

## Examples

- [expression-evaluator/](./expression-evaluator/): tier 1 "safe eval replacement" with interactive REPL and demo script
- [plugin-system/](./plugin-system/): tier 2 plugin system with namespaces, capabilities, and custom types
- [game-mod-system/](./game-mod-system/): tier 3 dungeon crawler modding system with namespaces, capabilities, async bindings, custom types, and execution limits
- [ui-dashboard/](./ui-dashboard/): the UI Fragment Protocol -- a host declares slots, mods contribute HTML fragments with `data-bind` and `data-if`
- [fragment-vocabulary/](./fragment-vocabulary/): a host declaring its own typed fragment vocabulary -- mods author UI as a node tree, and `validate`/`typegen`/`docgen` treat the vocabulary as a checked, typed, documented contract
- [svelte-fragment-renderer/](./svelte-fragment-renderer/): rendering `fills` natively in a Svelte host, no conversion shims
