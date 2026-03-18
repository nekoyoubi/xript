import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

export interface ValidationError {
	path: string;
	message: string;
	keyword: string;
}

interface AjvError {
	instancePath: string;
	message?: string;
	keyword: string;
	params: Record<string, unknown>;
}

let cachedSchema: object | null = null;
let cachedModSchema: object | null = null;

async function loadSchema(): Promise<object> {
	if (cachedSchema) return cachedSchema;
	const schemaPath = resolve(__dirname, "../../../spec/manifest.schema.json");
	const raw = await readFile(schemaPath, "utf-8");
	cachedSchema = JSON.parse(raw) as object;
	return cachedSchema;
}

async function loadModSchema(): Promise<object> {
	if (cachedModSchema) return cachedModSchema;
	const schemaPath = resolve(__dirname, "../../../spec/mod-manifest.schema.json");
	const raw = await readFile(schemaPath, "utf-8");
	cachedModSchema = JSON.parse(raw) as object;
	return cachedModSchema;
}

function formatError(error: AjvError): ValidationError {
	const path = error.instancePath || "/";
	let message = error.message || "Unknown validation error";

	if (error.keyword === "additionalProperties") {
		const extra = error.params.additionalProperty as string | undefined;
		message = `unexpected property "${extra}"`;
	} else if (error.keyword === "required") {
		const missing = error.params.missingProperty as string | undefined;
		message = `missing required property "${missing}"`;
	} else if (error.keyword === "pattern") {
		message = `does not match expected pattern: ${error.params.pattern}`;
	} else if (error.keyword === "enum") {
		const allowed = error.params.allowedValues as string[] | undefined;
		message = `must be one of: ${allowed?.join(", ")}`;
	}

	return { path, message, keyword: error.keyword };
}

export async function validateManifest(
	manifest: unknown,
): Promise<ValidationResult> {
	const schema = await loadSchema();
	const ajv = new Ajv({ allErrors: true, verbose: true });
	addFormats(ajv);

	const validate = ajv.compile(schema);
	const valid = validate(manifest) as boolean;

	if (valid) {
		return { valid: true, errors: [] };
	}

	const errors = ((validate.errors || []) as AjvError[]).map(formatError);
	return { valid: false, errors };
}

export async function validateModManifest(
	manifest: unknown,
): Promise<ValidationResult> {
	const schema = await loadModSchema();
	const ajv = new Ajv({ allErrors: true, verbose: true });
	addFormats(ajv);

	const validate = ajv.compile(schema);
	const valid = validate(manifest) as boolean;

	if (valid) {
		return { valid: true, errors: [] };
	}

	const errors = ((validate.errors || []) as AjvError[]).map(formatError);
	return { valid: false, errors };
}

export function isModManifest(manifest: unknown): boolean {
	if (typeof manifest !== "object" || manifest === null) return false;
	const obj = manifest as Record<string, unknown>;
	const hasModSignals = "fragments" in obj || "entry" in obj;
	const hasAppSignals = "bindings" in obj;
	return hasModSignals && !hasAppSignals;
}

export async function crossValidate(
	appManifest: unknown,
	modManifest: unknown,
): Promise<ValidationResult> {
	const errors: ValidationError[] = [];

	if (typeof appManifest !== "object" || appManifest === null) {
		return {
			valid: false,
			errors: [{ path: "/", message: "app manifest is not an object", keyword: "type" }],
		};
	}
	if (typeof modManifest !== "object" || modManifest === null) {
		return {
			valid: false,
			errors: [{ path: "/", message: "mod manifest is not an object", keyword: "type" }],
		};
	}

	const app = appManifest as Record<string, unknown>;
	const mod = modManifest as Record<string, unknown>;

	const slots = (app.slots ?? []) as Array<{ id: string; accepts: string[]; capability?: string }>;
	const slotMap = new Map(slots.map((s) => [s.id, s]));

	const fragments = (mod.fragments ?? []) as Array<{ id: string; slot: string; format: string }>;
	for (let i = 0; i < fragments.length; i++) {
		const frag = fragments[i];
		const slot = slotMap.get(frag.slot);

		if (!slot) {
			errors.push({
				path: `/fragments/${i}`,
				message: `targets slot "${frag.slot}" which does not exist in the app manifest`,
				keyword: "cross-slot",
			});
			continue;
		}

		if (!slot.accepts.includes(frag.format)) {
			errors.push({
				path: `/fragments/${i}`,
				message: `format "${frag.format}" is not accepted by slot "${frag.slot}" (accepts: ${slot.accepts.join(", ")})`,
				keyword: "cross-format",
			});
		}
	}

	const appCapabilities = app.capabilities as Record<string, unknown> | undefined;
	const modCapabilities = (mod.capabilities ?? []) as string[];
	for (const cap of modCapabilities) {
		if (!appCapabilities || !(cap in appCapabilities)) {
			errors.push({
				path: `/capabilities`,
				message: `requests capability "${cap}" which is not defined in the app manifest`,
				keyword: "cross-capability",
			});
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

export async function validateManifestFile(
	filePath: string,
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

	const result = isModManifest(manifest)
		? await validateModManifest(manifest)
		: await validateManifest(manifest);
	return { ...result, filePath: absolutePath };
}

export async function validateModManifestFile(
	filePath: string,
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

	const result = await validateModManifest(manifest);
	return { ...result, filePath: absolutePath };
}
