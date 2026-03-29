# @xriptjs/cli

Unified CLI for the [xript](https://github.com/nekoyoubi/xript) ecosystem. One command to validate, generate, scaffold, sanitize, and scan.

[![npm](https://img.shields.io/npm/v/@xriptjs/cli)](https://www.npmjs.com/package/@xriptjs/cli)

## Install

```sh
npm install -g @xriptjs/cli
```

Or via `npx`:

```sh
npx xript <command> [options]
```

## Commands

### `xript validate <manifest.json>`

Validate manifests against the xript spec. Supports app manifests, mod manifests, and cross-validation between them.

```sh
xript validate manifest.json
xript validate app.json --mod mod.json
```

### `xript typegen <manifest.json>`

Generate TypeScript definitions from a manifest.

```sh
xript typegen manifest.json              # stdout
xript typegen manifest.json -o types.d.ts  # file
```

### `xript docgen <manifest.json>`

Generate markdown documentation from a manifest.

```sh
xript docgen manifest.json -o docs/
xript docgen manifest.json -o docs/ --link-format "[{name}]({url})"
```

### `xript init [name]`

Scaffold a new xript app or mod project.

```sh
xript init my-app          # interactive
xript init my-app --yes    # defaults, no prompts
xript init my-mod --mod    # mod project
```

### `xript sanitize <file.html>`

Sanitize HTML fragments for safe use in UI slots.

```sh
xript sanitize fragment.html
xript sanitize fragment.html --validate
```

### `xript scan <directory>`

Scan TypeScript source for `@xript` annotations and generate manifest bindings.

```sh
xript scan src/ --manifest manifest.json         # preview
xript scan src/ --manifest manifest.json --write  # update in place
```

## Documentation

[xript.dev](https://xript.dev): full docs, spec, runtime guides, and interactive demos.

## License

MIT
