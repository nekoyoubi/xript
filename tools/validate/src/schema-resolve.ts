import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Schema validation is not the security boundary — the capability model is — so honoring a
 * manifest's declared `$schema` grants it no power. The real concerns are working offline,
 * reproducibility, and fetch safety; those are handled by the on-disk cache, schema pinning,
 * the bundled-core fallback, and the optional remote restriction below.
 */

export interface SchemaResolveOptions {
	/** When true, never reach the network; remote ids fall back to bundled core. */
	disableRemote?: boolean;
	/** When set, only these exact URLs may be fetched remotely; others fall back to bundled core. */
	allowRemote?: string[];
	/** Injected fetch, for tests and hosts that want their own transport. */
	fetchImpl?: typeof fetch;
	/** Directory for the on-disk remote-schema cache. Defaults to an OS-temp xript cache dir. */
	cacheDir?: string;
}

export interface ResolvedSchema {
	/** The schema object to validate against. */
	schema: object;
	/** How the schema was resolved. */
	source: "bundled-known" | "bundled-fallback" | "local" | "remote-fetched" | "remote-cached";
	/** The declared `$schema`, when present. */
	declared?: string;
	/** A surfaced warning when resolution fell back to bundled core. */
	warning?: string;
}

const CORE_SCHEMA_PREFIX = "https://xript.dev/schema/manifest/";
const MOD_SCHEMA_PREFIX = "https://xript.dev/schema/mod-manifest/";

async function readBundled(fileName: string): Promise<object> {
	const bundled = resolve(__dirname, "./schema", fileName);
	try {
		return JSON.parse(await readFile(bundled, "utf-8")) as object;
	} catch {
		const source = resolve(__dirname, "../../../spec", fileName);
		return JSON.parse(await readFile(source, "utf-8")) as object;
	}
}

function declaredSchema(manifest: unknown): string | undefined {
	if (typeof manifest !== "object" || manifest === null) return undefined;
	const value = (manifest as Record<string, unknown>).$schema;
	return typeof value === "string" ? value : undefined;
}

function isRemote(ref: string): boolean {
	return /^https?:\/\//i.test(ref);
}

function knownBundledFile(ref: string): string | null {
	if (ref.startsWith(CORE_SCHEMA_PREFIX)) return "manifest.schema.json";
	if (ref.startsWith(MOD_SCHEMA_PREFIX)) return "mod-manifest.schema.json";
	return null;
}

function cachePath(cacheDir: string, url: string): string {
	const key = createHash("sha256").update(url).digest("hex");
	return join(cacheDir, `${key}.json`);
}

async function readCache(cacheDir: string, url: string): Promise<object | null> {
	try {
		const raw = await readFile(cachePath(cacheDir, url), "utf-8");
		return JSON.parse(raw) as object;
	} catch {
		return null;
	}
}

async function writeCache(cacheDir: string, url: string, schema: object): Promise<void> {
	try {
		await mkdir(cacheDir, { recursive: true });
		await writeFile(cachePath(cacheDir, url), JSON.stringify(schema), "utf-8");
	} catch {
		// A non-writable cache is non-fatal; resolution still succeeds for this run.
	}
}

/**
 * Resolves the schema a manifest should be validated against, honoring its declared `$schema`.
 *
 * Resolution order:
 *  1. A known xript schema id/URI → its bundled local schema.
 *  2. A local path (relative to the manifest's directory) → read from disk.
 *  3. A remote http(s) URL → served from the on-disk cache when present (pinned for
 *     reproducibility), otherwise fetched and cached.
 *
 * Offline, an uncached remote with no transport, or a disallowed/disabled remote falls back to
 * bundled core with a surfaced warning rather than hard-failing. Remote resolution is open by
 * default; an explicit `disableRemote` or `allowRemote` restriction opts out of openness.
 *
 * When no resolvable `$schema` is present, the supplied default bundled file is used and all
 * existing validation behavior is preserved.
 */
export async function resolveSchema(
	manifest: unknown,
	baseDir: string,
	defaultBundledFile: string,
	options: SchemaResolveOptions = {},
): Promise<ResolvedSchema> {
	const declared = declaredSchema(manifest);
	if (!declared) {
		return { schema: await readBundled(defaultBundledFile), source: "bundled-fallback" };
	}

	const knownFile = knownBundledFile(declared);
	if (knownFile) {
		return { schema: await readBundled(knownFile), source: "bundled-known", declared };
	}

	if (isRemote(declared)) {
		const cacheDir = options.cacheDir ?? join(tmpdir(), "xript-schema-cache");

		const cached = await readCache(cacheDir, declared);
		if (cached) {
			return { schema: cached, source: "remote-cached", declared };
		}

		const restricted =
			options.disableRemote === true ||
			(Array.isArray(options.allowRemote) && !options.allowRemote.includes(declared));
		if (restricted) {
			return {
				schema: await readBundled(defaultBundledFile),
				source: "bundled-fallback",
				declared,
				warning: `remote schema "${declared}" is not permitted by the active restriction; validating against bundled core`,
			};
		}

		const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
		if (!doFetch) {
			return {
				schema: await readBundled(defaultBundledFile),
				source: "bundled-fallback",
				declared,
				warning: `remote schema "${declared}" is uncached and no fetch transport is available; validating against bundled core`,
			};
		}

		try {
			const response = await doFetch(declared);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const fetched = (await response.json()) as object;
			await writeCache(cacheDir, declared, fetched);
			return { schema: fetched, source: "remote-fetched", declared };
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			return {
				schema: await readBundled(defaultBundledFile),
				source: "bundled-fallback",
				declared,
				warning: `could not fetch remote schema "${declared}" (${reason}); validating against bundled core`,
			};
		}
	}

	// A local reference: a `file://` URI, or a path resolved relative to the manifest
	// (the way `extends` resolves). `file://` is accepted because the core schema asserts
	// `format: uri` on `$schema`, which a bare relative path cannot satisfy.
	const localPath = declared.startsWith("file:")
		? fileURLToPath(declared)
		: resolve(baseDir, declared);
	try {
		const raw = await readFile(localPath, "utf-8");
		return { schema: JSON.parse(raw) as object, source: "local", declared };
	} catch {
		return {
			schema: await readBundled(defaultBundledFile),
			source: "bundled-fallback",
			declared,
			warning: `could not read local schema "${declared}" relative to the manifest; validating against bundled core`,
		};
	}
}
