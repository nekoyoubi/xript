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
	{ id: "execution", title: "Execution limits", description: "What bounds a running script, what xript can interrupt, why host bindings are not interruptible, pool wedge detection, and Rust async mode.", file: "execution.md", mimeType: "text/markdown" },
	{ id: "commands", title: "Commands", description: "The command slot kind — named invocable actions, bound arguments, resolution, and where authority lives.", file: "commands.md", mimeType: "text/markdown" },
	{ id: "fragments", title: "Fragment protocol", description: "Inert templates, data-bind, data-if, data-each, and the sandbox fragment API.", file: "fragments.md", mimeType: "text/markdown" },
	{ id: "fragment-formats", title: "Fragment formats", description: "Host-declared node vocabularies, the prop sink safety model, the tree contract, and node references.", file: "fragment-formats.md", mimeType: "text/markdown" },
	{ id: "expressions", title: "Expressions (XEG)", description: "The one expression grammar behind `data-if`, `data-bind`, `data-each`, and `{{ }}` interpolation, implemented identically by every runtime and renderer.", file: "expressions.md", mimeType: "text/markdown" },
	{ id: "renderers", title: "Renderer contract", description: "What a fragment renderer must do and must not do — walk the tree, apply the op buffer, and never parse an expression or decide visibility.", file: "renderers.md", mimeType: "text/markdown" },
	{ id: "extends", title: "Manifest inheritance", description: "How `extends` resolves and merges base manifests, and the rules that keep it from clobbering.", file: "extends.md", mimeType: "text/markdown" },
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

/** Per-version notes for the topics whose doctrine changed, keyed by topic id then manifest version. */
export async function loadGuidanceVersionNotes(): Promise<Record<string, Record<string, string>>> {
	const raw = await readFile(join(guidanceDir, "versions.json"), "utf-8");
	return (JSON.parse(raw) as { topics: Record<string, Record<string, string>> }).topics;
}

/**
 * A guide topic. The body is the current doctrine. With a `version`, a topic whose doctrine
 * changed across versions leads with the note for that version; without one, it closes with every
 * version's note so the reader sees where the doctrine moved.
 */
export async function loadGuidanceTopic(
	id: string,
	version?: string,
): Promise<{ topic: GuidanceTopic; body: string; versionNotes?: Record<string, string> } | null> {
	const topics = await loadGuidanceIndex();
	const topic = topics.find((entry) => entry.id === id);
	if (!topic) return null;
	const body = await readFile(join(guidanceDir, topic.file), "utf-8");
	const notes = (await loadGuidanceVersionNotes())[id];
	if (!notes) return { topic, body };
	if (version !== undefined) {
		const note = notes[version];
		if (!note) return { topic, body, versionNotes: notes };
		return { topic, body: `> **In xript ${version}:** ${note}\n\n${body.trimEnd()}\n`, versionNotes: notes };
	}
	const history = Object.entries(notes)
		.map(([line, note]) => `- **${line}:** ${note}`)
		.join("\n");
	return { topic, body: `${body.trimEnd()}\n\n## Across versions\n\n${history}\n`, versionNotes: notes };
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
