---
title: Your first mod
description: Zero to a running, sandboxed mod in two files and three commands. No host application required.
---

This page takes you from nothing to a running mod: two files, three commands, and a sandbox doing the work. You don't need a host application yet; the CLI carries one for exactly this purpose.

## Before you start

You need two things, and the second one is the step people skip:

1. **Node.js 20 or newer.** Check with `node --version`. If that prints an error instead of a version, install Node from [nodejs.org](https://nodejs.org) first.
2. **The xript CLI.** Install it globally:

   ```sh
   npm install -g @xriptjs/cli
   ```

   Then confirm it answers:

   ```sh
   xript --version
   ```

:::note[Seeing `xript: command not found`?]
The CLI isn't installed yet; run the install command above. If you'd rather not install anything globally, every command on this page also works prefixed with `npx`: where we write `xript validate`, you write `npx xript validate`.
:::

## Two files

Make a folder anywhere and create these two files in it.

**`mod-manifest.json`**, what your mod is and what it offers:

```json
{
	"$schema": "https://xript.dev/schema/mod-manifest/v0.7.json",
	"xript": "0.7",
	"name": "hello-mod",
	"version": "1.0.0",
	"description": "My first mod.",
	"entry": {
		"script": "mod.js",
		"format": "module",
		"exports": {
			"greet": {
				"description": "Greets a name.",
				"params": [{ "name": "name", "type": "string" }],
				"returns": "string"
			}
		}
	}
}
```

**`mod.js`**, the code:

```js
export function greet(name) {
	return "hello, " + name + "!";
}
```

That's a complete mod. The manifest declares one invokable export; the script implements it as a plain ES module export. No build step, no dependencies, no config beyond what you see.

## Check it

From the folder you just made:

```sh
xript validate mod-manifest.json
```

Success looks like a single line:

```
✓ mod-manifest.json
```

If something's off, a typo'd field or a missing required property, the validator names the exact path and what it expected. Fix and re-run.

## Run it

```sh
xript run mod-manifest.json mod.js --export greet --args '["world"]'
```

This loads your mod into the real QuickJS sandbox, the same one a host application would use, invokes `greet`, and prints what happened:

```json
{
	"loaded": true,
	"logs": [],
	"declaredExports": ["greet"],
	"fragments": [],
	"provides": [],
	"result": "hello, world!"
}
```

`result` is your function's return value, round-tripped across the sandbox boundary. The mod ran with no filesystem, no network, and no host APIs beyond what a manifest grants — which here was nothing, because `greet` needed nothing.

## What just happened

xript evaluated `mod.js` as an ES module inside a sandbox, harvested the top-level `greet` export, and made it invokable by name. In a real application, the host loads your mod the same way and calls your exports the same way; the only difference is that a real host also offers **bindings** (functions you call), **slots** (places your UI mounts), and **capabilities** (permissions gating both). The mod you just wrote is the seed all of that grows from.

## Where to go next

- [Authoring against a host](/guidance/authoring/) — the full loop once a real host manifest enters the picture: read its surface, declare what you need, fill its slots
- [Module-format mods](/spec/modules/) — the rules your entry module plays by, including authoring in TypeScript with generated types
- `xript init --mod` — scaffolds a fuller mod project (TypeScript, fragments, a demo harness) when you outgrow two files
