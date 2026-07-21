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

function isAbstractType(value: unknown): boolean {
	return isObject(value) && value.abstract === true;
}

/**
 * Recursively merges a child object onto a base, key-by-key. Where both sides hold a plain
 * object under the same key, the merge recurses; otherwise the child value replaces the base
 * value (arrays and scalars replace wholesale). Keys present only in the base are retained.
 * The `refines` marker is consumed here so it never reaches the resolved manifest.
 */
function deepMerge(base: Json, child: Json): Json {
	const result: Json = { ...base };
	for (const [key, value] of Object.entries(child)) {
		if (key === "refines") continue;
		const existing = base[key];
		if (isObject(existing) && isObject(value)) {
			result[key] = deepMerge(existing, value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function mergeMaps(base: unknown, child: unknown, mapKey: string): Json {
	const baseMap = isObject(base) ? base : {};
	const childMap = isObject(child) ? child : {};
	const merged: Json = { ...baseMap };
	for (const [key, value] of Object.entries(childMap)) {
		if (key in baseMap) {
			if (mapKey === "types") {
				const baseType = baseMap[key];
				if (isAbstractType(baseType) && isObject(value)) {
					merged[key] = value;
					continue;
				}
				if (isObject(baseType) && isObject(value) && value.refines === true) {
					merged[key] = deepMerge(baseType, value);
					continue;
				}
			}
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
				if (slot.refines === true) {
					const idx = out.findIndex((s) => isObject(s) && s.id === slot.id);
					if (idx >= 0) {
						out[idx] = deepMerge(out[idx] as Json, slot);
						continue;
					}
				}
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

function withoutRefines(value: unknown): unknown {
	if (!isObject(value)) return value;
	const copy: Json = { ...value };
	delete copy.refines;
	return copy;
}

/**
 * Merges a child node's props onto a base node's. A same-named prop is REPLACED wholesale
 * rather than deep-merged: deep-merging two JSON Schemas leaves stale constraints behind, and
 * a child widening a prop's type would silently inherit the base's `sink` onto a value the
 * sink can no longer handle. Replacing forces the child to restate the safety annotation.
 */
function mergeProps(base: unknown, child: unknown): Json {
	const baseProps = isObject(base) ? base : {};
	const childProps = isObject(child) ? child : {};
	return { ...baseProps, ...childProps };
}

function mergeNode(baseNode: Json, childNode: Json): Json {
	const merged: Json = { ...baseNode };
	for (const [key, value] of Object.entries(childNode)) {
		if (key === "refines") continue;
		if (key === "props") continue;
		merged[key] = value;
	}
	if ("props" in baseNode || "props" in childNode) {
		merged.props = mergeProps(baseNode.props, childNode.props);
	}
	delete merged.refines;
	return merged;
}

/**
 * Merges a `nodes` map, whether it hangs off a format's inline vocabulary or a named
 * one. `owner` is the JSON pointer of the declaration the nodes belong to, so a
 * collision is reported against the surface the author actually wrote.
 */
function mergeNodes(base: unknown, child: unknown, ownerLabel: string, owner: string): Json {
	const baseNodes = isObject(base) ? base : {};
	const childNodes = isObject(child) ? child : {};
	const merged: Json = {};
	for (const [name, node] of Object.entries(baseNodes)) merged[name] = withoutRefines(node);

	for (const [name, node] of Object.entries(childNodes)) {
		if (!(name in baseNodes)) {
			merged[name] = withoutRefines(node);
			continue;
		}
		if (!isObject(node) || node.refines !== true) {
			throw new ManifestResolutionError(
				`${ownerLabel} node "${name}" conflicts with extended base`,
				`${owner}/nodes/${name}`,
			);
		}
		merged[name] = mergeNode(baseNodes[name] as Json, node);
	}
	return merged;
}

/**
 * Merges one format declaration onto its base. `vocabularies` is absent-inherits,
 * present-replaces-wholesale: the array is ordered and the order is semantic, so there is
 * no defensible union order, and a silent union could re-inject `html` into a scope a
 * child deliberately closed. The asymmetry with `nodes`, which key-merges, is intentional.
 *
 * `schemes` follows the same rule for the same reason. A union would make narrowing
 * impossible — a child could only ever widen its base's URI surface, and `[]` would stop
 * meaning deliberate closure.
 */
function mergeFormat(baseFormat: Json, childFormat: Json, formatId: string): Json {
	const merged: Json = { ...baseFormat };
	for (const [key, value] of Object.entries(childFormat)) {
		if (key === "refines") continue;
		if (key === "nodes") continue;
		if (key === "vocabularies") {
			merged.vocabularies = value;
			continue;
		}
		if (key === "schemes") {
			merged.schemes = value;
			continue;
		}
		merged[key] = value;
	}
	if ("nodes" in baseFormat || "nodes" in childFormat) {
		merged.nodes = mergeNodes(baseFormat.nodes, childFormat.nodes, "format", `/formats/${formatId}`);
	}
	delete merged.refines;
	return merged;
}

/**
 * Merges the `formats` block across an `extends` chain. Three levels, each collision-as-error
 * unless the child marks itself `refines`: a format id, a node inside a refining format, and a
 * prop inside a refining node (which replaces its base wholesale). Without this arm a child's
 * `formats` would replace the base's entire vocabulary silently.
 */
function mergeFormats(base: unknown, child: unknown): Json {
	const baseFormats = isObject(base) ? base : {};
	const childFormats = isObject(child) ? child : {};
	const merged: Json = {};

	for (const [id, format] of Object.entries(baseFormats)) {
		merged[id] = isObject(format) ? mergeFormat({}, format, id) : format;
	}

	for (const [id, format] of Object.entries(childFormats)) {
		if (!(id in baseFormats)) {
			merged[id] = isObject(format) ? mergeFormat({}, format, id) : format;
			continue;
		}
		if (!isObject(format) || format.refines !== true) {
			throw new ManifestResolutionError(
				`format "${id}" conflicts with extended base`,
				`/formats/${id}`,
			);
		}
		merged[id] = mergeFormat(baseFormats[id] as Json, format, id);
	}

	return merged;
}

function mergeVocabulary(baseVocabulary: Json, childVocabulary: Json, vocabularyId: string): Json {
	const merged: Json = { ...baseVocabulary };
	for (const [key, value] of Object.entries(childVocabulary)) {
		if (key === "refines") continue;
		if (key === "nodes") continue;
		merged[key] = value;
	}
	if ("nodes" in baseVocabulary || "nodes" in childVocabulary) {
		merged.nodes = mergeNodes(
			baseVocabulary.nodes,
			childVocabulary.nodes,
			"vocabulary",
			`/vocabularies/${vocabularyId}`,
		);
	}
	delete merged.refines;
	return merged;
}

/**
 * Merges the `vocabularies` block across an `extends` chain. Three levels of
 * collision-as-error-unless-`refines`, identical to `formats`: a vocabulary id, a node
 * inside a refining vocabulary, and a prop inside a refining node.
 */
function mergeVocabularies(base: unknown, child: unknown): Json {
	const baseVocabularies = isObject(base) ? base : {};
	const childVocabularies = isObject(child) ? child : {};
	const merged: Json = {};

	for (const [id, vocabulary] of Object.entries(baseVocabularies)) {
		merged[id] = isObject(vocabulary) ? mergeVocabulary({}, vocabulary, id) : vocabulary;
	}

	for (const [id, vocabulary] of Object.entries(childVocabularies)) {
		if (!(id in baseVocabularies)) {
			merged[id] = isObject(vocabulary) ? mergeVocabulary({}, vocabulary, id) : vocabulary;
			continue;
		}
		if (!isObject(vocabulary) || vocabulary.refines !== true) {
			throw new ManifestResolutionError(
				`vocabulary "${id}" conflicts with extended base`,
				`/vocabularies/${id}`,
			);
		}
		merged[id] = mergeVocabulary(baseVocabularies[id] as Json, vocabulary, id);
	}

	return merged;
}

/**
 * Merges an `execution` block across an `extends` chain, per-property with the child winning
 * each property it states. Unlike a type or a slot id, a colliding `execution` is never an
 * error and needs no `refines` marker: intent is a routing hint rather than a contract, so a
 * child may move `duration` in either direction — narrowing semantics do not apply.
 */
function mergeExecution(base: unknown, child: unknown): unknown {
	if (!isObject(base)) return child ?? base;
	if (!isObject(child)) return base;
	return { ...base, ...child };
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

	if ("formats" in base || "formats" in child) {
		result.formats = mergeFormats(base.formats, child.formats);
	}

	if ("vocabularies" in base || "vocabularies" in child) {
		result.vocabularies = mergeVocabularies(base.vocabularies, child.vocabularies);
	}

	if ("execution" in base || "execution" in child) {
		result.execution = mergeExecution(base.execution, child.execution);
	}

	for (const [key, value] of Object.entries(child)) {
		if (key === "extends") continue;
		if (key === "execution") continue;
		if ((SCALAR_KEYS as readonly string[]).includes(key)) continue;
		if ((MAP_KEYS as readonly string[]).includes(key)) continue;
		if (key === "slots") continue;
		if (key === "formats") continue;
		if (key === "vocabularies") continue;
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

export interface Provenance {
	resolved: unknown;
	inheritedSlots: string[];
	inheritedCapabilities: string[];
	inheritedAbstractTypes: string[];
	inheritedFormats: string[];
	inheritedVocabularies: string[];
}

function localSlotIds(manifest: Json): Set<string> {
	const ids = new Set<string>();
	const slots = manifest.slots;
	if (Array.isArray(slots)) {
		for (const slot of slots) {
			if (isObject(slot) && typeof slot.id === "string") ids.add(slot.id);
		}
	}
	return ids;
}

function localFormatIds(manifest: Json): Set<string> {
	const formats = manifest.formats;
	return isObject(formats) ? new Set(Object.keys(formats)) : new Set<string>();
}

function localVocabularyIds(manifest: Json): Set<string> {
	const vocabularies = manifest.vocabularies;
	return isObject(vocabularies) ? new Set(Object.keys(vocabularies)) : new Set<string>();
}

function localCapabilityNames(manifest: Json): Set<string> {
	const caps = manifest.capabilities;
	return isObject(caps) ? new Set(Object.keys(caps)) : new Set<string>();
}

function localTypeNames(manifest: Json): Set<string> {
	const types = manifest.types;
	return isObject(types) ? new Set(Object.keys(types)) : new Set<string>();
}

function abstractTypeNames(manifest: Json): Set<string> {
	const names = new Set<string>();
	const types = manifest.types;
	if (isObject(types)) {
		for (const [name, def] of Object.entries(types)) {
			if (isObject(def) && (def as { abstract?: boolean }).abstract === true) names.add(name);
		}
	}
	return names;
}

/**
 * Resolves a host manifest's `extends` chain and reports which slot ids and capability
 * names came from the resolved base(s) versus the host's own local declarations. A slot
 * or capability is "inherited" when it appears in the resolved manifest but not in the
 * host's pre-resolution local declarations. An inherited type is additionally flagged as an
 * unfilled abstract when the resolved definition still carries `abstract: true` — the host
 * inherited a typed hole and never filled it. When the host has no `extends`, all inherited
 * lists are empty and `resolved` is the flattened (extends-stripped) host.
 */
export async function resolveProvenance(manifest: unknown, baseDir: string): Promise<Provenance> {
	if (!isObject(manifest)) {
		return {
			resolved: manifest,
			inheritedSlots: [],
			inheritedCapabilities: [],
			inheritedAbstractTypes: [],
			inheritedFormats: [],
			inheritedVocabularies: [],
		};
	}
	const localSlots = localSlotIds(manifest);
	const localCaps = localCapabilityNames(manifest);
	const localTypes = localTypeNames(manifest);
	const localFormats = localFormatIds(manifest);
	const localVocabularies = localVocabularyIds(manifest);
	const resolved = await resolveWithChain(manifest, baseDir, []);

	const inheritedSlots = [...localSlotIds(resolved)].filter((id) => !localSlots.has(id));
	const inheritedCapabilities = [...localCapabilityNames(resolved)].filter((name) => !localCaps.has(name));
	const inheritedFormats = [...localFormatIds(resolved)].filter((id) => !localFormats.has(id));
	const inheritedVocabularies = [...localVocabularyIds(resolved)].filter((id) => !localVocabularies.has(id));

	const resolvedAbstract = abstractTypeNames(resolved);
	const inheritedAbstractTypes = [...localTypeNames(resolved)].filter(
		(name) => !localTypes.has(name) && resolvedAbstract.has(name),
	);

	return {
		resolved,
		inheritedSlots,
		inheritedCapabilities,
		inheritedAbstractTypes,
		inheritedFormats,
		inheritedVocabularies,
	};
}
