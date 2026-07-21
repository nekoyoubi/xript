/**
 * The `application/x-xript-command` slot kind: named, invocable actions a mod contributes
 * by filling a slot the host declared.
 *
 * A command is a fill like any other — there is no top-level `commands` block — and its
 * authority comes from two layers that already ship: the slot's `capability` gates the
 * contribution, and `entry.exports[handler].capability` gates the invocation. A fill
 * carrying its own `capability` is refused rather than ignored, because under prefix
 * subsumption a fill-level narrowing could never deny anything.
 */

import type { ModInstance, ModManifestIssue, SlotDeclaration } from "./fragment.js";

export const COMMAND_ID_PATTERN = /^[a-z][a-z0-9.-]*$/;

export interface CommandFill {
	/** The mod that declared the fill — the first half of export identity. */
	mod: string;
	slot: string;
	id: string;
	/** Human label; falls back to the id. */
	title: string;
	description?: string;
	icon?: string;
	group?: string;
	keywords: string[];
	/** The export that runs the command, addressed within `mod`. */
	handler: string;
	/** Bound arguments, merged under the caller's at invoke. */
	args: Record<string, unknown>;
	input?: unknown;
	output?: unknown;
	/**
	 * Informational only, never consulted at invoke: the narrowest gate the command sits
	 * behind — the handler's export capability when it declares one, else the slot's.
	 */
	capability?: string;
	/** Informational: every gate the command sits behind, slot first then export. */
	capabilities: string[];
	priority: number;
	/** Discoverability hint, not an authority gate: an unexposed command still runs. */
	exposed: boolean;
}

export interface ResolvedCommand extends CommandFill {
	/** `${mod}:${id}` — total, because a mod name addresses an export namespace. */
	qualifiedId: string;
	/** True when another command in the same slot shares this bare id. */
	collides: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(token: string): string {
	return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The keys a closed `input` declares, or null when the fill declares no closed contract. */
function closedInputKeys(fill: Record<string, unknown>): Set<string> | null {
	const input = fill.input;
	if (!isPlainObject(input)) return null;
	if (input.additionalProperties !== false) return null;
	const properties = isPlainObject(input.properties) ? input.properties : {};
	return new Set(Object.keys(properties));
}

/** The capability each enumerated export declares, keyed by export name. */
export function exportCapabilityMap(modManifest: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!isPlainObject(modManifest)) return out;
	const entry = modManifest.entry;
	if (!isPlainObject(entry)) return out;
	const exportsMap = entry.exports;
	if (!isPlainObject(exportsMap)) return out;
	for (const [name, decl] of Object.entries(exportsMap)) {
		if (isPlainObject(decl) && typeof decl.capability === "string") out.set(name, decl.capability);
	}
	return out;
}

export interface CommandFillContext {
	mod: string;
	slot: string;
	index: number;
	/** RFC 6901 pointer to the fill itself, e.g. "/fills/palette.commands/0". */
	path: string;
	/** Ids already taken within this (mod, slot). Mutated as fills normalize. */
	seenIds: Set<string>;
	slotCapability?: string;
	exportCapabilities: Map<string, string>;
}

/**
 * Normalizes one command fill, appending fill-time defects to `issues`. Returns null when
 * the fill is defective. Defect codes match `@xriptjs/validate`'s command analyzer, so a
 * manifest pair that lints clean also loads clean.
 */
export function normalizeCommandFill(
	fill: Record<string, unknown>,
	context: CommandFillContext,
	issues: ModManifestIssue[],
): CommandFill | null {
	const { path, index, slot, mod } = context;
	const id = fill.id;
	const handler = fill.handler;
	const label = typeof id === "string" && id.length > 0 ? id : `#${index}`;

	if ("capability" in fill) {
		const handlerName = typeof handler === "string" && handler.length > 0 ? handler : "<handler>";
		issues.push({
			path: `${path}/capability`,
			code: "command-fill-capability",
			message:
				`command '${label}' declares a 'capability'; per-action authority lives on the export it names ` +
				`— move it to entry.exports.${handlerName}.capability`,
			detail: { fill: index, ...(typeof id === "string" ? { id } : {}), ...(typeof handler === "string" ? { handler } : {}) },
		});
		return null;
	}

	if (typeof handler !== "string" || handler.length === 0) {
		issues.push({
			path: `${path}/handler`,
			code: "command-missing-handler",
			message: "a command fill must name a 'handler' export",
			detail: { fill: index, ...(typeof id === "string" ? { id } : {}) },
		});
		return null;
	}

	if (typeof id !== "string" || !COMMAND_ID_PATTERN.test(id)) {
		issues.push({
			path: `${path}/id`,
			code: "command-invalid-id",
			message: "a command fill must carry an 'id' matching ^[a-z][a-z0-9.-]*$",
			detail: { fill: index, handler },
		});
		return null;
	}

	if (context.seenIds.has(id)) {
		issues.push({
			path: `${path}/id`,
			code: "command-duplicate-id",
			message: `command id '${id}' is declared twice in slot '${slot}'`,
			detail: { fill: index, id, handler },
		});
		return null;
	}

	if ("args" in fill && !isPlainObject(fill.args)) {
		issues.push({
			path: `${path}/args`,
			code: "command-args-not-object",
			message: "bound 'args' must be an object of argument values",
			detail: { fill: index, id, handler },
		});
		return null;
	}

	const args = isPlainObject(fill.args) ? { ...fill.args } : {};
	const closed = closedInputKeys(fill);
	if (closed) {
		let rejected = false;
		for (const key of Object.keys(args)) {
			if (closed.has(key)) continue;
			rejected = true;
			issues.push({
				path: `${path}/args/${escapePointer(key)}`,
				code: "command-unbound-arg",
				message: `bound argument '${key}' is not declared in this command's 'input'`,
				detail: { fill: index, id, handler, arg: key },
			});
		}
		if (rejected) return null;
	}

	context.seenIds.add(id);

	const exportCapability = context.exportCapabilities.get(handler);
	const capabilities: string[] = [];
	if (context.slotCapability) capabilities.push(context.slotCapability);
	if (exportCapability && !capabilities.includes(exportCapability)) capabilities.push(exportCapability);
	const narrowest = exportCapability ?? context.slotCapability;

	return {
		mod,
		slot,
		id,
		title: typeof fill.title === "string" ? fill.title : id,
		...(typeof fill.description === "string" ? { description: fill.description } : {}),
		...(typeof fill.icon === "string" ? { icon: fill.icon } : {}),
		...(typeof fill.group === "string" ? { group: fill.group } : {}),
		keywords: Array.isArray(fill.keywords) ? fill.keywords.filter((k): k is string => typeof k === "string") : [],
		handler,
		args,
		...(fill.input !== undefined ? { input: fill.input } : {}),
		...(fill.output !== undefined ? { output: fill.output } : {}),
		...(narrowest !== undefined ? { capability: narrowest } : {}),
		capabilities,
		priority: typeof fill.priority === "number" ? fill.priority : 0,
		exposed: fill.exposed !== false,
	};
}

/**
 * Orders commands by the shared three-key slot-resolution rule: priority descending, fill
 * id ascending, owning mod name ascending. The third key is what makes the order total,
 * and therefore independent of the order the host happened to load its mods in.
 */
export function orderCommands(commands: ResolvedCommand[]): ResolvedCommand[] {
	return [...commands].sort((a, b) => {
		if (b.priority !== a.priority) return b.priority - a.priority;
		if (a.id !== b.id) return a.id < b.id ? -1 : 1;
		return a.mod < b.mod ? -1 : a.mod > b.mod ? 1 : 0;
	});
}

function markCollisions(commands: ResolvedCommand[]): ResolvedCommand[] {
	const counts = new Map<string, number>();
	for (const command of commands) counts.set(command.id, (counts.get(command.id) ?? 0) + 1);
	for (const command of commands) command.collides = (counts.get(command.id) ?? 0) > 1;
	return commands;
}

/** Every command filled into a slot, ordered, with cardinality ignored. */
export function resolveCommandsAll(slotId: string, mods: ModInstance[]): ResolvedCommand[] {
	const out: ResolvedCommand[] = [];
	for (const mod of mods) {
		for (const fill of mod.commandFills) {
			if (fill.slot !== slotId) continue;
			out.push({ ...fill, args: { ...fill.args }, qualifiedId: `${fill.mod}:${fill.id}`, collides: false });
		}
	}
	return markCollisions(orderCommands(out));
}

/**
 * The commands a host should offer for a slot. `multiple: false` yields exactly one
 * command across all mods, the same as every other slot kind — a palette slot declares
 * `multiple: true`.
 */
export function resolveCommands(slotId: string, mods: ModInstance[], slots: SlotDeclaration[]): ResolvedCommand[] {
	const ordered = resolveCommandsAll(slotId, mods);
	const slot = slots.find((s) => s.id === slotId);
	return slot?.multiple === true ? ordered : ordered.slice(0, 1);
}

/**
 * Looks a command up by bare id or `mod:id`. A qualified reference is total and ignores
 * preferences; a bare one takes the preferred mod when the host named one for the command
 * id or its slot, and otherwise the ordering winner.
 */
export function resolveCommand(
	ref: string,
	mods: ModInstance[],
	slots: SlotDeclaration[],
	preferences?: Record<string, string>,
): ResolvedCommand | null {
	const commandSlots = new Set<string>();
	for (const mod of mods) for (const fill of mod.commandFills) commandSlots.add(fill.slot);

	const available: ResolvedCommand[] = [];
	for (const slot of slots) {
		if (!commandSlots.has(slot.id)) continue;
		available.push(...resolveCommands(slot.id, mods, slots));
	}

	const separator = ref.indexOf(":");
	if (separator > 0) {
		const modName = ref.slice(0, separator);
		const id = ref.slice(separator + 1);
		return available.find((c) => c.mod === modName && c.id === id) ?? null;
	}

	const candidates = available.filter((c) => c.id === ref);
	if (candidates.length === 0) return null;

	const preferred = preferences?.[ref] ?? preferences?.[candidates[0].slot];
	if (preferred) {
		const match = candidates.find((c) => c.mod === preferred);
		if (match) return match;
	}

	return candidates[0];
}

/**
 * The effective argument object a handler receives: bound arguments overlaid by the
 * caller's. Shallow and top-level only — a nested object from the caller replaces the
 * bound one outright rather than producing a value neither side wrote.
 */
export function mergeCommandArgs(
	bound: Record<string, unknown>,
	callArgs?: Record<string, unknown> | null,
): Record<string, unknown> {
	return { ...bound, ...(callArgs ?? {}) };
}
