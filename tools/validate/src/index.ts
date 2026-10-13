import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { resolveExtends, ManifestResolutionError } from "./resolve.js";
import { resolveSchema, type SchemaResolveOptions, type ResolvedSchema } from "./schema-resolve.js";
import { UnsupportedVersionError } from "./versions.js";
import { readEntryBlock } from "./entry.js";
import {
	isModManifest,
	validateEntrySource,
	validateManifest,
	validateModManifest,
	type ValidationResult,
} from "./core.js";

export * from "./core.js";
export { resolveExtends, resolveManifestFile, resolveProvenance, ManifestResolutionError, type Provenance } from "./resolve.js";
export { resolveSchema, type SchemaResolveOptions, type ResolvedSchema } from "./schema-resolve.js";

function unsupportedVersionResult(error: UnsupportedVersionError): ValidationResult {
	return { valid: false, errors: [{ path: "/", message: error.message, keyword: "version" }] };
}

/** Folds a schema resolution's fallback warning and version note into a result, and records its target. */
function applySchemaResolution(result: ValidationResult, resolved: ResolvedSchema): ValidationResult {
	const warnings = [...(result.warnings ?? [])];
	if (resolved.warning) warnings.push({ path: "/$schema", message: resolved.warning, keyword: "schema-fallback" });
	if (resolved.target?.note) warnings.push({ path: "/xript", message: resolved.target.note, keyword: "version-fallback" });
	return { ...result, warnings, ...(resolved.target ? { target: resolved.target } : {}) };
}

export interface VersionedValidationOptions extends SchemaResolveOptions {
	/** Force app or mod validation; detected from the manifest's content when omitted. */
	kind?: "app" | "mod";
	/** The directory a relative `$schema` resolves against. Defaults to the working directory. */
	baseDir?: string;
}

/**
 * Validates an in-memory manifest against the schema of the version it targets: an explicit
 * `version`, else its `$schema`, else its `xript` field, else the current version. The result's
 * `target` says which version answered and why. The file validators do the same for a path.
 */
export async function validateManifestVersioned(
	manifest: unknown,
	options: VersionedValidationOptions = {},
): Promise<ValidationResult> {
	const isMod = options.kind ? options.kind === "mod" : isModManifest(manifest);
	let resolvedSchema: ResolvedSchema;
	try {
		resolvedSchema = await resolveSchema(
			manifest,
			options.baseDir ?? process.cwd(),
			isMod ? "mod-manifest.schema.json" : "manifest.schema.json",
			options,
		);
	} catch (error) {
		if (error instanceof UnsupportedVersionError) return unsupportedVersionResult(error);
		throw error;
	}
	return applySchemaResolution(
		isMod ? await validateModManifest(manifest, resolvedSchema.schema) : await validateManifest(manifest, resolvedSchema.schema),
		resolvedSchema,
	);
}

export async function validateManifestFile(
	filePath: string,
	options: SchemaResolveOptions = {},
): Promise<ValidationResult & { filePath: string }> {
	const absolutePath = resolve(filePath);
	let raw: string;

	try {
		raw = await readFile(absolutePath, "utf-8");
	} catch {
		return {
			valid: false,
			filePath: absolutePath,
			errors: [
				{
					path: "/",
					message: `could not read file: ${absolutePath}`,
					keyword: "file",
				},
			],
		};
	}

	let manifest: unknown;
	try {
		manifest = JSON.parse(raw);
	} catch (e) {
		const parseError = e instanceof SyntaxError ? e.message : "Invalid JSON";
		return {
			valid: false,
			filePath: absolutePath,
			errors: [
				{
					path: "/",
					message: `invalid JSON: ${parseError}`,
					keyword: "parse",
				},
			],
		};
	}

	try {
		manifest = await resolveExtends(manifest, dirname(absolutePath));
	} catch (e) {
		if (e instanceof ManifestResolutionError) {
			return {
				valid: false,
				filePath: absolutePath,
				errors: [{ path: e.path, message: e.message, keyword: "extends" }],
			};
		}
		throw e;
	}

	const isMod = isModManifest(manifest);
	let resolvedSchema: ResolvedSchema;
	try {
		resolvedSchema = await resolveSchema(
			manifest,
			dirname(absolutePath),
			isMod ? "mod-manifest.schema.json" : "manifest.schema.json",
			options,
		);
	} catch (error) {
		if (error instanceof UnsupportedVersionError) return { ...unsupportedVersionResult(error), filePath: absolutePath };
		throw error;
	}

	const result = applySchemaResolution(
		isMod ? await validateModManifest(manifest, resolvedSchema.schema) : await validateManifest(manifest, resolvedSchema.schema),
		resolvedSchema,
	);
	if (isModManifest(manifest)) {
		const entrySource = await tryReadEntrySource(manifest, dirname(absolutePath));
		if (entrySource !== null) {
			const { errors, warnings } = validateEntrySource(manifest, entrySource);
			result.errors.push(...errors);
			if (warnings.length > 0) result.warnings = [...(result.warnings ?? []), ...warnings];
			result.valid = result.errors.length === 0;
		}
	}
	return { ...result, filePath: absolutePath };
}

export async function validateModManifestFile(
	filePath: string,
	options: SchemaResolveOptions = {},
): Promise<ValidationResult & { filePath: string }> {
	const absolutePath = resolve(filePath);
	let raw: string;

	try {
		raw = await readFile(absolutePath, "utf-8");
	} catch {
		return {
			valid: false,
			filePath: absolutePath,
			errors: [
				{
					path: "/",
					message: `could not read file: ${absolutePath}`,
					keyword: "file",
				},
			],
		};
	}

	let manifest: unknown;
	try {
		manifest = JSON.parse(raw);
	} catch (e) {
		const parseError = e instanceof SyntaxError ? e.message : "Invalid JSON";
		return {
			valid: false,
			filePath: absolutePath,
			errors: [
				{
					path: "/",
					message: `invalid JSON: ${parseError}`,
					keyword: "parse",
				},
			],
		};
	}

	let resolvedSchema: ResolvedSchema;
	try {
		resolvedSchema = await resolveSchema(manifest, dirname(absolutePath), "mod-manifest.schema.json", options);
	} catch (error) {
		if (error instanceof UnsupportedVersionError) return { ...unsupportedVersionResult(error), filePath: absolutePath };
		throw error;
	}
	const result = applySchemaResolution(await validateModManifest(manifest, resolvedSchema.schema), resolvedSchema);
	const entrySource = await tryReadEntrySource(manifest, dirname(absolutePath));
	if (entrySource !== null) {
		const { errors, warnings } = validateEntrySource(manifest, entrySource);
		result.errors.push(...errors);
		if (warnings.length > 0) result.warnings = [...(result.warnings ?? []), ...warnings];
		result.valid = result.errors.length === 0;
	}
	return { ...result, filePath: absolutePath };
}

async function tryReadEntrySource(manifest: unknown, baseDir: string): Promise<string | null> {
	const block = readEntryBlock(manifest);
	if (!block) return null;
	try {
		return await readFile(resolve(baseDir, block.script), "utf-8");
	} catch {
		return null;
	}
}
