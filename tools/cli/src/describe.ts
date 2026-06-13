import { generateDocs } from "@xriptjs/docgen";

export interface ManifestSurface {
	name: string | null;
	title: string | null;
	xript: string | null;
	bindings: string[];
	hooks: string[];
	capabilities: string[];
	slots: string[];
	types: string[];
	events: string[];
	libraries: string[];
}

export interface DescribeResult {
	summary: ManifestSurface;
	docs: string;
}

export function describeManifest(manifest: unknown): DescribeResult {
	const m = (manifest ?? {}) as Record<string, unknown>;
	const slots = Array.isArray(m.slots) ? (m.slots as Array<{ id?: string }>) : [];
	const events = Array.isArray(m.events) ? (m.events as Array<{ id?: string }>) : [];
	const summary: ManifestSurface = {
		name: (m.name as string) ?? null,
		title: (m.title as string) ?? null,
		xript: (m.xript as string) ?? null,
		bindings: Object.keys((m.bindings as object) ?? {}),
		hooks: Object.keys((m.hooks as object) ?? {}),
		capabilities: Object.keys((m.capabilities as object) ?? {}),
		slots: slots.map((slot) => slot.id).filter((id): id is string => Boolean(id)),
		types: Object.keys((m.types as object) ?? {}),
		events: events.map((event) => event.id).filter((id): id is string => Boolean(id)),
		libraries: Object.keys((m.libraries as object) ?? {}),
	};
	const { pages } = generateDocs(manifest);
	const docs = pages.map((page) => `# ${page.title}\n\n${page.content}`).join("\n\n---\n\n");
	return { summary, docs };
}
