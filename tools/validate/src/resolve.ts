import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export class ManifestResolutionError extends Error {
	readonly path: string;

	constructor(message: string, path = "/") {
		super(message);
		this.name = "ManifestResolutionError";
		this.path = path;
	}
}

type Json = Record<string, unknown>;

const MAP_KEYS = ["bindings", "capabilities", "hooks", "types"] as const;
const SCALAR_KEYS = ["name", "version", "title", "description", "xript"] as const;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extendsPaths(manifest: Json): string[] {
	const raw = manifest.extends;
	if (raw === undefined) return [];
	if (typeof raw === "string") return [raw];
	if (Array.isArray(raw) && raw.every((p) => typeof p === "string")) {
		return raw as string[];
	}
	throw new ManifestResolutionError(
		"extends must be a string or an array of strings",
		"/extends",
	);
}

function mergeMaps(base: unknown, child: unknown, mapKey: string): Json {
	const merged: Json = {};
	const baseMap = isObject(base) ? base : {};
	const childMap = isObject(child) ? child : {};

	for (const [key, value] of Object.entries(baseMap)) {
		merged[key] = value;
	}
	for (const [key, value] of Object.entries(childMap)) {
		if (key in baseMap) {
			const singular = mapKey === "capabilities" ? "capability" : mapKey.replace(/s$/, "");
			throw new ManifestResolutionError(
				`${singular} id "${key}" conflicts with extended base`,
				`/${mapKey}/${key}`,
			);
		}
		merged[key] = value;
	}
	return merged;
}

function mergeSlots(base: unknown, child: unknown): unknown[] {
	const baseSlots = Array.isArray(base) ? base : [];
	const childSlots = Array.isArray(child) ? child : [];
	const seen = new Set<string>();
	const out: unknown[] = [];

	for (const slot of baseSlots) {
		if (isObject(slot) && typeof slot.id === "string") seen.add(slot.id);
		out.push(slot);
	}
	for (const slot of childSlots) {
		if (isObject(slot) && typeof slot.id === "string") {
			if (seen.has(slot.id)) {
				throw new ManifestResolutionError(
					`slot id "${slot.id}" conflicts with extended base`,
					`/slots`,
				);
			}
			seen.add(slot.id);
		}
		out.push(slot);
	}
	return out;
}

function mergeManifests(base: Json, child: Json): Json {
	const result: Json = { ...base };

	for (const key of SCALAR_KEYS) {
		if (key in child) result[key] = child[key];
	}

	for (const key of MAP_KEYS) {
		if (key in base || key in child) {
			result[key] = mergeMaps(base[key], child[key], key);
		}
	}

	if ("slots" in base || "slots" in child) {
		result.slots = mergeSlots(base.slots, child.slots);
	}

	for (const [key, value] of Object.entries(child)) {
		if (key === "extends") continue;
		if ((SCALAR_KEYS as readonly string[]).includes(key)) continue;
		if ((MAP_KEYS as readonly string[]).includes(key)) continue;
		if (key === "slots") continue;
		result[key] = value;
	}

	delete result.extends;
	return result;
}

async function readManifestFile(filePath: string): Promise<Json> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch {
		throw new ManifestResolutionError(`could not read extended manifest: ${filePath}`, "/extends");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ManifestResolutionError(`invalid JSON in extended manifest: ${filePath}`, "/extends");
	}
	if (!isObject(parsed)) {
		throw new ManifestResolutionError(`extended manifest is not an object: ${filePath}`, "/extends");
	}
	return parsed;
}

async function resolveWithChain(
	manifest: Json,
	baseDir: string,
	chain: string[],
): Promise<Json> {
	const paths = extendsPaths(manifest);
	if (paths.length === 0) {
		const flat = { ...manifest };
		delete flat.extends;
		return flat;
	}

	let composed: Json = {};
	for (const relPath of paths) {
		const absPath = resolve(baseDir, relPath);
		if (chain.includes(absPath)) {
			throw new ManifestResolutionError(
				`cyclic extends detected: ${[...chain, absPath].join(" -> ")}`,
				"/extends",
			);
		}
		const baseManifest = await readManifestFile(absPath);
		const resolvedBase = await resolveWithChain(baseManifest, dirname(absPath), [...chain, absPath]);
		composed = mergeManifests(composed, resolvedBase);
	}

	return mergeManifests(composed, manifest);
}

export async function resolveExtends(manifest: unknown, baseDir: string): Promise<unknown> {
	if (!isObject(manifest)) return manifest;
	return resolveWithChain(manifest, baseDir, []);
}

export async function resolveManifestFile(filePath: string): Promise<unknown> {
	const absPath = resolve(filePath);
	const manifest = await readManifestFile(absPath);
	return resolveWithChain(manifest, dirname(absPath), [absPath]);
}
