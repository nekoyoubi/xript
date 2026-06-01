import type { ModInstance, ProviderRole } from "./fragment.js";

export interface RoleResolution {
	addon: string;
	role: string;
	fns: Record<string, string>;
}

function providerRolesOf(mod: ModInstance): ProviderRole[] {
	return mod.provides;
}

export function resolveRoleAll(
	role: string,
	mods: ModInstance[],
): RoleResolution[] {
	const out: RoleResolution[] = [];
	for (const mod of mods) {
		for (const entry of providerRolesOf(mod)) {
			if (entry.role !== role) continue;
			out.push({ addon: mod.name, role: entry.role, fns: { ...entry.fns } });
		}
	}
	return out;
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
