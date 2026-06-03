#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
	const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
	return pkg.version;
}

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

if (!command || command === "--help" || command === "-h") {
	printHelp();
	process.exit(command ? 0 : 1);
}

if (command === "--version" || command === "-v") {
	console.log(getVersion());
	process.exit(0);
}

switch (command) {
	case "validate":
		await (await import("./commands/validate.js")).run(commandArgs);
		break;
	case "typegen":
		await (await import("./commands/typegen.js")).run(commandArgs);
		break;
	case "docgen":
		await (await import("./commands/docgen.js")).run(commandArgs);
		break;
	case "init":
		await (await import("./commands/init.js")).run(commandArgs);
		break;
	case "sanitize":
		await (await import("./commands/sanitize.js")).run(commandArgs);
		break;
	case "scan":
		await (await import("./commands/scan.js")).run(commandArgs);
		break;
	case "run":
		await (await import("./commands/run.js")).run(commandArgs);
		break;
	case "guide":
		await (await import("./commands/guide.js")).run(commandArgs);
		break;
	case "describe":
		await (await import("./commands/describe.js")).run(commandArgs);
		break;
	case "score":
		await (await import("./commands/score.js")).run(commandArgs);
		break;
	case "score-diff":
		await (await import("./commands/score-diff.js")).run(commandArgs);
		break;
	case "lint":
		await (await import("./commands/lint.js")).run(commandArgs);
		break;
	case "mcp":
		await (await import("./commands/mcp.js")).run(commandArgs);
		break;
	default:
		console.error(`Unknown command: ${command}`);
		console.error("");
		printHelp();
		process.exit(1);
}

function printHelp(): void {
	const version = getVersion();
	console.log(`xript v${version} — extensible runtime interface protocol tooling`);
	console.log("");
	console.log("Usage: xript <command> [options]");
	console.log("");
	console.log("Commands:");
	console.log("  validate   Validate manifests against the xript spec");
	console.log("  typegen    Generate TypeScript definitions from a manifest");
	console.log("  docgen     Generate markdown documentation from a manifest");
	console.log("  init       Scaffold a new xript app or mod project");
	console.log("  sanitize   Sanitize HTML fragments for use in UI slots");
	console.log("  scan       Scan TypeScript source for @xript annotations");
	console.log("  run        Run a mod in the sandbox and optionally invoke an export");
	console.log("  describe   Summarize what a host manifest exposes");
	console.log("  score      Score a host's extensibility (contract + surface use)");
	console.log("  score-diff Compare a host's score against a saved baseline");
	console.log("  lint       Review a host/mod fit for actionable findings");
	console.log("  guide      Print xript authoring doctrine");
	console.log("  mcp        Start the MCP server (the CLI's capabilities, for agents)");
	console.log("");
	console.log("Options:");
	console.log("  --help, -h     Show help (use with a command for command-specific help)");
	console.log("  --version, -v  Show version");
	console.log("");
	console.log("Examples:");
	console.log("  xript validate manifest.json");
	console.log("  xript typegen manifest.json -o types.d.ts");
	console.log("  xript docgen manifest.json -o docs/");
	console.log("  xript init my-app --yes");
	console.log("  xript sanitize fragment.html");
	console.log("  xript scan src/ --manifest manifest.json --write");
	console.log("  xript run mod.json entry.js --export greet --args '[\"world\"]'");
	console.log("  xript describe manifest.json");
	console.log("  xript score host.json mods/*.json --min 70");
	console.log("  xript score-diff baseline.json host.json mods/*.json --min-delta 0");
	console.log("  xript lint host.json mods/*.json --strict");
	console.log("  xript guide surfaces");
	console.log("  xript mcp");
}
