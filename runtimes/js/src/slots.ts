import type { ModInstance, SlotDeclaration } from "./fragment.js";

export interface SlotContribution {
	modName: string;
	fragmentId: string;
	slot: string;
	format: string;
	priority: number;
}

function orderContributions(contributions: SlotContribution[]): SlotContribution[] {
	return [...contributions].sort((a, b) => {
		if (b.priority !== a.priority) return b.priority - a.priority;
		return a.fragmentId < b.fragmentId ? -1 : a.fragmentId > b.fragmentId ? 1 : 0;
	});
}

export function resolveSlotContributions(
	slotId: string,
	mods: ModInstance[],
	slots: SlotDeclaration[],
): SlotContribution[] {
	const slot = slots.find((s) => s.id === slotId);
	const contributions: SlotContribution[] = [];

	for (const mod of mods) {
		for (const fragment of mod.fragments) {
			if (fragment.slot !== slotId) continue;
			contributions.push({
				modName: mod.name,
				fragmentId: fragment.id,
				slot: fragment.slot,
				format: fragment.format,
				priority: fragment.priority,
			});
		}
	}

	const ordered = orderContributions(contributions);
	const allowMultiple = slot?.multiple === true;
	return allowMultiple ? ordered : ordered.slice(0, 1);
}
