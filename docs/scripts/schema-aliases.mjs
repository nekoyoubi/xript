import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const SCHEMA_FAMILIES = [
	{ file: "manifest.schema.json", dir: "manifest" },
	{ file: "mod-manifest.schema.json", dir: "mod-manifest" },
	{ file: "capability-prompt.schema.json", dir: "capability-prompt" },
	{ file: "install-descriptor.schema.json", dir: "install-descriptor" },
	{ file: "discovery-result.schema.json", dir: "discovery-result" },
	{ file: "debug-messages.schema.json", dir: "debug-messages" },
	{ file: "harness.schema.json", dir: "harness" },
	{ file: "harness-steps.schema.json", dir: "harness-steps" },
];

function aliasFromId(schemaId) {
	if (typeof schemaId !== "string" || !schemaId.includes("/")) {
		throw new Error(`schema has no usable $id: ${JSON.stringify(schemaId)}`);
	}
	return schemaId.slice(schemaId.lastIndexOf("/") + 1);
}

async function readAlias(path) {
	return aliasFromId(JSON.parse(await readFile(path, "utf-8")).$id);
}

async function listReleased(historyDir) {
	const entries = await readdir(historyDir).catch(() => []);
	return entries.filter((entry) => entry.endsWith(".json")).sort();
}

export async function syncSchemaAliases({ specSource, historySource, schemaTarget }) {
	let emitted = 0;
	for (const family of SCHEMA_FAMILIES) {
		const currentRaw = await readFile(join(specSource, family.file), "utf-8");
		const currentAlias = aliasFromId(JSON.parse(currentRaw).$id);
		const familyTarget = join(schemaTarget, family.dir);
		await mkdir(familyTarget, { recursive: true });
		await writeFile(join(familyTarget, currentAlias), currentRaw, "utf-8");
		emitted += 1;

		const historyDir = join(historySource, family.dir);
		for (const alias of await listReleased(historyDir)) {
			if (alias === currentAlias) {
				throw new Error(
					`${family.dir}/${alias} exists in spec/history but is also the current $id; a released schema must never be re-cut`,
				);
			}
			await copyFile(join(historyDir, alias), join(familyTarget, alias));
			emitted += 1;
		}
	}
	return emitted;
}

function git(args, cwd) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
}

export function publishedAliasesByFamily(repoRoot) {
	const byFamily = publishedSchemasByFamily(repoRoot);
	if (!byFamily) return null;
	const published = new Map();
	for (const [dir, byVersion] of byFamily) published.set(dir, new Set(byVersion.keys()));
	return published;
}

/**
 * A key-order-independent serialization, so a released schema reformatted or with its keys
 * reordered does not read as mutated, while any change to what it actually declares does.
 */
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Every version each release tag published, with its content, grouped as
 * `family.dir -> version -> Set<canonical content>`. A version whose set holds more than one
 * entry was cut twice with differing content; a served file that matches none of them was mutated
 * after release.
 */
export function publishedSchemasByFamily(repoRoot) {
	const tags = git(["tag", "--list"], repoRoot)?.trim();
	if (!tags) return null;

	const published = new Map(SCHEMA_FAMILIES.map((family) => [family.dir, new Map()]));
	for (const tag of tags.split("\n").map((line) => line.trim()).filter(Boolean)) {
		for (const family of SCHEMA_FAMILIES) {
			const raw = git(["show", `${tag}:spec/${family.file}`], repoRoot);
			if (!raw) continue;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			const version = aliasFromId(parsed.$id);
			const byVersion = published.get(family.dir);
			if (!byVersion.has(version)) byVersion.set(version, new Set());
			byVersion.get(version).add(canonicalize(parsed));
		}
	}
	return published;
}

export async function checkSchemaAliases({ schemaTarget, repoRoot }) {
	const mismatches = [];
	const missing = [];
	const mutated = [];
	let checked = 0;
	const published = repoRoot ? publishedSchemasByFamily(repoRoot) : null;

	for (const family of SCHEMA_FAMILIES) {
		const familyTarget = join(schemaTarget, family.dir);
		const files = (await readdir(familyTarget).catch(() => [])).filter((entry) => entry.endsWith(".json"));
		for (const file of files) {
			const declared = await readAlias(join(familyTarget, file));
			checked += 1;
			if (declared !== basename(file)) {
				mismatches.push(`${family.dir}/${file} declares $id .../${declared}`);
			}
		}
		for (const [version, contents] of published?.get(family.dir) ?? []) {
			if (!files.includes(version)) {
				missing.push(`${family.dir}/${version} was published by a release tag but is no longer emitted`);
				continue;
			}
			let servedCanon;
			try {
				servedCanon = canonicalize(JSON.parse(await readFile(join(familyTarget, version), "utf-8")));
			} catch {
				continue;
			}
			// The schema URL is major.minor, so a patch release can refine a version's content; the
			// served file must match one of the releases that shipped it, not serve content no
			// release ever carried (which is how a version bumped mid-cycle keeps an old $id).
			if (!contents.has(servedCanon)) {
				mutated.push(`${family.dir}/${version} is served with content that no release tag ever published`);
			}
		}
	}

	return { checked, mismatches, missing, mutated, tagsAvailable: published !== null };
}
