/**
 * The reserved slot accepts and the branch order that reads them.
 *
 * A slot's `accepts` decides how its fills are read. Three media types are reserved: they
 * carry no markup, are never sanitized, and a host cannot redeclare them as fragment
 * formats. The order they are checked in is normative and shared by all four runtimes —
 * role, hook, command — so a slot listing more than one reserved accept resolves the same
 * way everywhere. The fragment sniff (`format` + `source`) runs after all three, and an
 * unclaimed fill is opaque data.
 */

export const ROLE_SLOT_ACCEPT = "application/x-xript-role";
export const HOOK_SLOT_ACCEPT = "application/x-xript-hook";
export const COMMAND_SLOT_ACCEPT = "application/x-xript-command";

export const RESERVED_SLOT_ACCEPTS: readonly string[] = [
	ROLE_SLOT_ACCEPT,
	HOOK_SLOT_ACCEPT,
	COMMAND_SLOT_ACCEPT,
];

export type SlotKind = "role" | "hook" | "command" | "fragment" | "data";

interface AcceptCarrier {
	accepts?: string[];
}

function accepts(slot: AcceptCarrier | undefined | null): string[] {
	return Array.isArray(slot?.accepts) ? slot.accepts : [];
}

export function isRoleSlot(slot: AcceptCarrier | undefined | null): boolean {
	return accepts(slot).includes(ROLE_SLOT_ACCEPT);
}

export function isHookSlot(slot: AcceptCarrier | undefined | null): boolean {
	const list = accepts(slot);
	if (list.includes(ROLE_SLOT_ACCEPT)) return false;
	return list.includes(HOOK_SLOT_ACCEPT);
}

/**
 * A slot takes command fills when its `accepts` names the command type and neither of the
 * two reserved kinds checked ahead of it. A slot listing role and command is a role slot.
 */
export function isCommandSlot(slot: AcceptCarrier | undefined | null): boolean {
	const list = accepts(slot);
	if (list.includes(ROLE_SLOT_ACCEPT) || list.includes(HOOK_SLOT_ACCEPT)) return false;
	return list.includes(COMMAND_SLOT_ACCEPT);
}

/**
 * The kind a single fill resolves to against its target slot. This is the one place the
 * branch order lives; `normalizeModFills` dispatches on it rather than re-deriving it.
 */
export function slotKindForFill(slot: AcceptCarrier | undefined | null, fill: unknown): SlotKind {
	const list = accepts(slot);
	if (list.includes(ROLE_SLOT_ACCEPT)) return "role";
	if (list.includes(HOOK_SLOT_ACCEPT)) return "hook";
	if (list.includes(COMMAND_SLOT_ACCEPT)) return "command";
	if (typeof fill === "object" && fill !== null && !Array.isArray(fill)) {
		const f = fill as Record<string, unknown>;
		if (typeof f.format === "string" && typeof f.source === "string") return "fragment";
	}
	return "data";
}
