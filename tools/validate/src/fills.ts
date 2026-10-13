import type { Finding } from "./lint.js";

/** The binding fields the protocol defines. Anything else on a binding is a host-defined extension. */
const PROTOCOL_BINDING_FIELDS: ReadonlySet<string> = new Set(["name", "path", "type"]);

/**
 * True when a fragment `source` reads as content rather than a file name: markup that opens
 * with a tag, or a JSON document (a JSML tree is a JSON array). The runtimes apply the same
 * test at load.
 */
export function looksLikeMarkup(source: string): boolean {
	const trimmed = source.trim();
	if (trimmed.startsWith("<")) return true;
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

interface FragmentFillView {
	id: string;
	where: string;
	fill: Record<string, unknown>;
}

function fragmentFillViews(mod: Record<string, unknown>): FragmentFillView[] {
	const views: FragmentFillView[] = [];
	const consider = (value: unknown, id: string, where: string): void => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return;
		const fill = value as Record<string, unknown>;
		if (typeof fill.format !== "string" || typeof fill.source !== "string") return;
		views.push({ id: typeof fill.id === "string" ? fill.id : id, where, fill });
	};

	const fills = mod.fills;
	if (fills !== null && typeof fills === "object" && !Array.isArray(fills)) {
		for (const [slotId, entries] of Object.entries(fills)) {
			if (!Array.isArray(entries)) continue;
			entries.forEach((entry, index) => consider(entry, `${slotId}-fill-${index}`, `fills.${slotId}[${index}]`));
		}
	}
	if (Array.isArray(mod.fragments)) {
		mod.fragments.forEach((entry, index) => consider(entry, `fragment-${index}`, `fragments[${index}]`));
	}
	return views;
}

/**
 * Findings about the shape of a mod's fragment fills that the runtimes also report at load:
 * markup in a `source` that is not marked `inline` (it mounts empty), the deprecated `events`
 * alias (once per mod), and host-defined binding fields, which tie the mod to the hosts that
 * implement them.
 *
 * `fragmentSources`, when given, is consulted so a file that happens to be named like markup
 * and is actually supplied draws no finding.
 */
export function fragmentFillFindings(mods: unknown[], fragmentSources?: Record<string, string>): Finding[] {
	const findings: Finding[] = [];

	for (const raw of mods) {
		const mod = (raw ?? {}) as Record<string, unknown>;
		const label = typeof mod.name === "string" ? `mod "${mod.name}"` : "a mod";
		let reportedEventsAlias = false;

		for (const { id, where, fill } of fragmentFillViews(mod)) {
			const source = fill.source as string;
			const supplied = fragmentSources !== undefined && Object.prototype.hasOwnProperty.call(fragmentSources, source);
			if (fill.inline !== true && !supplied && looksLikeMarkup(source)) {
				findings.push({
					severity: "warn",
					code: "markup-source-not-inline",
					message: `${label} fill "${id}" (${where}) carries markup in \`source\` without \`inline: true\`, so it is looked up as a file name and mounts empty`,
					suggestion: `Set \`"inline": true\` on the fill, or move the markup to a file and name that file in \`source\`.`,
				});
			}

			if (!reportedEventsAlias && fill.events !== undefined) {
				reportedEventsAlias = true;
				findings.push({
					severity: "warn",
					code: "deprecated-events-alias",
					message: `${label} declares fragment handlers under the deprecated \`events\` key (first on fill "${id}", ${where})`,
					suggestion: "Rename `events` to `handlers` on every fill; the entry shape is unchanged.",
				});
			}

			if (!Array.isArray(fill.bindings)) continue;
			for (const binding of fill.bindings) {
				if (binding === null || typeof binding !== "object" || Array.isArray(binding)) continue;
				const bindingName = typeof (binding as { name?: unknown }).name === "string"
					? (binding as { name: string }).name
					: "?";
				for (const field of Object.keys(binding)) {
					if (PROTOCOL_BINDING_FIELDS.has(field)) continue;
					findings.push({
						severity: "info",
						code: "non-portable-binding-field",
						message: `${label} fill "${id}" binding "${bindingName}" carries the host-defined field \`${field}\`; the mod only works as intended on hosts that implement it`,
						suggestion: `Keep \`${field}\` if this mod targets hosts that define it; otherwise compute the value with an expression in \`data-bind\` so any host renders it.`,
					});
				}
			}
		}
	}

	return findings;
}
