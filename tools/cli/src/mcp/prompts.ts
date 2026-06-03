import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadGuidanceTopic } from "../guide.js";

async function topicBody(id: string): Promise<string> {
	const loaded = await loadGuidanceTopic(id);
	return loaded ? loaded.body : "";
}

function userMessage(text: string) {
	return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
	server.registerPrompt(
		"adopt-xript",
		{
			title: "Adopt xript for a surface",
			description: "Decide whether a surface should be manifest-driven, grounded in xript's doctrine.",
			argsSchema: { context: z.string().optional().describe("What you're building or considering.") },
		},
		async ({ context }) => {
			const when = await topicBody("when-to-use");
			const modZero = await topicBody("mod-zero");
			const head = context ? `Consider this surface:\n\n${context}\n\n` : "";
			return userMessage(
				`${head}Decide whether it should be composed from a manifest, scripts, and fragments rather than hardcoded in the host. Ground your answer in xript's doctrine below. Lead with the manifest shape, then the trade-off, then a clear recommendation.\n\n---\n\n${when}\n\n---\n\n${modZero}`,
			);
		},
	);

	server.registerPrompt(
		"is-this-xript-native",
		{
			title: "Is this xript-native?",
			description: "Audit whether a proposed surface is genuinely manifest-driven or just hardcoded next to a manifest.",
			argsSchema: { surface: z.string().describe("The surface or implementation to audit.") },
		},
		async ({ surface }) => {
			const when = await topicBody("when-to-use");
			const modZero = await topicBody("mod-zero");
			return userMessage(
				`Audit this surface for xript-nativeness:\n\n${surface}\n\nApply the mod-zero test: could the host's own version be reimplemented as an external mod through the declared surface? If not, name the missing binding, slot, hook, or capability. Proximity to a manifest is not the same as being manifest-driven.\n\n---\n\n${when}\n\n---\n\n${modZero}`,
			);
		},
	);

	server.registerPrompt(
		"choose-a-surface",
		{
			title: "Choose an extensibility surface",
			description: "Pick the right xript surface — binding, hook, slot, fragment, capability, or command — for a need.",
			argsSchema: { need: z.string().describe("What you want to make extensible.") },
		},
		async ({ need }) => {
			const surfaces = await topicBody("surfaces");
			return userMessage(
				`Pick the right xript surface for this need:\n\n${need}\n\nName the canonical surface and sketch the manifest entry first. Use the vocabulary below; do not invent a synonym.\n\n---\n\n${surfaces}`,
			);
		},
	);

	server.registerPrompt(
		"author-a-mod",
		{
			title: "Author a mod against a host",
			description: "Walk the authoring loop for a mod, optionally grounded in a specific host manifest.",
			argsSchema: { hostManifest: z.string().optional().describe("The host manifest JSON to author against.") },
		},
		async ({ hostManifest }) => {
			const authoring = await topicBody("authoring");
			const head = hostManifest
				? `Author a mod against this host manifest. First, describe its surface (use xript_manifest_describe), then follow the loop.\n\nHost manifest:\n\n${hostManifest}\n\n`
				: "Author a mod. If a host manifest is available, describe its surface first, then follow the loop.\n\n";
			return userMessage(`${head}---\n\n${authoring}`);
		},
	);
}
