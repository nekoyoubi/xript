import { bundledSchema } from "./schemas.js";

/** The manifest version this toolchain answers for when nothing names one. */
export const CURRENT_SPEC_VERSION = "0.9";

/**
 * The manifest versions this toolchain can validate against, oldest first. Each has a schema:
 * the current one is the live `spec/*.schema.json`, every earlier one is the frozen document its
 * `$id` published, kept under `spec/history`.
 */
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = ["0.6", "0.7", "0.8", "0.9"];

/** Where the target version came from, in the order they are consulted. */
export type VersionSource = "option" | "$schema" | "xript" | "default";

export interface TargetVersion {
	/** The `major.minor` manifest version the tools answer for. */
	version: string;
	/** What decided it: an explicit option, the manifest's `$schema`, its `xript` field, or the default. */
	source: VersionSource;
	/** Set when the manifest named a version this toolchain does not speak and the default was used. */
	note?: string;
}

export type ManifestKind = "manifest" | "mod-manifest";

/** Thrown when a caller explicitly asks for a version this toolchain does not speak. */
export class UnsupportedVersionError extends Error {
	readonly requested: string;

	constructor(requested: string) {
		super(
			`xript ${requested} is not a manifest version this toolchain speaks; it speaks ${SUPPORTED_SPEC_VERSIONS.join(", ")} (default ${CURRENT_SPEC_VERSION})`,
		);
		this.name = "UnsupportedVersionError";
		this.requested = requested;
	}
}

const SCHEMA_URL = /^https:\/\/xript\.dev\/schema\/(manifest|mod-manifest)\/v(\d+\.\d+)\.json$/;

/** `0.8.1`, `v0.8`, and `0.8` all name the `0.8` line. */
export function normalizeSpecVersion(value: string): string {
	const match = /^v?(\d+)\.(\d+)/.exec(value.trim());
	return match ? `${Number(match[1])}.${Number(match[2])}` : value.trim();
}

/** The version a known xript schema URL names, or undefined for any other `$schema`. */
export function versionOfSchemaUrl(url: string): string | undefined {
	return SCHEMA_URL.exec(url)?.[2];
}

/**
 * Decides which manifest version the tools answer for. An explicit `version` wins and must be
 * one this toolchain speaks. Otherwise a known xript `$schema` URL names it, then the manifest's
 * own `xript` field. A manifest naming a version outside the supported set is answered for the
 * current version, and the result says so.
 */
export function resolveTargetVersion(manifest: unknown, explicit?: string): TargetVersion {
	if (explicit !== undefined) {
		const version = normalizeSpecVersion(explicit);
		if (!SUPPORTED_SPEC_VERSIONS.includes(version)) throw new UnsupportedVersionError(explicit);
		return { version, source: "option" };
	}

	const root = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>) : {};
	const declaredSchema = typeof root.$schema === "string" ? versionOfSchemaUrl(root.$schema) : undefined;
	if (declaredSchema !== undefined && SUPPORTED_SPEC_VERSIONS.includes(declaredSchema)) {
		return { version: declaredSchema, source: "$schema" };
	}

	const declared = typeof root.xript === "string" ? normalizeSpecVersion(root.xript) : undefined;
	if (declared !== undefined && SUPPORTED_SPEC_VERSIONS.includes(declared)) {
		return { version: declared, source: "xript" };
	}

	const named = declaredSchema ?? declared;
	if (named === undefined) return { version: CURRENT_SPEC_VERSION, source: "default" };
	return {
		version: CURRENT_SPEC_VERSION,
		source: "default",
		note: `the manifest names xript ${named}, which this toolchain does not speak (it speaks ${SUPPORTED_SPEC_VERSIONS.join(", ")}); answering for ${CURRENT_SPEC_VERSION}`,
	};
}

const XRIPT_SCHEMA_PREFIXES: ReadonlyArray<[string, ManifestKind]> = [
	["https://xript.dev/schema/manifest/", "manifest"],
	["https://xript.dev/schema/mod-manifest/", "mod-manifest"],
];

/** The manifest kind an xript-hosted schema URL belongs to, or undefined for any other `$schema`. */
export function xriptSchemaKind(url: string): ManifestKind | undefined {
	return XRIPT_SCHEMA_PREFIXES.find(([prefix]) => url.startsWith(prefix))?.[1];
}

/**
 * The schema a manifest of `kind` is validated against at `version`: the live schema for the
 * current version, the frozen published document for an earlier one.
 */
export async function loadSpecSchema(version: string, kind: ManifestKind): Promise<object> {
	const normalized = normalizeSpecVersion(version);
	if (!SUPPORTED_SPEC_VERSIONS.includes(normalized)) throw new UnsupportedVersionError(version);
	return bundledSchema(
		normalized === CURRENT_SPEC_VERSION ? `${kind}.schema.json` : `history/${kind}/v${normalized}.json`,
	);
}

/** One line naming the version a tool answered for and why, for CLI and MCP output. */
export function describeTargetVersion(target: TargetVersion): string {
	const why: Record<VersionSource, string> = {
		option: "requested explicitly",
		$schema: "from the manifest's $schema",
		xript: "from the manifest's xript field",
		default: "the toolchain default",
	};
	return `xript ${target.version} (${why[target.source]})${target.note ? `; ${target.note}` : ""}`;
}
