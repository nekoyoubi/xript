import type { ExpressionType } from "@xriptjs/validate/core";

type Json = Record<string, unknown>;

export interface DataBinding {
	name: string;
	path: string;
}

export interface DataLeaf {
	path: string;
	value: unknown;
}

const MOD_SCHEMA = "https://xript.dev/schema/mod-manifest/v0.9.json";
const SAMPLE_STRINGS: Record<string, string> = { name: "Aria", time: "12:00", weather: "clear", biome: "plains" };
const SAMPLE_NAMES = ["Aria", "Bram", "Cole"];
const SAMPLE_COUNTS = [3, 1, 12];
const LIST_LENGTH = 3;
const MAX_DEPTH = 4;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

/** `getHealth` reads as `health`, `isInCombat` as `inCombat`; anything else keeps its name. */
function dataKey(member: string): string {
	const match = /^(?:get|is|has)([A-Z].*)$/.exec(member);
	return match ? lowerFirst(match[1]) : member;
}

function sampleString(key: string, owner: string | undefined, index: number | undefined): string {
	if (owner && index !== undefined && key === "name") return `${owner} ${index + 1}`;
	return SAMPLE_STRINGS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function sampleValue(
	typeRef: unknown,
	key: string,
	types: Json,
	depth: number,
	owner?: string,
	index?: number,
): unknown {
	if (depth > MAX_DEPTH) return null;
	if (isObject(typeRef)) {
		if ("type" in typeRef) return sampleValue(typeRef.type, key, types, depth, owner, index);
		if ("array" in typeRef) return sampleList(typeRef.array, key, types, depth);
		if ("optional" in typeRef) return sampleValue(typeRef.optional, key, types, depth, owner, index);
		if (Array.isArray(typeRef.union)) return sampleValue(typeRef.union[0], key, types, depth, owner, index);
		if ("map" in typeRef) return {};
		return null;
	}
	if (typeof typeRef !== "string") return null;
	if (typeRef.endsWith("[]")) return sampleList(typeRef.slice(0, -2), key, types, depth);
	switch (typeRef) {
		case "number":
		case "int":
		case "integer":
		case "float":
			return index === undefined ? 50 : SAMPLE_COUNTS[index % SAMPLE_COUNTS.length];
		case "string":
			return sampleString(key, owner, index);
		case "boolean":
		case "bool":
			return false;
	}
	const declared = types[typeRef];
	if (isObject(declared) && isObject(declared.fields)) {
		const record: Json = {};
		for (const [field, definition] of Object.entries(declared.fields)) {
			record[field] = sampleValue(isObject(definition) ? definition.type : undefined, field, types, depth + 1, typeRef, index);
		}
		return record;
	}
	return null;
}

function sampleList(itemRef: unknown, key: string, types: Json, depth: number): unknown[] {
	if (itemRef === "string") return [...SAMPLE_NAMES];
	return Array.from({ length: LIST_LENGTH }, (_, index) => sampleValue(itemRef, key, types, depth + 1, undefined, index));
}

function hasRequiredParams(binding: Json): boolean {
	return Array.isArray(binding.params) && binding.params.some((p) => isObject(p) && p.optional !== true && p.required !== false && p.variadic !== true);
}

function readNamespace(members: Json, types: Json, depth: number): Json {
	const data: Json = {};
	for (const [member, definition] of Object.entries(members)) {
		if (!isObject(definition)) continue;
		if (isObject(definition.members)) {
			const nested = readNamespace(definition.members, types, depth + 1);
			if (Object.keys(nested).length > 0) data[member] = nested;
			continue;
		}
		if (definition.returns === undefined || hasRequiredParams(definition)) continue;
		const key = dataKey(member);
		data[key] = sampleValue(definition.returns, key, types, depth + 1);
	}
	return data;
}

/**
 * Sample host data for a manifest: what a host would plausibly hand a fragment. Every
 * parameterless reader becomes a value (a `player.getHealth` binding becomes `player.health`),
 * typed from its `returns` and the manifest's `types`. A manifest with no readers falls back
 * to one sample record per declared type.
 */
export function sampleHostData(manifest: Json): Json {
	const types = isObject(manifest.types) ? manifest.types : {};
	const data = isObject(manifest.bindings) ? readNamespace(manifest.bindings, types, 0) : {};
	if (Object.keys(data).length === 0) {
		for (const typeName of Object.keys(types)) data[lowerFirst(typeName)] = sampleValue(typeName, typeName, types, 0);
	}
	return data;
}

/**
 * Local binding names a fragment can read, each mapped to its host data path. Top-level keys
 * bind under their own name; a nested value binds under its last segment unless two paths
 * would claim the same name, in which case neither does and the fragment reads it through its
 * parent (`player.name`).
 */
export function bindingCatalog(data: Json): DataBinding[] {
	const roots = new Map(Object.keys(data).map((key) => [key, key]));
	const nested = new Map<string, string>();
	const ambiguous = new Set<string>();
	const visit = (value: unknown, path: string[]): void => {
		if (!isObject(value)) return;
		for (const [key, child] of Object.entries(value)) {
			const childPath = [...path, key];
			if (!roots.has(key)) {
				if (nested.has(key)) ambiguous.add(key);
				else nested.set(key, childPath.join("."));
			}
			visit(child, childPath);
		}
	};
	for (const [key, value] of Object.entries(data)) visit(value, [key]);
	const catalog = [...roots].map(([name, path]) => ({ name, path }));
	for (const [name, path] of nested) if (!ambiguous.has(name)) catalog.push({ name, path });
	return catalog;
}

/** Every editable value in the data: primitives and lists, keyed by dotted path. */
export function dataLeaves(data: Json, prefix: string[] = []): DataLeaf[] {
	const leaves: DataLeaf[] = [];
	for (const [key, value] of Object.entries(data)) {
		const path = [...prefix, key];
		if (isObject(value)) leaves.push(...dataLeaves(value, path));
		else leaves.push({ path: path.join("."), value });
	}
	return leaves;
}

export function readPath(data: Json, path: string): unknown {
	let cursor: unknown = data;
	for (const segment of path.split(".")) {
		if (!isObject(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return cursor;
}

export function writePath(data: Json, path: string, value: unknown): void {
	const segments = path.split(".");
	let cursor = data;
	for (const segment of segments.slice(0, -1)) {
		if (!isObject(cursor[segment])) cursor[segment] = {};
		cursor = cursor[segment] as Json;
	}
	cursor[segments[segments.length - 1]] = value;
}

export function expressionType(value: unknown): ExpressionType {
	if (Array.isArray(value)) return "array";
	if (value === null || value === undefined) return "unknown";
	const kind = typeof value;
	if (kind === "number" || kind === "string" || kind === "boolean") return kind;
	return kind === "object" ? "object" : "unknown";
}

export interface AuthoredFragment {
	host: Json;
	slotId: string;
	format: string;
	source: string;
	modName: string;
	fillId: string;
	/** Embed the source in the manifest rather than pointing at a file beside it. */
	inline: boolean;
	/** The bindings the fragment reads, already narrowed to the names its expressions use. */
	bindings: DataBinding[];
}

export interface ModPackage {
	manifest: Json;
	/** Where the fragment source lives inside the mod, when it is not inlined. */
	fragmentPath: string;
}

export function fragmentFileName(fillId: string, format: string): string {
	return `fragments/${fillId}.${format.includes("json") ? "json" : "html"}`;
}

/** The mod manifest a workbench session produces: one fill of the chosen slot. */
export function buildModPackage(authored: AuthoredFragment): ModPackage {
	const { host, slotId, format, source, modName, fillId, inline, bindings } = authored;
	const slots = Array.isArray(host.slots) ? host.slots : [];
	const slot = slots.find((s) => isObject(s) && s.id === slotId) as Json | undefined;
	const fragmentPath = fragmentFileName(fillId, format);

	const fill: Json = { id: fillId, format, source: inline ? source : fragmentPath };
	if (inline) fill.inline = true;
	if (source.includes("{{")) fill.interpolate = true;
	if (bindings.length > 0) fill.bindings = bindings.map(({ name, path }) => ({ name, path }));

	const hostLabel = typeof host.title === "string" ? host.title : typeof host.name === "string" ? host.name : "the host";
	const manifest: Json = {
		$schema: MOD_SCHEMA,
		xript: "0.9",
		name: modName,
		version: "1.0.0",
		description: `A fragment for the "${slotId}" slot of ${hostLabel}.`,
	};
	if (slot && typeof slot.capability === "string") manifest.capabilities = [slot.capability];
	manifest.fills = { [slotId]: [fill] };
	return { manifest, fragmentPath };
}
