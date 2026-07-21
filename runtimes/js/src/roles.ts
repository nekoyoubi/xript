import type { ModInstance } from "./fragment.js";

export interface RoleResolution {
	addon: string;
	role: string;
	fns: Record<string, string>;
}

/**
 * Every mod providing a role, ordered by owning mod name ascending.
 *
 * A provider role carries no priority and no fill id, so the shared slot-resolution order
 * collapses to its third key here. The order is deterministic either way: which provider
 * wins no longer depends on the order the host happened to load its mods in.
 */
export function resolveRoleAll(
	role: string,
	mods: ModInstance[],
): RoleResolution[] {
	const out: RoleResolution[] = [];
	for (const mod of mods) {
		for (const entry of mod.provides) {
			if (entry.role !== role) continue;
			out.push({ addon: mod.name, role: entry.role, fns: { ...entry.fns } });
		}
	}
	return out.sort((a, b) => (a.addon < b.addon ? -1 : a.addon > b.addon ? 1 : 0));
}

export function resolveRole(
	role: string,
	mods: ModInstance[],
	preferences?: Record<string, string>,
): RoleResolution | null {
	const candidates = resolveRoleAll(role, mods);
	if (candidates.length === 0) return null;

	const preferred = preferences?.[role];
	if (preferred) {
		const match = candidates.find((c) => c.addon === preferred);
		if (match) return match;
	}

	return candidates[0];
}
