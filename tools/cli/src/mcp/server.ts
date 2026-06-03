import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export const SERVER_NAME = "xript";

/**
 * When the running server binary was built, taken from this module's own file
 * mtime. A consumer comparing it against the repo can tell whether the process
 * is behind the source — no git or build step required.
 */
function buildTimestamp(): string {
	try {
		return statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
	} catch {
		return "unknown";
	}
}

export async function createServer(version: string): Promise<McpServer> {
	const server = new McpServer({ name: SERVER_NAME, version });
	registerTools(server, { name: SERVER_NAME, version, builtAt: buildTimestamp() });
	await registerResources(server);
	registerPrompts(server);
	return server;
}
