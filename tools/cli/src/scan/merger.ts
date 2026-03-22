import type { ScanResult, MergeResult } from "./index.js";

interface ManifestLike {
	bindings?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
	[key: string]: unknown;
}

export function mergeImpl(existing: unknown, scanned: ScanResult): MergeResult {
	const manifest = structuredClone(existing) as ManifestLike;
	const added: string[] = [];
	const removed: string[] = [];
	const unchanged: string[] = [];
	const capabilityGaps: string[] = [];

	const existingBindings = manifest.bindings ?? {};
	const scannedBindings = scanned.bindings;

	const existingPaths = collectPaths(existingBindings);
	const scannedPaths = collectPaths(scannedBindings);

	for (const path of scannedPaths) {
		if (!existingPaths.has(path)) {
			added.push(path);
		} else {
			unchanged.push(path);
		}
	}

	for (const path of existingPaths) {
		if (!scannedPaths.has(path)) {
			removed.push(path);
		}
	}

	manifest.bindings = mergeBindingTrees(existingBindings, scannedBindings);

	if (!manifest.capabilities) {
		manifest.capabilities = {};
	}
	const caps = manifest.capabilities as Record<string, unknown>;
	for (const [name, scannedCap] of Object.entries(scanned.capabilities)) {
		if (!caps[name]) {
			capabilityGaps.push(name);
			caps[name] = {
				description: (scannedCap as any).description,
				risk: (scannedCap as any).risk,
			};
		}
	}

	return { manifest, added, removed, unchanged, capabilityGaps };
}

function collectPaths(obj: Record<string, unknown>, prefix = ""): Set<string> {
	const paths = new Set<string>();

	for (const [key, value] of Object.entries(obj)) {
		const fullPath = prefix ? `${prefix}.${key}` : key;

		if (value && typeof value === "object" && "members" in (value as any)) {
			const members = (value as any).members as Record<string, unknown>;
			for (const p of collectPaths(members, fullPath)) {
				paths.add(p);
			}
		} else {
			paths.add(fullPath);
		}
	}

	return paths;
}

function mergeBindingTrees(
	existing: Record<string, unknown>,
	scanned: Record<string, unknown>,
): Record<string, unknown> {
	const result = structuredClone(existing);

	for (const [key, scannedValue] of Object.entries(scanned)) {
		if (!(key in result)) {
			result[key] = scannedValue;
			continue;
		}

		const existingValue = result[key] as any;
		const sv = scannedValue as any;

		if (existingValue.members && sv.members) {
			existingValue.members = mergeBindingTrees(existingValue.members, sv.members);
		}
	}

	return result;
}
