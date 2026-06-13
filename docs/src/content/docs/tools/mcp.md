---
title: MCP Server
description: The xript MCP server — runs the toolchain and serves xript's authoring doctrine to agents.
---

The xript MCP server is a [Model Context Protocol](https://modelcontextprotocol.io) front-end built into `@xriptjs/cli`. It hands an agent the **same capabilities the CLI hands a human**, over one stdio connection: every command as a callable tool, the spec and authoring doctrine as resources, and reusable advisory prompts. Nothing forks. Each tool runs the exact code the matching CLI command runs, so the two can't drift.

Agents are first-class mod authors, and without the server they're flying blind. An agent writing a mod guesses at the manifest schema, can't validate without a human shelling out to the CLI, and answers theory questions from stale memory. The MCP closes that loop. Author, validate, run, and stay grounded in canon, all in one place.

## Run it

The server is a subcommand of the CLI:

```bash
xript mcp
```

Or run it without a global install, which is the convenient form for client configuration:

```bash
npx -y @xriptjs/cli mcp
```

Configure your MCP client to launch `xript mcp` (or `npx -y @xriptjs/cli mcp`) over stdio.

## Tools

| Tool | What it does |
|------|--------------|
| `xript_validate` | Validate an app or mod manifest (auto-detects which) |
| `xript_cross_validate` | Check a mod's capabilities, fills, and each fill's payload against a host's slots |
| `xript_typegen` | Generate TypeScript definitions from a manifest (`ambient` for the `xript` global) |
| `xript_docgen` | Generate markdown documentation from a manifest |
| `xript_sanitize` | Sanitize an HTML fragment and report what was stripped |
| `xript_scaffold` | Generate the files for a new app or mod project |
| `xript_scan` | Read `@xript` annotations from a source directory into bindings |
| `xript_manifest_describe` | Summarize exactly what a host exposes: bindings, hooks, slots, capabilities |
| `xript_run` | Load a mod into the QuickJS WASM sandbox and optionally invoke an export |
| `xript_host_load` | Create a persistent harnessed host session (stub bindings, capability grants, library sources) that survives across tool calls |
| `xript_host_step` | Run one step against a session: load-mod, invoke, emit, fire-hook, execute, resolve-slot, resolve-role |
| `xript_host_journal` | Read (optionally clear) a session's journal — binding calls, audit events, console logs |
| `xript_host_list` | List the live harnessed host sessions |
| `xript_host_unload` | Dispose a session and free its sandbox |
| `xript_score` | Score a host's moddability capacity: contract integrity, and how much extension surface it exposes |
| `xript_score_diff` | Diff a host's score against a saved baseline; toward or away from xript |
| `xript_lint` | Review a host + mods for actionable findings; the complement to `xript_score` |
| `xript_guide` | Read canonical authoring doctrine by topic |
| `xript_server_info` | Report the running server's name, version, build timestamp, and runtime |

`xript_manifest_describe` is the one to reach for first when authoring against a host. Point it at the host's manifest and it returns the surface the mod can call and contribute into, derived from the manifest rather than guessed.

`xript_server_info` reports the build timestamp from the running module's own file mtime, so a server process whose binary predates a change in the xript repo is detectable. If `builtAt` looks stale, rebuild and reconnect before trusting results.

### Paths or inline

Every tool that takes a manifest accepts **either a file path or the inline JSON**. Pass a path, absolute or relative to the client's workspace root, and the server reads the file itself, so a large manifest never has to ride through the tool-call tokens. A value that starts with `{` or `[` is treated as inline JSON; anything else is treated as a path. Relative paths resolve against the workspace root the client advertises, the same mechanism `xript_scan` uses; without a root, pass an absolute path.

## Resources

The server serves the xript spec straight from source, so an agent's answers can't drift from what the spec actually says:

- `xript://spec/{manifest,mod-manifest,capabilities,bindings,hooks,fragments,modules,security,vision,annotations,debug-protocol}`
- `xript://spec/{manifest-schema,mod-manifest-schema}`
- `xript://guidance/{when-to-use,surfaces,mod-zero,boundary,openness,authoring,hosting,tiers}`

## Prompts

Reusable advisory templates, each grounded in the doctrine:

| Prompt | Use it to |
|--------|-----------|
| `adopt-xript` | Decide whether a surface should be manifest-driven |
| `is-this-xript-native` | Audit whether a surface is genuinely extensible or hardcoded next to a manifest |
| `choose-a-surface` | Pick the right surface: binding, hook, slot, fragment, capability, or command |
| `author-a-mod` | Walk the authoring loop, optionally against a specific host manifest |

## Doctrine as data

The guidance the server serves is authored as content, not baked into the server. Editing a topic isn't a recompile; it's editing markdown. The same content backs the `xript_guide` tool and the `xript://guidance/*` resources, so there's exactly one source of truth for what xript recommends.
