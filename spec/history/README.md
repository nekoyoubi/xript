# Released schemas

A published schema URL is immutable. Once `https://xript.dev/schema/<family>/vN.json` has served a document, that document is what every manifest pinned to it was validated against, and it must keep serving byte-for-byte forever.

This directory holds those frozen documents. Each file is committed, never generated, and named for the version segment of its own `$id`. The docs build copies them verbatim into `docs/public/schema/<family>/` and emits only the *current* `spec/*.schema.json` at the alias its own `$id` names. `docs/scripts/check-schema-aliases.mjs` fails the build if any emitted file's `$id` disagrees with its filename.

Editing a file here is a change to a document the world has already consumed. Cutting a new schema version means adding a new file, not touching an old one.

## Provenance

| Alias | Extracted from |
| --- | --- |
| `manifest/v0.8.json` | tag `v0.8.1` |
| `manifest/v0.7.json` | tag `v0.7.0` |
| `manifest/v0.6.json` | tag `v0.6.0` |
| `manifest/v0.3.json` | tag `v0.5.0` |
| `mod-manifest/v0.8.json` | tag `v0.8.1` |
| `mod-manifest/v0.7.json` | tag `v0.7.0` |
| `mod-manifest/v0.6.json` | tag `v0.6.0` |
| `mod-manifest/v0.3.json` | tag `v0.5.0` |

The `v0.3` aliases come from `v0.5.0` rather than `v0.3.0` because the `v0.3` `$id` went unbumped across the `v0.3.0` through `v0.5.0` releases while the schema behind it kept growing. `v0.5.0` is the last release that published that `$id`, so its document is the final state of that URL, and it is a superset of the earlier one.

There is no `manifest/v0.1.json`. No release ever published a schema under that `$id`, and the docs build previously served the then-current schema at that filename. The alias is gone rather than fabricated.

Families whose current `$id` has never been superseded (`capability-prompt`, `install-descriptor`, `discovery-result`, `debug-messages`, `harness`, and `harness-steps`) have no entry here; the live spec file is still the document that alias serves.
