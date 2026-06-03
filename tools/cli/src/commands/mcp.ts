import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(0);
	}

	const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version: string };
	const server = await createServer(pkg.version);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

function printHelp(): void {
	console.log("xript mcp — start the xript MCP server (stdio transport)");
	console.log("");
	console.log("Exposes the same capabilities as the CLI, plus xript's authoring doctrine, to MCP clients.");
	console.log("Configure your client to run: xript mcp");
	console.log("");
	console.log("Tools:     server-info, validate, cross-validate, typegen, docgen, sanitize, scaffold, scan, manifest-describe, run, guide");
	console.log("Resources: the xript spec docs and authoring guidance");
	console.log("Prompts:   adopt-xript, is-this-xript-native, choose-a-surface, author-a-mod");
}
