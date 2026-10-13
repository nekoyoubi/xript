
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
	sanitizeFragment,
	resolveFormatProfile,
	FormatProfileError,
	FragmentParseError,
} from "@xriptjs/sanitize";
import { satisfies, grantedSatisfies } from "./capabilities.js";
import { detectCommonJs, commonJsMessage } from "./cjs.js";
import { commandDefects, declaredExportNames, isCommandSlot } from "./commands.js";
import { readEntryBlock } from "./entry.js";
import { bundledSchema } from "./schemas.js";
import {
	UnsupportedVersionError,
	loadSpecSchema,
	resolveTargetVersion,
	xriptSchemaKind,
	type TargetVersion,
} from "./versions.js";

export {
	CURRENT_SPEC_VERSION,
	SUPPORTED_SPEC_VERSIONS,
	UnsupportedVersionError,
	resolveTargetVersion,
	loadSpecSchema,
	normalizeSpecVersion,
	versionOfSchemaUrl,
	xriptSchemaKind,
	describeTargetVersion,
	type TargetVersion,
	type VersionSource,
	type ManifestKind,
} from "./versions.js";

export { detectCommonJs, commonJsMessage, COMMONJS_GUIDE_URL } from "./cjs.js";
export {
	widenExecutionIntent,
	resolveExecutionIntent,
	declaredExecutionIntent,
	resolveInvokeIntent,
	executionSurfaces,
	isDefaultIntent,
	compareDuration,
	DURATION_ORDER,
	AFFINITY_ORDER,
	DEFAULT_EXECUTION_INTENT,
	DURATION_PROSE,
	AFFINITY_PROSE,
	HOST_BINDING_THREAD_CONTRACT,
	ASYNC_SHAPE_REMARK,
	LIMITS_REACH_REMARK,
	type Duration,
	type Affinity,
	type ExecutionIntent,
	type ResolvedExecutionIntent,
	type ExecutionSurface,
	type SurfaceKind,
	type InvokeIntentOptions,
} from "./execution.js";

/** Ajv and ajv-formats are CommonJS; Node hands back `module.exports`, a bundler may hand back `exports.default`. */
function interopDefault<T>(mod: unknown): T {
	const withDefault = mod as { default?: unknown };
	return (withDefault.default ?? mod) as T;
}

const Ajv = interopDefault<any>(Ajv2020Module);
const addFormats = interopDefault<(ajv: unknown) => void>(addFormatsModule);

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	warnings?: ValidationWarning[];
	/** The manifest version validated against, when the schema was chosen by version. */
	target?: TargetVersion;
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
	/** Populated under Ajv `verbose`; the branch schema an error came from, by object identity. */
	parentSchema?: object;
}

/**
 * A failed `oneOf` reports every branch's errors plus a bare meta-error, so a namespace binding
 * that only forgot its `description` came back with four lines — including `unexpected property
 * "members"` from the function branch, which would tell the author to delete the very key that
 * makes it a namespace. This keeps only the branch that came closest and drops the meta.
 *
 * For each `oneOf` (deepest path first, so a nested one resolves before its parent): if a branch
 * matched at the failure path and failed deeper, the branches that failed shallowly are noise and
 * their direct errors are dropped. Otherwise every branch failed at that path, so the branches are
 * partitioned by `parentSchema` identity and only the smallest survives. The meta-error is dropped
 * whenever a real error remains to explain the failure.
 */
function collapseOneOf(errors: AjvError[]): AjvError[] {
	const metas = errors.filter((e) => e.keyword === "oneOf");
	if (metas.length === 0) return errors;

	const byDepth = [...metas].sort((a, b) => b.instancePath.length - a.instancePath.length);
	let kept = errors;
	for (const meta of byDepth) {
		if (!kept.includes(meta)) continue;
		const p = meta.instancePath;
		const under = kept.filter(
			(e) => e !== meta && e.keyword !== "oneOf" && (e.instancePath === p || e.instancePath.startsWith(`${p}/`)),
		);
		const direct = under.filter((e) => e.instancePath === p);
		const deeper = under.length - direct.length;
		const drop = new Set<AjvError>();

		if (deeper > 0) {
			for (const e of direct) drop.add(e);
		} else {
			const branches = new Map<object, AjvError[]>();
			for (const e of direct) {
				const key = e.parentSchema ?? meta;
				(branches.get(key) ?? branches.set(key, []).get(key)!).push(e);
			}
			if (branches.size > 1) {
				const sorted = [...branches.values()].sort((a, b) => a.length - b.length);
				for (const branch of sorted.slice(1)) for (const e of branch) drop.add(e);
			}
		}

		const survivors = under.filter((e) => !drop.has(e));
		const dropMeta = survivors.length > 0;
		kept = kept.filter((e) => !drop.has(e) && !(e === meta && dropMeta));
	}
	return kept;
}

async function loadSchema(): Promise<object> {
	return bundledSchema("manifest.schema.json");
}

async function loadModSchema(): Promise<object> {
	return bundledSchema("mod-manifest.schema.json");
}

function schemaId(schema: object): string | undefined {
	const id = (schema as Record<string, unknown>).$id;
	return typeof id === "string" ? id : undefined;
}

const LEGACY_SCHEMA_IDS: Record<string, string[]> = {
	"https://xript.dev/schema/manifest/v0.9.json": [
		"https://xript.dev/schema/manifest/v0.8.json",
		"https://xript.dev/schema/manifest/v0.7.json",
		"https://xript.dev/schema/manifest/v0.6.json",
		"https://xript.dev/schema/manifest/v0.3.json",
	],
	"https://xript.dev/schema/mod-manifest/v0.9.json": [
		"https://xript.dev/schema/mod-manifest/v0.8.json",
		"https://xript.dev/schema/mod-manifest/v0.7.json",
		"https://xript.dev/schema/mod-manifest/v0.6.json",
		"https://xript.dev/schema/mod-manifest/v0.3.json",
	],
};

/**
 * Registers the bundled core/mod schemas as referenceable resources so a domain overlay can
 * `$ref` the core by its canonical `$id`. Each schema is also registered under its prior `$id`
 * so an overlay still pinning the old id resolves. Skips any id matching the schema being
 * compiled, which would otherwise be a duplicate-id error in Ajv.
 */
async function addBundledRefs(ajv: { addSchema(s: object): void }, compiling: object): Promise<void> {
	const compilingId = schemaId(compiling);
	for (const schema of [await loadSchema(), await loadModSchema()]) {
		const id = schemaId(schema);
		if (id && id !== compilingId) {
			ajv.addSchema(schema);
		}
		for (const legacyId of (id ? LEGACY_SCHEMA_IDS[id] : undefined) ?? []) {
			if (legacyId !== compilingId) {
				ajv.addSchema({ ...schema, $id: legacyId });
			}
		}
	}
}

function formatError(error: AjvError): ValidationError {
	const path = error.instancePath || "/";
	let message = error.message || "Unknown validation error";

	if (error.keyword === "additionalProperties") {
		const extra = error.params.additionalProperty as string | undefined;
		message = `unexpected property "${extra}"`;
	} else if (error.keyword === "unevaluatedProperties") {
		const extra = error.params.unevaluatedProperty as string | undefined;
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

/**
 * Unknown top-level keys are advisory, not fatal. The runtime reads only declared vocabulary and
 * ignores stray top-level keys, so a hard error would block a key that has no runtime effect. This
 * pulls the top-level closure findings out of the error list and re-emits them as warnings that
 * point at the surfaces that are read. Deeper closures (a nested `additionalProperties`) stay
 * errors; a key a declared `$schema` overlay accounts for is evaluated and never reaches here.
 */
function demoteUnknownTopLevelKeys(errors: ValidationError[]): {
	errors: ValidationError[];
	warnings: ValidationWarning[];
} {
	const kept: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];
	for (const error of errors) {
		if (error.keyword === "unevaluatedProperties" && error.path === "/") {
			const key = error.message.match(/"([^"]+)"/)?.[1];
			warnings.push({
				path: "/",
				message: key
					? `unrecognized top-level key "${key}"; the runtime reads only declared vocabulary and ignores stray keys. Route consumable data through a typed surface (a data fill into a data slot, or a binding), or declare it in a $schema overlay.`
					: error.message,
				keyword: "unknown-key",
			});
		} else {
			kept.push(error);
		}
	}
	return { errors: kept, warnings };
}

/**
 * True when a schema closes itself at the top level (declares `unevaluatedProperties`
 * or `additionalProperties`). Open schemas — the core manifest schema, which stays open
 * so overlays can extend it — get closed by a wrapper at validation time instead.
 */
function topLevelCloses(schema: unknown): boolean {
	return (
		typeof schema === "object" &&
		schema !== null &&
		("unevaluatedProperties" in schema || "additionalProperties" in schema)
	);
}

export async function validateManifest(
	manifest: unknown,
	schemaOverride?: object,
): Promise<ValidationResult> {
	const schema = schemaOverride ?? (await loadSchema());
	const ajv = new Ajv({ allErrors: true, verbose: true });
	addFormats(ajv);

	let toCompile: object = schema;
	const schemaId = (schema as { $id?: string }).$id;
	if (!topLevelCloses(schema) && schemaId) {
		// The core manifest schema is open at the top level so a domain overlay can
		// extend it via `allOf`. The wrapper's `unevaluatedProperties` flags top-level
		// keys the referenced schema never evaluated; those are demoted to warnings
		// (the runtime ignores stray keys) while deeper closures stay hard errors.
		// (Putting the close inside the core schema would fire within its own `$ref`
		// scope and flag a sibling overlay branch's properties, so it lives here.)
		ajv.addSchema(schema);
		await addBundledRefs(ajv, schema);
		toCompile = { type: "object", allOf: [{ $ref: schemaId }], unevaluatedProperties: false };
	} else if (schemaOverride) {
		await addBundledRefs(ajv, schema);
	}

	const validate = ajv.compile(toCompile);
	const valid = validate(manifest) as boolean;

	const warnings = validateFieldEnums(manifest);
	warnings.push(...validateDeprecatedJ5mlSpellings(manifest));
	const parameterErrors = validateParameterLists(manifest);

	if (valid) {
		return { valid: parameterErrors.length === 0, errors: parameterErrors, warnings };
	}

	const mapped = collapseOneOf((validate.errors || []) as AjvError[]).map(formatError);
	const { errors, warnings: unknownKeyWarnings } = demoteUnknownTopLevelKeys(mapped);
	warnings.push(...unknownKeyWarnings);
	errors.push(...parameterErrors);
	return { valid: errors.length === 0, errors, warnings };
}

/**
 * Checks the rules a parameter list carries that the schema cannot express: only the last
 * parameter may be `variadic` (it absorbs every remaining argument, so nothing can follow it),
 * and `optional` is the inverse alias of `required`, so a parameter giving both must agree.
 */
function parameterListErrors(params: unknown, path: string): ValidationError[] {
	if (!Array.isArray(params)) return [];
	const errors: ValidationError[] = [];
	params.forEach((param, index) => {
		if (typeof param !== "object" || param === null) return;
		const p = param as Record<string, unknown>;
		if (p.variadic === true && index !== params.length - 1) {
			errors.push({
				path: `${path}/${index}/variadic`,
				message: `parameter "${String(p.name)}" is variadic but is not the last parameter; a variadic parameter absorbs every remaining argument, so it must come last`,
				keyword: "variadic-position",
			});
		}
		if (typeof p.optional === "boolean" && typeof p.required === "boolean" && p.optional === p.required) {
			errors.push({
				path: `${path}/${index}`,
				message: `parameter "${String(p.name)}" declares "optional": ${p.optional} and "required": ${p.required}, which disagree; "optional" is the inverse of "required", so give one`,
				keyword: "optional-required-conflict",
			});
		}
	});
	return errors;
}

function validateParameterLists(manifest: unknown): ValidationError[] {
	if (typeof manifest !== "object" || manifest === null) return [];
	const root = manifest as Record<string, unknown>;
	const errors: ValidationError[] = [];
	const walkBindings = (bindings: unknown, path: string): void => {
		if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return;
		for (const [name, def] of Object.entries(bindings as Record<string, unknown>)) {
			if (typeof def !== "object" || def === null) continue;
			const d = def as Record<string, unknown>;
			const at = `${path}/${pointerSegment(name)}`;
			if (d.members !== undefined) walkBindings(d.members, `${at}/members`);
			else errors.push(...parameterListErrors(d.params, `${at}/params`));
		}
	};
	walkBindings(root.bindings, "/bindings");
	if (typeof root.hooks === "object" && root.hooks !== null) {
		for (const [name, def] of Object.entries(root.hooks as Record<string, unknown>)) {
			if (typeof def !== "object" || def === null) continue;
			errors.push(...parameterListErrors((def as Record<string, unknown>).params, `/hooks/${pointerSegment(name)}/params`));
		}
	}
	const entry = root.entry;
	if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
		const exportsMap = (entry as Record<string, unknown>).exports;
		if (typeof exportsMap === "object" && exportsMap !== null) {
			for (const [name, def] of Object.entries(exportsMap as Record<string, unknown>)) {
				if (typeof def !== "object" || def === null) continue;
				errors.push(
					...parameterListErrors((def as Record<string, unknown>).params, `/entry/exports/${pointerSegment(name)}/params`),
				);
			}
		}
	}
	return errors;
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

	const schema = bundledSchema(fileName);
	const ajv = new Ajv({ allErrors: true, verbose: true });
	addFormats(ajv);

	const validate = ajv.compile(schema);
	const valid = validate(document) as boolean;
	if (valid) {
		return { valid: true, errors: [] };
	}
	const errors = collapseOneOf((validate.errors || []) as AjvError[]).map(formatError);
	return { valid: false, errors };
}

export async function validateModManifest(
	manifest: unknown,
	schemaOverride?: object,
): Promise<ValidationResult> {
	const schema = schemaOverride ?? (await loadModSchema());
	const ajv = new Ajv({ allErrors: true, verbose: true });
	addFormats(ajv);

	let toCompile: object = schema;
	const modSchemaId = (schema as { $id?: string }).$id;
	if (!topLevelCloses(schema) && modSchemaId) {
		// The mod schema is open at the top level so a host overlay can extend it via
		// `$schema` + `allOf`; the wrapper flags top-level keys nothing evaluated so they
		// surface as warnings (the runtime ignores stray keys). Mirrors `validateManifest`.
		ajv.addSchema(schema);
		await addBundledRefs(ajv, schema);
		toCompile = { type: "object", allOf: [{ $ref: modSchemaId }], unevaluatedProperties: false };
	} else if (schemaOverride) {
		await addBundledRefs(ajv, schema);
	}

	const validate = ajv.compile(toCompile);
	const valid = validate(manifest) as boolean;

	const mapped = valid ? [] : collapseOneOf((validate.errors || []) as AjvError[]).map(formatError);
	const { errors, warnings: unknownKeyWarnings } = demoteUnknownTopLevelKeys(mapped);
	errors.push(...validateExportCapabilities(manifest));
	errors.push(...validateProviderRoles(manifest));
	errors.push(...validateParameterLists(manifest));

	const warnings = [...unknownKeyWarnings, ...validateProviderRoleFns(manifest)];
	warnings.push(...validateLegacyContributionShapes(manifest));

	return { valid: errors.length === 0, errors, warnings };
}

function validateLegacyContributionShapes(manifest: unknown): ValidationWarning[] {
	const warnings: ValidationWarning[] = [];
	if (typeof manifest !== "object" || manifest === null) return warnings;
	const mod = manifest as Record<string, unknown>;
	if ("fragments" in mod) {
		warnings.push({
			path: "/fragments",
			message: "'fragments' is deprecated; declare them as fills of a fragment-format slot under 'fills'",
			keyword: "deprecated",
		});
	}
	if ("contributions" in mod) {
		warnings.push({
			path: "/contributions",
			message: "'contributions' is deprecated; move slot fills and provider roles under 'fills', keyed by host slot id",
			keyword: "deprecated",
		});
	}
	return warnings;
}

const DEPRECATED_J5ML_FORMAT = "application/jsml+json";
const CANONICAL_J5ML_FORMAT = "application/j5ml+json";

/** RFC 6901 escaping, so a media-type key's slashes don't split the pointer. */
function pointerSegment(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * `jsml` is an accepted but deprecated spelling of `j5ml`, in both the built-in
 * media type and a format's `syntax`. Both parse identically; these warnings
 * point authors at the canonical spelling without failing the manifest.
 */
function validateDeprecatedJ5mlSpellings(manifest: unknown): ValidationWarning[] {
	const warnings: ValidationWarning[] = [];
	if (typeof manifest !== "object" || manifest === null) return warnings;
	const root = manifest as Record<string, unknown>;

	const slots = root.slots;
	if (Array.isArray(slots)) {
		slots.forEach((slot, slotIndex) => {
			if (typeof slot !== "object" || slot === null) return;
			const accepts = (slot as Record<string, unknown>).accepts;
			const list = Array.isArray(accepts) ? accepts : [accepts];
			list.forEach((entry, acceptsIndex) => {
				if (entry !== DEPRECATED_J5ML_FORMAT) return;
				warnings.push({
					path: Array.isArray(accepts)
						? `/slots/${slotIndex}/accepts/${acceptsIndex}`
						: `/slots/${slotIndex}/accepts`,
					message: `'${DEPRECATED_J5ML_FORMAT}' is a deprecated spelling of '${CANONICAL_J5ML_FORMAT}'; both parse identically`,
					keyword: "deprecated",
				});
			});
		});
	}

	const formats = root.formats;
	if (typeof formats === "object" && formats !== null) {
		for (const [formatId, declaration] of Object.entries(formats as Record<string, unknown>)) {
			if (typeof declaration !== "object" || declaration === null) continue;
			if ((declaration as Record<string, unknown>).syntax !== "jsml") continue;
			warnings.push({
				path: `/formats/${pointerSegment(formatId)}/syntax`,
				message: "'jsml' is a deprecated spelling of 'j5ml'; both parse identically",
				keyword: "deprecated",
			});
		}
	}

	return warnings;
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
		if (typeof capability === "string" && !grantedSatisfies(declared, capability)) {
			errors.push({
				path: `/entry/exports/${name}`,
				message: `export "${name}" requires capability "${capability}" which is not declared in the mod's capabilities`,
				keyword: "export-capability",
			});
		}
	}

	return errors;
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
	const hasModSignals = "fragments" in obj || "entry" in obj || "fills" in obj || "contributions" in obj;
	const hasAppSignals = "bindings" in obj;
	return hasModSignals && !hasAppSignals;
}

export interface CrossValidateOptions {
	/**
	 * Validate each fill's payload against the target slot's `payload` JSON Schema.
	 * Default true. The schema is applied as authored — a slot whose payload allows
	 * additional properties still accepts a fill that carries more than it declares;
	 * only a slot that explicitly closes its payload rejects extras. Flip off to skip
	 * payload conformance and check only slot existence, accepted formats, and gates.
	 */
	checkFillPayloads?: boolean;
}

/**
 * A fill is a fragment fill when it carries both a string `format` and a string `source` —
 * the same test the runtimes apply. A code-renderer fill carries `entry`, a data fill carries
 * arbitrary payload members; neither is markup, and neither is checked against a vocabulary.
 */
function isFragmentFill(fill: unknown): fill is { format: string; source: string; inline?: boolean } {
	if (typeof fill !== "object" || fill === null) return false;
	const f = fill as Record<string, unknown>;
	return typeof f.format === "string" && typeof f.source === "string";
}

/**
 * Checks an inline fragment source against the vocabulary its format declares. Errors are the
 * defects a runtime would refuse the mod for (an undeclared node in a host-declared vocabulary);
 * warnings are the things it would drop and report (an undeclared prop, a stripped element). A
 * non-inline source is a file path the validator cannot read from a manifest pair, so it is skipped.
 */
function vocabularyFindings(
	fill: { format: string; source: string; inline?: boolean },
	path: string,
	formats: Record<string, unknown> | undefined,
	vocabularies: Record<string, unknown> | undefined,
): { errors: ValidationError[]; warnings: ValidationWarning[] } {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	let profile;
	try {
		profile = resolveFormatProfile(fill.format, formats ?? null, vocabularies ?? null);
	} catch (err) {
		if (err instanceof FormatProfileError) {
			errors.push({ path: `${path}/format`, message: err.message, keyword: "cross-fill-format" });
			return { errors, warnings };
		}
		throw err;
	}

	if (!profile) {
		errors.push({
			path: `${path}/format`,
			message: `unknown fragment format "${fill.format}" — declare it in the host manifest's 'formats' block`,
			keyword: "cross-fill-format",
		});
		return { errors, warnings };
	}

	if (fill.inline !== true) return { errors, warnings };

	let result;
	try {
		result = sanitizeFragment(fill.source, profile);
	} catch (err) {
		if (err instanceof FragmentParseError) {
			errors.push({ path: `${path}/source`, message: err.message, keyword: "cross-fill-vocabulary" });
			return { errors, warnings };
		}
		throw err;
	}

	for (const diagnostic of result.diagnostics) {
		const target = { path: `${path}/source${diagnostic.path}`, message: diagnostic.message };
		if (diagnostic.severity === "error") {
			errors.push({ ...target, keyword: "cross-fill-vocabulary" });
		} else {
			warnings.push({ ...target, keyword: "cross-fill-vocabulary" });
		}
	}

	return { errors, warnings };
}

export async function crossValidate(
	appManifest: unknown,
	modManifest: unknown,
	options: CrossValidateOptions = {},
): Promise<ValidationResult> {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];
	const checkFillPayloads = options.checkFillPayloads !== false;

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

	const slots = (app.slots ?? []) as Array<{ id: string; accepts: string[]; capability?: string; payload?: object }>;
	const slotMap = new Map(slots.map((s) => [s.id, s]));

	const payloadAjv = new Ajv({ allErrors: true, verbose: true });
	addFormats(payloadAjv);
	const payloadValidators = new Map<string, ReturnType<typeof payloadAjv.compile> | null>();
	const payloadValidator = (slotId: string, schema: object): ReturnType<typeof payloadAjv.compile> | null => {
		if (!payloadValidators.has(slotId)) {
			try {
				payloadValidators.set(slotId, payloadAjv.compile(schema));
			} catch {
				payloadValidators.set(slotId, null);
			}
		}
		return payloadValidators.get(slotId) ?? null;
	};

	const declaredFormats = app.formats as Record<string, unknown> | undefined;
	const declaredVocabularies = app.vocabularies as Record<string, unknown> | undefined;

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
			continue;
		}

		if (isFragmentFill(frag)) {
			const found = vocabularyFindings(frag, `/fragments/${i}`, declaredFormats, declaredVocabularies);
			errors.push(...found.errors);
			warnings.push(...found.warnings);
		}
	}

	const modCapabilitySet = new Set(Array.isArray(mod.capabilities) ? (mod.capabilities as string[]) : []);
	const fills = mod.fills;
	if (typeof fills === "object" && fills !== null && !Array.isArray(fills)) {
		for (const [slotId, fillValue] of Object.entries(fills as Record<string, unknown>)) {
			const slot = slotMap.get(slotId);
			if (!slot) {
				errors.push({
					path: `/fills/${slotId}`,
					message: `fills slot "${slotId}" which does not exist in the app manifest`,
					keyword: "cross-fill-slot",
				});
				continue;
			}
			if (slot.capability && !grantedSatisfies(modCapabilitySet, slot.capability)) {
				errors.push({
					path: `/fills/${slotId}`,
					message: `fills slot "${slotId}" which requires capability "${slot.capability}" that the mod does not declare`,
					keyword: "cross-fill-capability",
				});
			}
			const commandSlot = isCommandSlot(slot);
			if (commandSlot) {
				for (const defect of commandDefects(fillValue, slotId, declaredExportNames(mod))) {
					errors.push({
						path: `/fills/${slotId}/${defect.index}${defect.pointer}`,
						message: defect.message,
						keyword: defect.code,
					});
				}
			}

			const fillEntries = Array.isArray(fillValue) ? fillValue : [fillValue];
			for (let i = 0; i < fillEntries.length; i++) {
				const fill = fillEntries[i];
				if (commandSlot) continue;
				if (!isFragmentFill(fill) || !Array.isArray(slot.accepts)) continue;
				const path = `/fills/${slotId}/${i}`;
				if (!slot.accepts.includes(fill.format)) {
					errors.push({
						path: `${path}/format`,
						message: `format "${fill.format}" is not accepted by slot "${slotId}" (accepts: ${slot.accepts.join(", ")})`,
						keyword: "cross-fill-format",
					});
					continue;
				}
				const found = vocabularyFindings(fill, path, declaredFormats, declaredVocabularies);
				errors.push(...found.errors);
				warnings.push(...found.warnings);
			}

			if (checkFillPayloads && slot.payload && typeof slot.payload === "object") {
				const validate = payloadValidator(slotId, slot.payload);
				if (validate) {
					const entries = Array.isArray(fillValue) ? fillValue : [fillValue];
					for (let i = 0; i < entries.length; i++) {
						if (!validate(entries[i])) {
							for (const err of validate.errors ?? []) {
								errors.push({
									path: `/fills/${slotId}/${i}${err.instancePath}`,
									message: `fill payload ${err.message}`,
									keyword: "cross-fill-payload",
								});
							}
						}
					}
				}
			}
		}
	}

	const appCapabilities = app.capabilities as Record<string, unknown> | undefined;
	const declaredScopes = Object.keys(appCapabilities ?? {});
	const modCapabilities = (mod.capabilities ?? []) as string[];
	for (const cap of modCapabilities) {
		if (!declaredScopes.some((scope) => satisfies(scope, cap))) {
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
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

export interface InMemoryValidationOptions {
	/** Force app or mod validation; detected from the manifest's content when omitted. */
	kind?: "app" | "mod";
	/** The manifest version (`0.6` through the current one) to validate against. */
	version?: string;
	/** An overlay schema the caller resolved itself, validated against in place of a bundled one. */
	schema?: object;
}

/**
 * Validates an in-memory manifest against the bundled schema of the version it targets, with no
 * filesystem or network access: an explicit `version`, else a known xript `$schema` URL, else the
 * manifest's `xript` field, else the current version. The result's `target` says which answered.
 *
 * A `$schema` naming anything other than an xript schema is an overlay this entry does not fetch.
 * Pass it as `schema`; otherwise the manifest is checked against bundled core and a
 * `schema-fallback` warning says so. The Node entry's `validateManifestVersioned` resolves
 * overlays from disk and the network.
 */
export async function validateManifestForVersion(
	manifest: unknown,
	options: InMemoryValidationOptions = {},
): Promise<ValidationResult> {
	const isMod = options.kind ? options.kind === "mod" : isModManifest(manifest);
	const validate = isMod ? validateModManifest : validateManifest;
	if (options.schema) return validate(manifest, options.schema);

	const declared =
		typeof manifest === "object" && manifest !== null && typeof (manifest as Record<string, unknown>).$schema === "string"
			? ((manifest as Record<string, unknown>).$schema as string)
			: undefined;
	if (declared !== undefined && xriptSchemaKind(declared) === undefined) {
		const result = await validate(manifest, bundledSchema(isMod ? "mod-manifest.schema.json" : "manifest.schema.json"));
		return {
			...result,
			warnings: [
				...(result.warnings ?? []),
				{
					path: "/$schema",
					message: `the $schema overlay "${declared}" is not resolved in memory; validating against bundled core`,
					keyword: "schema-fallback",
				},
			],
		};
	}

	let target: TargetVersion;
	try {
		target = resolveTargetVersion(manifest, options.version);
	} catch (error) {
		if (error instanceof UnsupportedVersionError) {
			return { valid: false, errors: [{ path: "/", message: error.message, keyword: "version" }] };
		}
		throw error;
	}
	const result = await validate(manifest, await loadSpecSchema(target.version, isMod ? "mod-manifest" : "manifest"));
	const warnings = [...(result.warnings ?? [])];
	if (target.note) warnings.push({ path: "/xript", message: target.note, keyword: "version-fallback" });
	return { ...result, warnings, target };
}

export { gateCapabilities } from "./manifest-util.js";
export {
	scoreManifests,
	diffScores,
	type ScoreResult,
	type ScoreOptions,
	type ScoreDiff,
	type MetricDiff,
	type UtilizationMetric,
	type IntegrityResult,
	type FormatSurface,
	type CommandSurface,
} from "./score.js";
export { fragmentFillFindings, looksLikeMarkup } from "./fills.js";
export { lintManifests, RESERVED_IDENTIFIER_PREFIX, isReservedIdentifier, type LintResult, type LintOptions, type Finding, type LintCounts, type Severity } from "./lint.js";

export { satisfies, grantedSatisfies, splitMode, scopeSubsumes } from "./capabilities.js";

export {
	resolveFormatProfile,
	FormatProfileError,
	PROTOCOL_PROPS,
	type FormatProfile,
	type ResolvedVocabulary,
	type NodeDefinition,
	type PropDefinition,
} from "@xriptjs/sanitize";

export {
	isCommandSlot,
	commandDefects,
	commandFillViews,
	declaredExportNames,
	exportCapability,
	COMMAND_SLOT_ACCEPT,
	ROLE_SLOT_ACCEPT,
	HOOK_SLOT_ACCEPT,
	COMMAND_ID_PATTERN,
	type CommandDefect,
	type CommandDefectCode,
	type CommandFillView,
	type CommandSlotDeclaration,
} from "./commands.js";

export {
	parseTypeRef,
	resolveTypeWords,
	typeRefToTypeScript,
	typeRefToRestArray,
	typeRefToMarkdown,
	typeRefNames,
	nonCanonicalSpellings,
	returnTypeRef,
	returnDescription,
	PRIMITIVE_TYPE_NAMES,
	TYPE_WORDS,
	UNSAFE_IDENTIFIERS,
	isSafeIdentifier,
	isOptionalParameter,
	parameterIdentifiers,
	parametersToTypeScript,
	type TypeNode,
	type TypeSpelling,
	type ParameterShape,
} from "./type-ref.js";

export {
	analyzeExpressions,
	fragmentReadNames,
	type FragmentReadOptions,
	type ExpressionAnalysisOptions,
	type ExpressionSite,
	type ExpressionType,
} from "./expressions.js";
