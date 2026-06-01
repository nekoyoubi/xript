import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveExtends, ManifestResolutionError } from "./resolve.js";
import { detectCommonJs, commonJsMessage } from "./cjs.js";

export { resolveExtends, resolveManifestFile, ManifestResolutionError } from "./resolve.js";
export { detectCommonJs, commonJsMessage, COMMONJS_GUIDE_URL } from "./cjs.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	warnings?: ValidationWarning[];
}

export interface ValidationError {
	path: string;
	message: string;
	keyword: string;
}

export interface ValidationWarning {
	path: string;
	message: string;
	keyword: string;
}

export type GrantShape = "capability-prompt" | "install-descriptor" | "discovery-result" | "debug-messages";

const SHAPE_SCHEMA_FILES: Record<GrantShape, string> = {
	"capability-prompt": "capability-prompt.schema.json",
	"install-descriptor": "install-descriptor.schema.json",
	"discovery-result": "discovery-result.schema.json",
	"debug-messages": "debug-messages.schema.json",
};

interface AjvError {
	instancePath: string;
	message?: string;
	keyword: string;
	params: Record<string, unknown>;
}

let cachedSchema: object | null = null;
let cachedModSchema: object | null = null;

async function readSchemaFile(fileName: string): Promise<string> {
	const bundled = resolve(__dirname, "./schema", fileName);
	try {
		return await readFile(bundled, "utf-8");
	} catch {
		const source = resolve(__dirname, "../../../spec", fileName);
		return await readFile(source, "utf-8");
	}
}

async function loadSchema(): Promise<object> {
	if (cachedSchema) return cachedSchema;
	const raw = await readSchemaFile("manifest.schema.json");
	cachedSchema = JSON.parse(raw) as object;
	return cachedSchema;
}

async function loadModSchema(): Promise<object> {
	if (cachedModSchema) return cachedModSchema;
	const raw = await readSchemaFile("mod-manifest.schema.json");
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

	const warnings = validateFieldEnums(manifest);

	if (valid) {
		return { valid: true, errors: [], warnings };
	}

	const errors = ((validate.errors || []) as AjvError[]).map(formatError);
	return { valid: false, errors, warnings };
}

export async function validateShape(
	shape: GrantShape,
	document: unknown,
): Promise<ValidationResult> {
	const fileName = SHAPE_SCHEMA_FILES[shape];
	if (!fileName) {
		return {
			valid: false,
			errors: [{ path: "/", message: `unknown shape "${shape}"`, keyword: "shape" }],
		};
	}

	const raw = await readSchemaFile(fileName);
	const schema = JSON.parse(raw) as object;
	const ajv = new Ajv({ allErrors: true, verbose: true });
	addFormats(ajv);

	const validate = ajv.compile(schema);
	const valid = validate(document) as boolean;
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

	const errors = valid ? [] : ((validate.errors || []) as AjvError[]).map(formatError);
	errors.push(...validateExportCapabilities(manifest));
	errors.push(...validateProviderRoles(manifest));

	const warnings = validateProviderRoleFns(manifest);

	return { valid: errors.length === 0, errors, warnings };
}

function validateProviderRoles(manifest: unknown): ValidationError[] {
	const provides = readProvides(manifest);
	if (!provides) return [];

	const errors: ValidationError[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < provides.length; i++) {
		const entry = provides[i];
		if (typeof entry !== "object" || entry === null) continue;
		const role = (entry as Record<string, unknown>).role;
		if (typeof role !== "string") continue;
		if (seen.has(role)) {
			errors.push({
				path: `/contributions/provides/${i}`,
				message: `duplicate role "${role}" within this mod's provides[]`,
				keyword: "duplicate-role",
			});
		}
		seen.add(role);
	}
	return errors;
}

function validateProviderRoleFns(manifest: unknown): ValidationWarning[] {
	const provides = readProvides(manifest);
	if (!provides) return [];

	const mod = manifest as Record<string, unknown>;
	const entry = mod.entry;
	const exportNames = new Set<string>();
	let hasExports = false;
	if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
		const exportsMap = (entry as Record<string, unknown>).exports;
		if (typeof exportsMap === "object" && exportsMap !== null) {
			hasExports = true;
			for (const name of Object.keys(exportsMap as Record<string, unknown>)) {
				exportNames.add(name);
			}
		}
	}

	if (!hasExports) return [];

	const warnings: ValidationWarning[] = [];
	for (let i = 0; i < provides.length; i++) {
		const entryItem = provides[i];
		if (typeof entryItem !== "object" || entryItem === null) continue;
		const fns = (entryItem as Record<string, unknown>).fns;
		if (typeof fns !== "object" || fns === null) continue;
		for (const [logical, concrete] of Object.entries(fns as Record<string, unknown>)) {
			if (typeof concrete === "string" && !exportNames.has(concrete)) {
				warnings.push({
					path: `/contributions/provides/${i}/fns/${logical}`,
					message: `role fn "${concrete}" is not a declared export; assuming a registered global`,
					keyword: "provides-fn-unbound",
				});
			}
		}
	}
	return warnings;
}

function readProvides(manifest: unknown): unknown[] | null {
	if (typeof manifest !== "object" || manifest === null) return null;
	const mod = manifest as Record<string, unknown>;
	const contributions = mod.contributions;
	if (typeof contributions !== "object" || contributions === null) return null;
	const provides = (contributions as Record<string, unknown>).provides;
	if (!Array.isArray(provides)) return null;
	return provides;
}

const VALUE_TYPE_FOR_PRIMITIVE: Record<string, "string" | "number" | "boolean"> = {
	string: "string",
	number: "number",
	boolean: "boolean",
};

function validateFieldEnums(manifest: unknown): ValidationWarning[] {
	if (typeof manifest !== "object" || manifest === null) return [];
	const types = (manifest as Record<string, unknown>).types;
	if (typeof types !== "object" || types === null) return [];

	const warnings: ValidationWarning[] = [];
	for (const [typeName, typeDef] of Object.entries(types as Record<string, unknown>)) {
		if (typeof typeDef !== "object" || typeDef === null) continue;
		const fields = (typeDef as Record<string, unknown>).fields;
		if (typeof fields !== "object" || fields === null) continue;
		for (const [fieldName, field] of Object.entries(fields as Record<string, unknown>)) {
			if (typeof field !== "object" || field === null) continue;
			const f = field as Record<string, unknown>;
			const enumValues = f.enum;
			const fieldType = f.type;
			if (!Array.isArray(enumValues) || typeof fieldType !== "string") continue;
			const expected = VALUE_TYPE_FOR_PRIMITIVE[fieldType];
			if (!expected) continue;
			for (const value of enumValues) {
				if (typeof value !== expected) {
					warnings.push({
						path: `/types/${typeName}/fields/${fieldName}/enum`,
						message: `enum value ${JSON.stringify(value)} does not match declared field type "${fieldType}"`,
						keyword: "enum-type-mismatch",
					});
				}
			}
		}
	}
	return warnings;
}

function validateExportCapabilities(manifest: unknown): ValidationError[] {
	if (typeof manifest !== "object" || manifest === null) return [];
	const mod = manifest as Record<string, unknown>;
	const entry = mod.entry;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];

	const exportsMap = (entry as Record<string, unknown>).exports;
	if (typeof exportsMap !== "object" || exportsMap === null) return [];

	const declared = new Set(Array.isArray(mod.capabilities) ? (mod.capabilities as string[]) : []);
	const errors: ValidationError[] = [];

	for (const [name, def] of Object.entries(exportsMap as Record<string, unknown>)) {
		if (typeof def !== "object" || def === null) continue;
		const capability = (def as Record<string, unknown>).capability;
		if (typeof capability === "string" && !declared.has(capability)) {
			errors.push({
				path: `/entry/exports/${name}`,
				message: `export "${name}" requires capability "${capability}" which is not declared in the mod's capabilities`,
				keyword: "export-capability",
			});
		}
	}

	return errors;
}

function readEntryBlock(manifest: unknown): { script: string; format: string; exports: string[] } | null {
	if (typeof manifest !== "object" || manifest === null) return null;
	const entry = (manifest as Record<string, unknown>).entry;
	if (typeof entry === "string") {
		return { script: entry, format: "script", exports: [] };
	}
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
	const block = entry as Record<string, unknown>;
	const script = typeof block.script === "string" ? block.script : "";
	if (!script) return null;
	const format = typeof block.format === "string" ? block.format : "script";
	const exportsMap = block.exports;
	const exportNames =
		typeof exportsMap === "object" && exportsMap !== null
			? Object.keys(exportsMap as Record<string, unknown>)
			: [];
	return { script, format, exports: exportNames };
}

const STATIC_IMPORT = /^\s*import\s+(?:[^'"]*\bfrom\b\s*)?["'][^"']+["']/m;
const IMPORT_SPECIFIER = /from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/;
const TOP_LEVEL_EXPORT_FN = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const TOP_LEVEL_EXPORT_CONST = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const NAMED_EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/gm;

function collectTopLevelExports(source: string): Set<string> {
	const names = new Set<string>();
	let match: RegExpExecArray | null;
	const fnRe = new RegExp(TOP_LEVEL_EXPORT_FN.source, "gm");
	while ((match = fnRe.exec(source)) !== null) names.add(match[1]);
	const constRe = new RegExp(TOP_LEVEL_EXPORT_CONST.source, "gm");
	while ((match = constRe.exec(source)) !== null) names.add(match[1]);
	const listRe = new RegExp(NAMED_EXPORT_LIST.source, "gm");
	while ((match = listRe.exec(source)) !== null) {
		for (const raw of match[1].split(",")) {
			const part = raw.trim();
			if (!part) continue;
			const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(part);
			names.add(asMatch ? asMatch[1] : part.split(/\s/)[0]);
		}
	}
	return names;
}

/**
 * Validates a mod entry source against the CommonJS guard, the module-mode
 * external-import lint, and module-export reconciliation. The CommonJS check
 * is a hard error; the import lint is a will-be-denied-at-load error; the
 * export reconciliation is a warning (the runtime is authoritative).
 */
export function validateEntrySource(
	manifest: unknown,
	source: string,
): { errors: ValidationError[]; warnings: ValidationWarning[] } {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	const artifact = detectCommonJs(source);
	if (artifact) {
		errors.push({ path: "/entry", message: commonJsMessage(artifact), keyword: "commonjs-detected" });
	}

	const block = readEntryBlock(manifest);
	if (!block) return { errors, warnings };

	if (block.format === "module") {
		if (STATIC_IMPORT.test(source)) {
			const specMatch = IMPORT_SPECIFIER.exec(source);
			const specifier = specMatch ? specMatch[1] || specMatch[2] : "<unknown>";
			errors.push({
				path: "/entry",
				message: `import of "${specifier}" will be denied at load time; xript mods cannot import external modules`,
				keyword: "import-denied",
			});
		}

		if (block.exports.length > 0) {
			const detected = collectTopLevelExports(source);
			for (const name of block.exports) {
				if (!detected.has(name)) {
					warnings.push({
						path: `/entry/exports/${name}`,
						message: `declared export "${name}" has no detectable top-level export in the entry module; the runtime is authoritative, but typed authoring expects a matching top-level export`,
						keyword: "export-unbound",
					});
				}
			}
		}
	}

	return { errors, warnings };
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

	const result = isModManifest(manifest)
		? await validateModManifest(manifest)
		: await validateManifest(manifest);
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
