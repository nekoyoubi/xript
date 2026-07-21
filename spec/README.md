# xript Specification

The xript specification defines how applications expose functionality to scripts in a safe, consistent, and well-documented way.

## Contents

- [vision.md](./vision.md): the guiding vision for xript
- [manifest.md](./manifest.md): the manifest format specification
- [manifest.schema.json](./manifest.schema.json): the manifest JSON Schema
- [capabilities.md](./capabilities.md): the capability model
- [bindings.md](./bindings.md): binding conventions and type mapping
- [hooks.md](./hooks.md): hook conventions, lifecycle phases, and registration
- [commands.md](./commands.md): the command slot kind (`application/x-xript-command`), bound arguments, resolution, and invocation
- [security.md](./security.md): security guarantees and conformance checklist
- [fragments.md](./fragments.md): the fragment protocol (the semantics of fragment-format slots)
- [fragment-formats.md](./fragment-formats.md): fragment-format vocabularies, the prop-sink safety model, and the tree contract
- [expressions.md](./expressions.md): the xript Expression Grammar (XEG) behind `data-if`, `data-bind`, and `{{ }}` interpolation
- [mod-manifest.md](./mod-manifest.md): the mod manifest format (capabilities, entry, and the `fills` contribution surface)
- [mod-manifest.schema.json](./mod-manifest.schema.json): the mod manifest JSON Schema
- [sanitizer-tests.json](./sanitizer-tests.json): HTML sanitizer conformance test suite
- [command-tests.json](./command-tests.json): command slot conformance corpus (branch order, normalization, bound args, resolution)
- [expression-tests.json](./expression-tests.json): expression conformance corpus (evaluation, refused sources, interpolation, and the safety cases)
