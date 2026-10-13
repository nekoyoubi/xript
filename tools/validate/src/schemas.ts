import { BUNDLED_SCHEMA_SOURCES } from "./generated/schemas.js";

const parsed = new Map<string, object>();

/**
 * A schema compiled into the package at build time, by its path under `spec/` (for example
 * `manifest.schema.json` or `history/manifest/v0.8.json`). Bundling the documents rather than
 * reading them from disk is what lets the core entry run where there is no filesystem.
 */
export function bundledSchema(relativePath: string): object {
	const cached = parsed.get(relativePath);
	if (cached) return cached;
	const source = BUNDLED_SCHEMA_SOURCES[relativePath];
	if (source === undefined) throw new Error(`no bundled schema at "${relativePath}"`);
	const schema = JSON.parse(source) as object;
	parsed.set(relativePath, schema);
	return schema;
}
