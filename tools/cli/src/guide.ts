import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = join(here, "..", "content");
const guidanceDir = join(contentDir, "guidance");
const specDir = join(contentDir, "spec");

export interface GuidanceTopic {
	id: string;
	title: string;
	summary: string;
	file: string;
}

export interface SpecResource {
	id: string;
	title: string;
	description: string;
	file: string;
	mimeType: string;
}

export const SPEC_RESOURCES: SpecResource[] = [
	{ id: "manifest", title: "Manifest reference", description: "The app manifest format — bindings, slots, capabilities, types.", file: "manifest.md", mimeType: "text/markdown" },
	{ id: "mod-manifest", title: "Mod manifest reference", description: "The mod manifest format — capabilities, entry, and fills keyed by host slot id.", file: "mod-manifest.md", mimeType: "text/markdown" },
	{ id: "capabilities", title: "Capability model", description: "Default-deny capabilities and how they gate surfaces.", file: "capabilities.md", mimeType: "text/markdown" },
	{ id: "bindings", title: "Bindings", description: "Host functions and namespaces mods can call.", file: "bindings.md", mimeType: "text/markdown" },
	{ id: "hooks", title: "Hooks", description: "Lifecycle events the host fires for mods to handle.", file: "hooks.md", mimeType: "text/markdown" },
	{ id: "fragments", title: "Fragment protocol", description: "Inert templates, data-bind, data-if, and the sandbox fragment API.", file: "fragments.md", mimeType: "text/markdown" },
	{ id: "modules", title: "Modules", description: "Module support and entry-script evaluation.", file: "modules.md", mimeType: "text/markdown" },
	{ id: "security", title: "Security model", description: "Sandboxing guarantees and the threat model.", file: "security.md", mimeType: "text/markdown" },
	{ id: "vision", title: "Vision", description: "What xript is and the problem it solves.", file: "vision.md", mimeType: "text/markdown" },
	{ id: "annotations", title: "Annotations", description: "@xript JSDoc tags scanned into manifest bindings.", file: "annotations.md", mimeType: "text/markdown" },
	{ id: "debug-protocol", title: "Debug protocol", description: "The DAP-shaped debugging surface across runtimes.", file: "debug-protocol.md", mimeType: "text/markdown" },
	{ id: "harness", title: "Host harness", description: "Synthetic hosts for testing — stub bindings, journaled calls, and replayable step scenarios.", file: "harness.md", mimeType: "text/markdown" },
	{ id: "manifest-schema", title: "Manifest JSON Schema", description: "The app manifest JSON Schema.", file: "manifest.schema.json", mimeType: "application/json" },
	{ id: "mod-manifest-schema", title: "Mod manifest JSON Schema", description: "The mod manifest JSON Schema.", file: "mod-manifest.schema.json", mimeType: "application/json" },
	{ id: "harness-schema", title: "Harness JSON Schema", description: "The harness descriptor JSON Schema — binding stubs and capability grants.", file: "harness.schema.json", mimeType: "application/json" },
	{ id: "harness-steps-schema", title: "Harness steps JSON Schema", description: "The harness steps JSON Schema — the replayable scenario format.", file: "harness-steps.schema.json", mimeType: "application/json" },
];

export async function loadGuidanceIndex(): Promise<GuidanceTopic[]> {
	const raw = await readFile(join(guidanceDir, "index.json"), "utf-8");
	const parsed = JSON.parse(raw) as { topics: GuidanceTopic[] };
	return parsed.topics;
}

export async function loadGuidanceTopic(id: string): Promise<{ topic: GuidanceTopic; body: string } | null> {
	const topics = await loadGuidanceIndex();
	const topic = topics.find((entry) => entry.id === id);
	if (!topic) return null;
	const body = await readFile(join(guidanceDir, topic.file), "utf-8");
	return { topic, body };
}

export function findSpecResource(id: string): SpecResource | undefined {
	return SPEC_RESOURCES.find((entry) => entry.id === id);
}

export async function loadSpecResource(id: string): Promise<{ resource: SpecResource; body: string } | null> {
	const resource = findSpecResource(id);
	if (!resource) return null;
	const body = await readFile(join(specDir, resource.file), "utf-8");
	return { resource, body };
}
