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

async function loadSchema(): Promise<object> {
	if (cachedSchema) return cachedSchema;
	const schemaPath = resolve(__dirname, "../../../spec/manifest.schema.json");
	const raw = await readFile(schemaPath, "utf-8");
	cachedSchema = JSON.parse(raw) as object;
	return cachedSchema;
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

	const result = await validateManifest(manifest);
	return { ...result, filePath: absolutePath };
}
