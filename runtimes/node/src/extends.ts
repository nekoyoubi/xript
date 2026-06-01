import { ManifestValidationError } from "./errors.js";

export type ManifestLoader = (path: string) => unknown;

const MAP_KEYS = ["bindings", "capabilities", "hooks", "types"] as const;
const SCALAR_KEYS = ["name", "version", "title", "description", "xript"] as const;

function asExtendsList(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value as string[];
	}
	throw new ManifestValidationError([
		{ path: "/extends", message: "'extends' must be a string or an array of strings" },
	]);
}

function joinPath(baseDir: string, ref: string): string {
	const normalizedBase = baseDir.replace(/[\\/]+$/, "");
	if (ref.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(ref)) return ref;
	const combined = normalizedBase ? `${normalizedBase}/${ref}` : ref;
	const parts: string[] = [];
	for (const segment of combined.split(/[\\/]+/)) {
		if (segment === "." || segment === "") continue;
		if (segment === "..") {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	const prefix = combined.startsWith("/") ? "/" : "";
	return prefix + parts.join("/");
}

function dirOf(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx >= 0 ? path.slice(0, idx) : "";
}

function mergeMaps(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
	mapKey: string,
	conflicts: Array<{ path: string; message: string }>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...target };
	for (const [key, value] of Object.entries(source)) {
		if (Object.prototype.hasOwnProperty.call(merged, key)) {
			conflicts.push({
				path: `/${mapKey}/${key}`,
				message: `${mapKey} id '${key}' conflicts with extended base`,
			});
			continue;
		}
		merged[key] = value;
	}
	return merged;
}

function mergeSlots(
	base: unknown[],
	child: unknown[],
	conflicts: Array<{ path: string; message: string }>,
): unknown[] {
	const merged: unknown[] = [...base];
	const seen = new Set<string>();
	for (const slot of base) {
		const id = (slot as { id?: unknown })?.id;
		if (typeof id === "string") seen.add(id);
	}
	for (const slot of child) {
		const id = (slot as { id?: unknown })?.id;
		if (typeof id === "string" && seen.has(id)) {
			conflicts.push({
				path: `/slots/${id}`,
				message: `slot id '${id}' conflicts with extended base`,
			});
			continue;
		}
		if (typeof id === "string") seen.add(id);
		merged.push(slot);
	}
	return merged;
}

function mergeManifests(
	base: Record<string, unknown>,
	child: Record<string, unknown>,
): Record<string, unknown> {
	const conflicts: Array<{ path: string; message: string }> = [];
	const result: Record<string, unknown> = { ...base };

	for (const key of MAP_KEYS) {
		const baseMap = base[key];
		const childMap = child[key];
		if (baseMap !== undefined && childMap !== undefined) {
			result[key] = mergeMaps(
				baseMap as Record<string, unknown>,
				childMap as Record<string, unknown>,
				key,
				conflicts,
			);
		} else if (childMap !== undefined) {
			result[key] = childMap;
		}
	}

	if (Array.isArray(base.slots) || Array.isArray(child.slots)) {
		result.slots = mergeSlots(
			Array.isArray(base.slots) ? base.slots : [],
			Array.isArray(child.slots) ? child.slots : [],
			conflicts,
		);
	}

	for (const key of SCALAR_KEYS) {
		if (child[key] !== undefined) result[key] = child[key];
	}

	for (const [key, value] of Object.entries(child)) {
		if (key === "extends") continue;
		if ((MAP_KEYS as readonly string[]).includes(key)) continue;
		if (key === "slots") continue;
		if ((SCALAR_KEYS as readonly string[]).includes(key)) continue;
		result[key] = value;
	}

	if (conflicts.length > 0) throw new ManifestValidationError(conflicts);

	delete result.extends;
	return result;
}

function resolveInternal(
	manifest: Record<string, unknown>,
	baseDir: string,
	loader: ManifestLoader,
	chain: string[],
): Record<string, unknown> {
	if (manifest.extends === undefined) {
		const out = { ...manifest };
		delete out.extends;
		return out;
	}

	const refs = asExtendsList(manifest.extends);
	let composed: Record<string, unknown> = {};

	for (const ref of refs) {
		const resolvedPath = joinPath(baseDir, ref);
		if (chain.includes(resolvedPath)) {
			throw new ManifestValidationError([
				{ path: "/extends", message: `circular extends detected at '${resolvedPath}'` },
			]);
		}
		let raw: unknown;
		try {
			raw = loader(resolvedPath);
		} catch (e) {
			throw new ManifestValidationError([
				{ path: "/extends", message: `cannot resolve base manifest '${ref}': ${(e as Error).message}` },
			]);
		}
		if (typeof raw !== "object" || raw === null) {
			throw new ManifestValidationError([
				{ path: "/extends", message: `base manifest '${ref}' is not an object` },
			]);
		}
		const resolvedBase = resolveInternal(
			raw as Record<string, unknown>,
			dirOf(resolvedPath),
			loader,
			[...chain, resolvedPath],
		);
		composed = mergeManifests(composed, resolvedBase);
	}

	const childWithoutExtends = { ...manifest };
	delete childWithoutExtends.extends;
	return mergeManifests(composed, childWithoutExtends);
}

export function resolveExtends(
	manifest: unknown,
	baseDir: string,
	loader: ManifestLoader,
): Record<string, unknown> {
	if (typeof manifest !== "object" || manifest === null) {
		throw new ManifestValidationError([{ path: "/", message: "manifest must be a non-null object" }]);
	}
	return resolveInternal(manifest as Record<string, unknown>, baseDir, loader, []);
}
