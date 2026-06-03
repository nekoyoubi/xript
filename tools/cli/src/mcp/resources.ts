import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SPEC_RESOURCES, loadSpecResource, loadGuidanceIndex, loadGuidanceTopic } from "../guide.js";

export async function registerResources(server: McpServer): Promise<void> {
	for (const resource of SPEC_RESOURCES) {
		const uri = `xript://spec/${resource.id}`;
		server.registerResource(
			`spec-${resource.id}`,
			uri,
			{ title: resource.title, description: resource.description, mimeType: resource.mimeType },
			async () => {
				const loaded = await loadSpecResource(resource.id);
				if (!loaded) throw new Error(`spec resource not found: ${resource.id}`);
				return { contents: [{ uri, mimeType: resource.mimeType, text: loaded.body }] };
			},
		);
	}

	const topics = await loadGuidanceIndex();
	for (const topic of topics) {
		const uri = `xript://guidance/${topic.id}`;
		server.registerResource(
			`guidance-${topic.id}`,
			uri,
			{ title: topic.title, description: topic.summary, mimeType: "text/markdown" },
			async () => {
				const loaded = await loadGuidanceTopic(topic.id);
				if (!loaded) throw new Error(`guidance topic not found: ${topic.id}`);
				return { contents: [{ uri, mimeType: "text/markdown", text: loaded.body }] };
			},
		);
	}
}
