/**
 * Static analysis of the `application/x-xript-command` slot kind.
 *
 * A command is a fill of a slot whose `accepts` names the command media type: a named,
 * invocable action backed by a mod export. The checks here mirror the fill-time errors the
 * runtimes raise during normalization, so a manifest pair that lints clean also loads clean.
 */

export const ROLE_SLOT_ACCEPT = "application/x-xript-role";
export const HOOK_SLOT_ACCEPT = "application/x-xript-hook";
export const COMMAND_SLOT_ACCEPT = "application/x-xript-command";

export const COMMAND_ID_PATTERN = /^[a-z][a-z0-9.-]*$/;

export type CommandDefectCode =
	| "command-fill-capability"
	| "command-missing-handler"
	| "command-invalid-id"
	| "command-duplicate-id"
	| "command-args-not-object"
	| "command-unbound-arg"
	| "command-handler-unknown";

export interface CommandDefect {
	code: CommandDefectCode;
	index: number;
	/** RFC 6901 suffix appended to the fill's pointer, e.g. "/handler". Empty for whole-fill defects. */
	pointer: string;
	message: string;
	suggestion: string;
}

export interface CommandSlotDeclaration {
	id?: string;
	accepts?: string[];
	capability?: string;
	multiple?: boolean;
	payload?: object;
	reserved?: boolean;
}

/**
 * A slot takes command fills when its `accepts` names the command type and neither of the
 * two reserved kinds checked ahead of it. Branch order is role, hook, command, fragment,
 * data — a slot listing role and command is a role slot, and its fills are role maps.
 */
export function isCommandSlot(slot: CommandSlotDeclaration | undefined | null): boolean {
	const accepts = slot?.accepts;
	if (!Array.isArray(accepts)) return false;
	if (accepts.includes(ROLE_SLOT_ACCEPT) || accepts.includes(HOOK_SLOT_ACCEPT)) return false;
	return accepts.includes(COMMAND_SLOT_ACCEPT);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys a closed `input` declares, or null when the fill declares no closed contract. */
function closedInputKeys(fill: Record<string, unknown>): Set<string> | null {
	const input = fill.input;
	if (!isPlainObject(input)) return null;
	if (input.additionalProperties !== false) return null;
	const properties = isPlainObject(input.properties) ? input.properties : {};
	return new Set(Object.keys(properties));
}

/** The export names a mod manifest enumerates, or null when it enumerates none. */
export function declaredExportNames(modManifest: unknown): Set<string> | null {
	if (!isPlainObject(modManifest)) return null;
	const entry = modManifest.entry;
	if (!isPlainObject(entry)) return null;
	const exportsMap = entry.exports;
	if (!isPlainObject(exportsMap)) return null;
	const names = Object.keys(exportsMap);
	return names.length > 0 ? new Set(names) : null;
}

/** The capability an enumerated export declares, or undefined when it declares none. */
export function exportCapability(modManifest: unknown, exportName: string): string | undefined {
	if (!isPlainObject(modManifest)) return undefined;
	const entry = modManifest.entry;
	if (!isPlainObject(entry)) return undefined;
	const exportsMap = entry.exports;
	if (!isPlainObject(exportsMap)) return undefined;
	const def = exportsMap[exportName];
	if (!isPlainObject(def)) return undefined;
	return typeof def.capability === "string" ? def.capability : undefined;
}

export interface CommandFillView {
	index: number;
	id: string;
	handler: string;
	args: Record<string, unknown>;
	hasInput: boolean;
	priority: number;
	exposed: boolean;
}

/**
 * The well-formed command fills of a slot, in declaration order. Malformed fills are omitted;
 * `commandDefects` reports them. Callers that only want to reason about a mod's command surface
 * (collision reporting, authority reporting) use this and leave the defect list to the linter.
 */
export function commandFillViews(fills: unknown): CommandFillView[] {
	const entries = Array.isArray(fills) ? fills : [fills];
	const views: CommandFillView[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const fill = entries[index];
		if (!isPlainObject(fill)) continue;
		if ("capability" in fill) continue;
		const id = fill.id;
		const handler = fill.handler;
		if (typeof id !== "string" || !COMMAND_ID_PATTERN.test(id)) continue;
		if (typeof handler !== "string" || handler.length === 0) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		views.push({
			index,
			id,
			handler,
			args: isPlainObject(fill.args) ? fill.args : {},
			hasInput: isPlainObject(fill.input),
			priority: typeof fill.priority === "number" ? fill.priority : 0,
			exposed: fill.exposed !== false,
		});
	}
	return views;
}

/**
 * Fill-time defects for one command slot's fills. `exportNames` enumerates the mod's declared
 * exports, or is null when the mod declares none — the runtime is authoritative about what a
 * module actually exports, so an unknown handler is only a defect against a manifest that
 * opted into enumeration.
 */
export function commandDefects(
	fills: unknown,
	slotId: string,
	exportNames: Set<string> | null = null,
): CommandDefect[] {
	const entries = Array.isArray(fills) ? fills : [fills];
	const defects: CommandDefect[] = [];
	const seen = new Set<string>();

	for (let index = 0; index < entries.length; index++) {
		const fill = entries[index];
		if (!isPlainObject(fill)) {
			defects.push({
				code: "command-missing-handler",
				index,
				pointer: "",
				message: `a command fill must name a 'handler' export`,
				suggestion: `Give the fill an object shape carrying at least an 'id' and a 'handler'.`,
			});
			continue;
		}

		const id = fill.id;
		const handler = fill.handler;
		const label = typeof id === "string" && id.length > 0 ? id : `#${index}`;

		if ("capability" in fill) {
			const handlerName = typeof handler === "string" && handler.length > 0 ? handler : "<handler>";
			defects.push({
				code: "command-fill-capability",
				index,
				pointer: "/capability",
				message: `command '${label}' declares a 'capability'; per-action authority lives on the export it names — move it to entry.exports.${handlerName}.capability`,
				suggestion: `Delete the fill's 'capability' and declare it on the export instead: entry.exports.${handlerName}.capability. A fill-level narrowing could never deny — the slot gate the mod already holds subsumes it.`,
			});
			continue;
		}

		if (typeof handler !== "string" || handler.length === 0) {
			defects.push({
				code: "command-missing-handler",
				index,
				pointer: "/handler",
				message: `a command fill must name a 'handler' export`,
				suggestion: `Set 'handler' to the name of the mod export that runs this command.`,
			});
			continue;
		}

		if (typeof id !== "string" || !COMMAND_ID_PATTERN.test(id)) {
			defects.push({
				code: "command-invalid-id",
				index,
				pointer: "/id",
				message: `a command fill must carry an 'id' matching ^[a-z][a-z0-9.-]*$`,
				suggestion: `Give the command a lowercase dotted id, e.g. "wrap.double". A command is invoked and displayed by name, so it must name itself.`,
			});
			continue;
		}

		if (seen.has(id)) {
			defects.push({
				code: "command-duplicate-id",
				index,
				pointer: "/id",
				message: `command id '${id}' is declared twice in slot '${slotId}'`,
				suggestion: `Rename one of the two fills. A command id is unique within a (mod, slot) pair.`,
			});
			continue;
		}
		seen.add(id);

		if ("args" in fill && !isPlainObject(fill.args)) {
			defects.push({
				code: "command-args-not-object",
				index,
				pointer: "/args",
				message: `bound 'args' must be an object of argument values`,
				suggestion: `Write 'args' as an object keyed by argument name; it is merged under the caller's arguments at invoke.`,
			});
			continue;
		}

		const closed = closedInputKeys(fill);
		if (closed && isPlainObject(fill.args)) {
			for (const key of Object.keys(fill.args)) {
				if (closed.has(key)) continue;
				defects.push({
					code: "command-unbound-arg",
					index,
					pointer: `/args/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
					message: `bound argument '${key}' is not declared in this command's 'input'`,
					suggestion: `Declare '${key}' under input.properties, or drop the bound value. 'input' describes the EFFECTIVE argument object, bound keys included.`,
				});
			}
		}

		if (exportNames && !exportNames.has(handler)) {
			defects.push({
				code: "command-handler-unknown",
				index,
				pointer: "/handler",
				message: `command '${id}' names handler "${handler}" which is not listed in entry.exports`,
				suggestion: `Add "${handler}" to entry.exports, or point the command at an enumerated export. Authority for the action is read from entry.exports[handler].capability.`,
			});
		}
	}

	return defects;
}
