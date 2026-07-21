import { generateDocs } from "@xriptjs/docgen";
import { executionSurfaces, HOST_BINDING_THREAD_CONTRACT, type Duration } from "@xriptjs/validate";

export interface ManifestSurface {
	name: string | null;
	title: string | null;
	xript: string | null;
	bindings: string[];
	hooks: string[];
	capabilities: string[];
	/**
	 * Capability scopes whose children the host creates at run time. A mod requesting one of
	 * these names an instance the manifest could not have listed, which is intentional; a
	 * scope absent from here has no children a mod should be inventing.
	 */
	dynamicCapabilities: string[];
	slots: string[];
	types: string[];
	events: string[];
	libraries: string[];
	execution: ExecutionSummary;
}

/**
 * The per-lane read of a host's declared intent: how much of the surface is cheap enough for an
 * interactive lane and how much a host has to route elsewhere. `undeclared` is the surface that
 * resolved to a default rather than saying anything, which is the number a host integrating
 * against the manifest most wants to know.
 */
export interface ExecutionSummary {
	instant: number;
	brief: number;
	long: number;
	unbounded: number;
	declared: number;
	undeclared: number;
	summary: string;
}

export interface DescribeResult {
	summary: ManifestSurface;
	docs: string;
	/**
	 * The host-binding thread contract, present whenever the manifest declares any binding at
	 * all. It cannot be linted and it cannot be enforced by the pool, so it is stated wherever a
	 * host author reads.
	 */
	footer?: string;
}

function executionSummary(manifest: unknown): ExecutionSummary {
	const surfaces = executionSurfaces(manifest);
	const counts: Record<Duration, number> = { instant: 0, brief: 0, long: 0, unbounded: 0 };
	for (const surface of surfaces) counts[surface.resolved.duration]++;
	const declared = surfaces.filter((surface) => surface.declared).length;
	const lanes = (["instant", "brief", "long", "unbounded"] as const)
		.filter((duration) => counts[duration] > 0)
		.map((duration) => `${counts[duration]} ${duration}`)
		.join(", ");
	return {
		...counts,
		declared,
		undeclared: surfaces.length - declared,
		summary:
			surfaces.length === 0
				? "no surface to declare intent on"
				: `${lanes} (${declared} of ${surfaces.length} declared)`,
	};
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
		dynamicCapabilities: Object.entries((m.capabilities as Record<string, { instances?: unknown }>) ?? {})
			.filter(([, cap]) => cap?.instances !== undefined)
			.map(([name]) => name),
		slots: slots.map((slot) => slot.id).filter((id): id is string => Boolean(id)),
		types: Object.keys((m.types as object) ?? {}),
		events: events.map((event) => event.id).filter((id): id is string => Boolean(id)),
		libraries: Object.keys((m.libraries as object) ?? {}),
		execution: executionSummary(manifest),
	};
	const { pages } = generateDocs(manifest);
	// Each page's `content` already opens with its own `# <title>` heading, so joining the
	// bodies is enough — prepending `page.title` printed every heading twice.
	const docs = pages.map((page) => page.content).join("\n\n---\n\n");
	const result: DescribeResult = { summary, docs };
	if (summary.bindings.length > 0) {
		result.footer = HOST_BINDING_THREAD_CONTRACT;
	}
	return result;
}
