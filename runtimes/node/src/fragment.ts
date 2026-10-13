import {
	BUILTIN_PROFILES,
	DEFAULT_URI_SCHEMES,
	DEFAULT_URI_SCHEME_SET,
	FormatProfileError,
	PROHIBITED_URI_SCHEMES,
	PROTOCOL_PROPS,
	URI_SCHEME_NAME_PATTERN,
	VOID_ELEMENTS,
	decodeEntities,
	escapeAttrValue,
	escapeHtml,
	isAllowedAttribute,
	nodeDefinition,
	propTypeLookup,
	projectsToHtml,
	resolveFormatProfile,
	sanitizeFragment,
	sanitizeHTML,
	sanitizeStyleValue,
	sanitizeUri,
	speaksHtml,
	treeToHtml,
	parseExpressionCached,
	evaluateAst,
	evaluateExpression,
	evaluateCondition as evaluateXegCondition,
	renderValue,
	toExprValue,
	parseRepeatHeaderCached,
	evaluateRepeatItems,
	repeatScope,
	resolveRepeatKeys,
	replaceKeys,
	diffRepeat,
	repeatSiteId,
	MAX_REPEAT_COPIES,
	type FragmentRepeat,
	type RepeatKey,
	type RepeatMode,
	type RepeatPatchOp,
	type RepeatSite,
	type FormatProfile,
	type FragmentContentType,
	type FragmentDiagnostic,
	type FragmentElement,
	type FragmentNode,
	type FragmentTree,
	type PropDefinition,
	type PropValue,
	type SanitizedFragment,
	type Sink,
	type ExpressionKind,
	type TextSegment,
} from "@xriptjs/sanitize";
import { grantedSatisfies } from "./capabilities.js";
import { exportCapabilityMap, normalizeCommandFill, type CommandFill } from "./commands.js";
import { slotKindForFill } from "./slot-kinds.js";
import { fragmentDeclarationDiagnostics, suppliedSource, type ModDiagnostic } from "./mod-diagnostics.js";

export {
	BUILTIN_PROFILES,
	DEFAULT_URI_SCHEMES,
	DEFAULT_URI_SCHEME_SET,
	PROHIBITED_URI_SCHEMES,
	URI_SCHEME_NAME_PATTERN,
};
export type {
	FormatProfile,
	FragmentContentType,
	FragmentDiagnostic,
	FragmentElement,
	FragmentNode,
	FragmentRepeat,
	FragmentTree,
	PropValue,
	RepeatKey,
	RepeatMode,
	RepeatPatchOp,
	RepeatSite,
};

export interface ModManifest {
	xript: string;
	name: string;
	version: string;
	title?: string;
	description?: string;
	author?: string;
	family?: string;
	capabilities?: string[];
	entry?: string | string[] | ModEntry;
	fills?: Record<string, unknown[]>;
	fragments?: FragmentDeclaration[];
	contributions?: ModContributions;
}

export interface HookFill {
	hook: string;
	handler: string;
	/**
	 * The mod that declared the fill. A handler resolves inside this mod's own export
	 * namespace, so a fill can never reach an export another mod owns.
	 */
	mod: string;
}

export interface NormalizedMod {
	manifest: unknown;
	hookFills: HookFill[];
	/**
	 * Fills that are neither fragments, roles, nor hooks — passed to the host untouched.
	 *
	 * Fills of a slot accepting `application/x-xript-command` are NOT here — since v0.8.0
	 * they are typed and delivered on `commandFills`.
	 */
	dataFills: Record<string, unknown[]>;
	/** Typed command fills, in declaration order. */
	commandFills: CommandFill[];
}

export interface ModContributions {
	provides?: ProviderRole[];
}

export interface ProviderRole {
	role: string;
	fns: Record<string, string>;
}

export interface ModEntry {
	script: string;
	format?: "script" | "module";
	exports?: Record<string, ExportDeclaration>;
}

export interface ExportDeclaration {
	description?: string;
	params?: Parameter[];
	returns?: unknown;
	capability?: string;
}

export interface Parameter {
	name: string;
	type: unknown;
	default?: unknown;
	required?: boolean;
}

export interface FragmentDeclaration {
	id: string;
	slot: string;
	format: string;
	source: string;
	inline?: boolean;
	bindings?: FragmentBinding[];
	handlers?: FragmentHandlerDeclaration[];
	/** @deprecated Renamed to `handlers`. Still accepted as an alias; `handlers` wins when both are present. */
	events?: FragmentHandlerDeclaration[];
	priority?: number;
	/**
	 * Turns on `{{ expr }}` interpolation for this fill's text nodes. Off by default: a
	 * fragment published before the mode existed may carry `{{` in prose or a code
	 * sample, and its meaning must not change.
	 */
	interpolate?: boolean;
}

/**
 * One entry of a fragment fill's `bindings`: a local name the fragment's expressions read,
 * resolved from a host data path.
 *
 * Fields beyond `name`, `path`, and `type` are host-defined extensions (a value transform,
 * a formatting hint). The runtime carries them through untouched and never interprets
 * them; a mod that uses one only works on hosts that implement it.
 */
export interface FragmentBinding {
	name: string;
	/** Dot-separated path into the host's data, e.g. `player.health.val`. */
	path: string;
	/** Optional value type, for tooling that type-checks the expressions reading this binding. Not consulted at runtime. */
	type?: string;
	[extension: string]: unknown;
}

export interface FragmentHandlerDeclaration {
	selector: string;
	on: string;
	handler: string;
}

/** @deprecated Renamed to `FragmentHandlerDeclaration`. */
export type FragmentEventDeclaration = FragmentHandlerDeclaration;

export interface SlotDeclaration {
	id: string;
	accepts: string[];
	capability?: string;
	multiple?: boolean;
	style?: "inherit" | "isolated" | "scoped";
	/**
	 * Enforced limits for calls into this slot's fills, overriding the manifest's
	 * `limits` field by field. Carries `timeout_ms` alone: memory and stack
	 * ceilings are fixed when a runtime is created.
	 */
	limits?: { timeout_ms?: number };
}

/**
 * How an op or a declared handler names the node it acts on. An id reference (`#name`) and
 * a child-index path (`@0.2.1`, the same grammar as `FragmentCondition.path`) both resolve
 * in any vocabulary, and the path form is the only way to reach a node that carries no id.
 * A CSS selector is meaningful only under an HTML vocabulary.
 */
export type NodeRef =
	| { by: "id"; id: string }
	| { by: "path"; path: number[] }
	| { by: "selector"; selector: string };

const ID_REFERENCE = /^#[A-Za-z][A-Za-z0-9_.:-]*$/;
const PATH_REFERENCE = /^@\d+(\.\d+)*$/;

export function parseNodeRef(target: string): NodeRef {
	if (ID_REFERENCE.test(target)) return { by: "id", id: target.slice(1) };
	if (PATH_REFERENCE.test(target)) {
		return { by: "path", path: target.slice(1).split(".").map(Number) };
	}
	return { by: "selector", selector: target };
}

export interface FragmentHandler {
	selector: string;
	/** The parsed form of `selector`. */
	target: NodeRef;
	on: string;
	handler: string;
}

/** @deprecated Renamed to `FragmentHandler`. */
export type FragmentEvent = FragmentHandler;

/** A `data-if` result, addressed by where its node sits in the bound tree. */
export interface FragmentCondition {
	/** Child-index path into the bound tree, e.g. `[0, 2, 1]`. */
	path: number[];
	expression: string;
	visible: boolean;
}

/** The tree contract every fragment result speaks. See `spec/renderers.md`. */
export const TREE_CONTRACT_VERSION = "xript-tree/1";

export interface FragmentUpdateResult {
	/** The tree contract this result speaks. A consumer that does not recognize it must refuse to render. */
	contract: typeof TREE_CONTRACT_VERSION;
	fragmentId: string;
	format: string;
	contentType: FragmentContentType;
	/** Bound HTML. `""` for a format with no HTML projection. */
	html: string;
	/** Bound tree. Present for every format, including HTML. */
	tree: FragmentTree;
	/**
	 * @deprecated Keyed by `data-if` expression text, so two nodes carrying the same
	 * condition collapse into one entry and a host cannot map a result back to a node.
	 * Use `conditions`. Still populated, last-write-wins, as before.
	 */
	visibility: Record<string, boolean>;
	/** Every `data-if` in the bound tree, keyed by tree position rather than by text. */
	conditions: FragmentCondition[];
	/**
	 * Every `data-each` expansion, in document order: where its copies sit, their keys,
	 * and how to patch the copies of the previous render into these.
	 */
	repeats: FragmentRepeat[];
	diagnostics: FragmentDiagnostic[];
}

/** A fragment names a format the host does not declare and the runtime cannot resolve. */
export class FragmentFormatError extends Error {
	readonly format: string;
	readonly fragmentId: string;

	constructor(fragmentId: string, format: string, detail?: string) {
		super(
			detail
				?? `unknown fragment format '${format}' — declare it in the host manifest's 'formats' block`,
		);
		this.name = "FragmentFormatError";
		this.format = format;
		this.fragmentId = fragmentId;
	}
}

/** A fragment's source violates the vocabulary its format declares. */
export class FragmentSanitizeError extends Error {
	readonly fragmentId: string;
	readonly diagnostics: FragmentDiagnostic[];

	constructor(fragmentId: string, diagnostics: FragmentDiagnostic[]) {
		const summary = diagnostics.map((d) => `  ${d.path} ${d.message}`).join("\n");
		super(`fragment '${fragmentId}' violates its format's vocabulary:\n${summary}`);
		this.name = "FragmentSanitizeError";
		this.fragmentId = fragmentId;
		this.diagnostics = diagnostics;
	}
}

export interface ModManifestIssue {
	path: string;
	message: string;
	/** Stable machine code, where the check has one. Matches `@xriptjs/validate`'s codes. */
	code?: string;
	/** Contextual detail for machine consumers: the fill index and the names the defect calls out. */
	detail?: { fill?: number; id?: string; handler?: string; arg?: string };
}

export class ModManifestValidationError extends Error {
	public readonly issues: ModManifestIssue[];

	constructor(issues: ModManifestIssue[]) {
		const summary = issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
		super(`Invalid xript mod manifest:\n${summary}`);
		this.name = "ModManifestValidationError";
		this.issues = issues;
	}
}

function isEntryObject(entry: unknown): entry is ModEntry {
	return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

function validateEntry(entry: unknown, issues: ModManifestIssue[]): void {
	if (typeof entry === "string") return;
	if (Array.isArray(entry)) {
		if (!entry.every((e) => typeof e === "string")) {
			issues.push({ path: "/entry", message: "'entry' array must contain only strings" });
		}
		return;
	}
	if (typeof entry !== "object" || entry === null) {
		issues.push({ path: "/entry", message: "'entry' must be a string, array of strings, or an entry object" });
		return;
	}
	const e = entry as Record<string, unknown>;
	if (typeof e.script !== "string" || e.script.length === 0) {
		issues.push({ path: "/entry/script", message: "entry object 'script' must be a non-empty string" });
	}
	if (e.format !== undefined && e.format !== "script" && e.format !== "module") {
		issues.push({ path: "/entry/format", message: "entry 'format' must be 'script' or 'module'" });
	}
	if (e.exports !== undefined && (typeof e.exports !== "object" || e.exports === null || Array.isArray(e.exports))) {
		issues.push({ path: "/entry/exports", message: "entry 'exports' must be an object map" });
	}
}

/**
 * The script names a mod's `entry` asks the host to supply, in evaluation order. Each name
 * is looked up in `ModLoadOptions.fragmentSources`; a name with no source there is a load
 * error (see `MissingEntryScriptError`).
 *
 * - a bare string names one script
 * - an array names several, evaluated in order
 * - the object form `{ script, format, exports }` names one, `script`
 * - an absent `entry` names none
 */
export function modEntryScripts(entry: string | string[] | ModEntry | undefined): string[] {
	if (entry === undefined) return [];
	if (typeof entry === "string") return [entry];
	if (Array.isArray(entry)) return entry;
	return [entry.script];
}

/**
 * The exports a mod's `entry` declares, keyed by export name. Only the object form can
 * declare exports; a bare string or array declares none.
 */
export function modEntryExports(entry: string | string[] | ModEntry | undefined): Record<string, ExportDeclaration> {
	if (isEntryObject(entry) && entry.exports) return entry.exports;
	return {};
}

/**
 * How a mod's entry is evaluated. `"module"` only when the object form says
 * `format: "module"`, which needs Node's vm modules (`--experimental-vm-modules`) and
 * `loadModAsync`; every other form is a classic `"script"`.
 */
export function modEntryFormat(entry: string | string[] | ModEntry | undefined): "script" | "module" {
	if (isEntryObject(entry) && entry.format === "module") return "module";
	return "script";
}

export function validateModManifest(manifest: unknown): ModManifest {
	if (typeof manifest !== "object" || manifest === null) {
		throw new ModManifestValidationError([{ path: "/", message: "mod manifest must be a non-null object" }]);
	}

	const m = manifest as Record<string, unknown>;
	const issues: ModManifestIssue[] = [];

	if (typeof m.xript !== "string" || m.xript.length === 0) {
		issues.push({ path: "/xript", message: "required field 'xript' must be a non-empty string" });
	}

	if (typeof m.name !== "string" || m.name.length === 0) {
		issues.push({ path: "/name", message: "required field 'name' must be a non-empty string" });
	}

	if (typeof m.version !== "string" || m.version.length === 0) {
		issues.push({ path: "/version", message: "required field 'version' must be a non-empty string" });
	}

	if (m.family !== undefined) {
		if (typeof m.family !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.family)) {
			issues.push({ path: "/family", message: "'family' must match ^[a-z][a-z0-9-]*$" });
		}
	}

	if (m.entry !== undefined) {
		validateEntry(m.entry, issues);
	}

	if (m.capabilities !== undefined) {
		if (!Array.isArray(m.capabilities)) {
			issues.push({ path: "/capabilities", message: "'capabilities' must be an array" });
		}
	}

	if (m.fragments !== undefined) {
		if (!Array.isArray(m.fragments)) {
			issues.push({ path: "/fragments", message: "'fragments' must be an array" });
		} else {
			for (let i = 0; i < m.fragments.length; i++) {
				const frag = m.fragments[i] as Record<string, unknown>;
				const prefix = `/fragments/${i}`;

				if (typeof frag.id !== "string" || frag.id.length === 0) {
					issues.push({ path: `${prefix}/id`, message: "'id' must be a non-empty string" });
				}
				if (typeof frag.slot !== "string" || frag.slot.length === 0) {
					issues.push({ path: `${prefix}/slot`, message: "'slot' must be a non-empty string" });
				}
				if (typeof frag.format !== "string" || frag.format.length === 0) {
					issues.push({ path: `${prefix}/format`, message: "'format' must be a non-empty string" });
				}
				if (typeof frag.source !== "string") {
					issues.push({ path: `${prefix}/source`, message: "'source' must be a string" });
				}
			}
		}
	}

	if (m.contributions !== undefined) {
		validateContributions(m.contributions, issues);
	}

	if (issues.length > 0) {
		throw new ModManifestValidationError(issues);
	}

	return manifest as ModManifest;
}

const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

function validateContributions(contributions: unknown, issues: ModManifestIssue[]): void {
	if (typeof contributions !== "object" || contributions === null || Array.isArray(contributions)) {
		issues.push({ path: "/contributions", message: "'contributions' must be an object" });
		return;
	}
	const c = contributions as Record<string, unknown>;
	if (c.provides === undefined) return;
	if (!Array.isArray(c.provides)) {
		issues.push({ path: "/contributions/provides", message: "'provides' must be an array" });
		return;
	}

	const seenRoles = new Set<string>();
	for (let i = 0; i < c.provides.length; i++) {
		const entry = c.provides[i] as Record<string, unknown>;
		const prefix = `/contributions/provides/${i}`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			issues.push({ path: prefix, message: "provider role entry must be an object" });
			continue;
		}
		if (typeof entry.role !== "string" || !ROLE_PATTERN.test(entry.role) || entry.role.length > 64) {
			issues.push({ path: `${prefix}/role`, message: "'role' must match ^[a-z][a-z0-9-]*$ (max 64 chars)" });
		} else if (seenRoles.has(entry.role)) {
			issues.push({ path: `${prefix}/role`, message: `duplicate role '${entry.role}' in provides[]` });
		} else {
			seenRoles.add(entry.role);
		}
		if (typeof entry.fns !== "object" || entry.fns === null || Array.isArray(entry.fns)) {
			issues.push({ path: `${prefix}/fns`, message: "'fns' must be an object map (logical -> concrete fn name)" });
		} else {
			const fnEntries = Object.entries(entry.fns);
			if (fnEntries.length < 1) {
				issues.push({ path: `${prefix}/fns`, message: "'fns' must declare at least one mapping" });
			}
			for (const [logical, concrete] of fnEntries) {
				if (typeof concrete !== "string") {
					issues.push({ path: `${prefix}/fns/${logical}`, message: "fn target must be a string" });
				}
			}
		}
	}
}

export function modProviderRoles(modManifest: ModManifest): ProviderRole[] {
	return modManifest.contributions?.provides ?? [];
}


/**
 * Resolves a mod's canonical `fills` surface into the runtime's internal
 * contribution model, typed by each target slot's `accepts`: a fragment fill becomes a
 * fragment declaration, a role fill becomes a provider role, an event/hook fill becomes
 * an export-backed hook handler the host fires, and anything else is opaque data the
 * host reads. A fill is a fragment fill iff it carries both a string `format` and a
 * string `source`; a code-renderer fill (`entry`) and a pure-data fill are neither
 * sanitized nor mounted. A mod that mixes `fills` with the deprecated
 * `fragments`/`contributions` surfaces is rejected rather than silently
 * double-contributing.
 */
export function normalizeModFills(
	modManifest: unknown,
	slots: SlotDeclaration[],
	grantedCapabilities: Set<string>,
): NormalizedMod {
	if (typeof modManifest !== "object" || modManifest === null) {
		return { manifest: modManifest, hookFills: [], dataFills: {}, commandFills: [] };
	}
	const m = modManifest as Record<string, unknown>;
	if (m.fills === undefined) {
		return { manifest: modManifest, hookFills: [], dataFills: {}, commandFills: [] };
	}
	if (m.fragments !== undefined || m.contributions !== undefined) {
		throw new ModManifestValidationError([
			{
				path: "/fills",
				message:
					"a mod contributes through 'fills' alone — remove the deprecated 'fragments'/'contributions' surfaces instead of mixing the two",
			},
		]);
	}
	if (typeof m.fills !== "object" || Array.isArray(m.fills)) {
		throw new ModManifestValidationError([{ path: "/fills", message: "'fills' must be an object keyed by host slot id" }]);
	}

	const issues: ModManifestIssue[] = [];
	const modName = typeof m.name === "string" ? m.name : "";
	const slotMap = new Map(slots.map((slot) => [slot.id, slot]));
	const fragments: Array<Record<string, unknown>> = [];
	const provides: Array<Record<string, unknown>> = [];
	const hookFills: HookFill[] = [];
	const dataFills: Record<string, unknown[]> = {};
	const commandFills: CommandFill[] = [];
	const exportCapabilities = exportCapabilityMap(m);

	for (const [slotId, entries] of Object.entries(m.fills as Record<string, unknown>)) {
		if (!Array.isArray(entries)) {
			issues.push({ path: `/fills/${slotId}`, message: "fill entries must be an array" });
			continue;
		}
		const slot = slotMap.get(slotId);
		if (!slot) {
			issues.push({ path: `/fills/${slotId}`, message: `slot '${slotId}' does not exist in the app manifest` });
			continue;
		}
		const seenCommandIds = new Set<string>();
		entries.forEach((entry, index) => {
			const prefix = `/fills/${slotId}/${index}`;
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				issues.push({ path: prefix, message: "a fill must be an object" });
				return;
			}
			const fill = entry as Record<string, unknown>;
			const kind = slotKindForFill(slot, fill);
			if (kind === "role") {
				if (typeof fill.fns !== "object" || fill.fns === null || Array.isArray(fill.fns)) {
					issues.push({ path: `${prefix}/fns`, message: "a role fill must map logical fn names to exports via 'fns'" });
					return;
				}
				if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
					issues.push({ path: prefix, message: `slot '${slotId}' requires capability '${slot.capability}'` });
					return;
				}
				provides.push({ role: slotId, fns: fill.fns });
			} else if (kind === "hook") {
				if (typeof fill.handler !== "string" || fill.handler.length === 0) {
					issues.push({ path: `${prefix}/handler`, message: "an event/hook fill must name a 'handler' export" });
					return;
				}
				if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
					issues.push({ path: prefix, message: `slot '${slotId}' requires capability '${slot.capability}'` });
					return;
				}
				hookFills.push({ hook: slotId, handler: fill.handler, mod: modName });
			} else if (kind === "command") {
				const command = normalizeCommandFill(
					fill,
					{
						mod: modName,
						slot: slotId,
						index,
						path: prefix,
						seenIds: seenCommandIds,
						slotCapability: slot.capability,
						exportCapabilities,
					},
					issues,
				);
				if (command === null) return;
				if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
					issues.push({ path: prefix, message: `slot '${slotId}' requires capability '${slot.capability}'` });
					return;
				}
				commandFills.push(command);
			} else if (kind === "fragment") {
				fragments.push({ id: `${slotId}-fill-${index}`, ...fill, slot: slotId });
			} else {
				if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
					issues.push({ path: prefix, message: `slot '${slotId}' requires capability '${slot.capability}'` });
					return;
				}
				(dataFills[slotId] ??= []).push(fill);
			}
		});
	}

	if (issues.length > 0) {
		throw new ModManifestValidationError(issues);
	}

	const { fills: _fills, ...rest } = m;
	return {
		manifest: {
			...rest,
			...(fragments.length > 0 ? { fragments } : {}),
			...(provides.length > 0 ? { contributions: { provides } } : {}),
		},
		hookFills,
		dataFills,
		commandFills,
	};
}

export function validateModAgainstApp(
	modManifest: ModManifest,
	slots: SlotDeclaration[],
	grantedCapabilities: Set<string>,
	formats: Record<string, unknown> | null,
	vocabularies: Record<string, unknown> | null,
): ModManifestIssue[] {
	const issues: ModManifestIssue[] = [];
	const slotMap = new Map(slots.map(s => [s.id, s]));

	if (modManifest.fragments) {
		for (let i = 0; i < modManifest.fragments.length; i++) {
			const frag = modManifest.fragments[i];
			const prefix = `/fragments/${i}`;
			const slot = slotMap.get(frag.slot);

			if (!slot) {
				issues.push({ path: `${prefix}/slot`, message: `slot '${frag.slot}' does not exist in the app manifest` });
				continue;
			}

			if (!slot.accepts.includes(frag.format)) {
				issues.push({ path: `${prefix}/format`, message: `slot '${frag.slot}' does not accept format '${frag.format}'` });
			} else {
				try {
					if (!resolveFormatProfile(frag.format, formats, vocabularies)) {
						issues.push({
							path: `${prefix}/format`,
							message: `unknown fragment format '${frag.format}' — declare it in the host manifest's 'formats' block`,
						});
					}
				} catch (err) {
					if (!(err instanceof FormatProfileError)) throw err;
					issues.push({ path: `${prefix}/format`, message: err.message });
				}
			}

			if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
				issues.push({ path: `${prefix}/slot`, message: `slot '${frag.slot}' requires capability '${slot.capability}'` });
			}
		}
	}

	return issues;
}

const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * Reads the value at a dotted binding path, or `undefined` when the path resolves to
 * nothing. A segment walks an own key of an object or a canonical numeric index of an
 * array (`items.0`), and nothing else: never a primitive's property (`name.length`),
 * never an array's `length`, never an inherited property.
 */
export function resolveBindingPath(data: Record<string, unknown>, path: string): unknown {
	let current: unknown = data;

	for (const part of path.split(".")) {
		if (Array.isArray(current)) {
			if (!CANONICAL_INDEX.test(part)) return undefined;
			const index = Number(part);
			if (index >= current.length) return undefined;
			current = current[index];
		} else if (current !== null && typeof current === "object") {
			if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
			current = (current as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}

	return current;
}

export function resolveBindings(
	declarations: FragmentBinding[],
	data: Record<string, unknown>,
): Record<string, unknown> {
	const resolved: Record<string, unknown> = {};
	for (const binding of declarations) {
		resolved[binding.name] = resolveBindingPath(data, binding.path);
	}
	return resolved;
}

const DATA_BIND_PATTERN = /(<[^>]*\bdata-bind="([^"]*)"[^>]*>)([\s\S]*?)(<\/[^>]+>)/g;
const SELF_CLOSING_DATA_BIND_PATTERN = /(<[^>]*\bdata-bind="([^"]*)"[^>]*)\s*\/>/g;
const DATA_IF_PATTERN = /<[^>]*\bdata-if="([^"]*)"[^>]*>/g;

/**
 * @deprecated The legacy string-patching bind pass. `getContent()` now serializes its HTML
 * from the bound tree, so this is no longer on any render path. It resolves only bare-name
 * `data-bind` and it cannot see interpolation segments, because a segment is a property of
 * the tree and this function never had one.
 */
export function processFragment(
	sanitizedSource: string,
	bindings: Record<string, unknown>,
): { html: string; visibility: Record<string, boolean> } {
	let html = sanitizedSource.replace(DATA_BIND_PATTERN, (match, openTag, bindName, _content, closeTag) => {
		const value = bindings[bindName];
		if (value === undefined) return match;
		return `${openTag}${escapeHtml(renderValue(toExprValue(value)))}${closeTag}`;
	});

	html = html.replace(SELF_CLOSING_DATA_BIND_PATTERN, (match, beforeClose, bindName) => {
		const value = bindings[bindName];
		if (value === undefined) return match;
		const valueAttr = `value="${escapeAttrValue(renderValue(toExprValue(value)))}"`;
		const openTag = (beforeClose as string).trimEnd();
		if (openTag.includes("value=")) {
			return openTag.replace(/value="[^"]*"/, () => valueAttr) + " />";
		}
		return `${openTag} ${valueAttr} />`;
	});

	const visibility: Record<string, boolean> = {};
	let ifMatch;
	DATA_IF_PATTERN.lastIndex = 0;
	while ((ifMatch = DATA_IF_PATTERN.exec(html)) !== null) {
		const expression = decodeEntities(ifMatch[1]);
		visibility[expression] = evaluateCondition(expression, bindings);
	}

	return { html, visibility };
}

/**
 * Evaluates a `data-if` body.
 *
 * The expression is parsed as XEG and walked, never compiled: there is no `new Function`
 * and no `eval` anywhere on this path, so a mod-authored attribute string cannot reach a
 * host global. Evaluation is total, so an unparseable or failing expression is `false`
 * rather than an exception that aborts a render.
 */
export function evaluateCondition(expression: string, bindings: Record<string, unknown>): boolean {
	return evaluateXegCondition(expression, bindings);
}

/**
 * Classifies a `data-bind` body. A bare identifier is an lvalue, so it keeps two-way
 * write-back; anything else computes a value that has no inverse and is read-only.
 * Returns `null` when the body is not a member of the grammar at all.
 */
export function bindExpressionKind(source: string): ExpressionKind | null {
	const parsed = parseExpressionCached(source);
	return parsed.ok ? parsed.expression.kind : null;
}

/**
 * Concatenates a segmented text node's resolved content.
 *
 * Every piece joins as plain text and the result stays inside a `FragmentText`, which has
 * no props and no children. A resolved value has nowhere to land that would make it
 * markup, and the tokenizer is never re-entered, so a value that itself contains `{{` or
 * a tag is inert text.
 */
export function resolveSegments(
	segments: readonly TextSegment[],
	bindings: Record<string, unknown>,
): string {
	let out = "";
	for (const segment of segments) {
		out += segment.kind === "literal"
			? segment.value
			: renderValue(evaluateExpression(segment.source, bindings));
	}
	return out;
}

/**
 * Routes a value through the sanitizer a prop's declared sink names. `schemes` is the
 * format's URI allow-list; it governs the `uri` and `image-uri` sinks and defaults to the
 * safe set so a caller that omits it is no laxer than the parse path.
 */
export function applySink(
	sink: Sink,
	value: PropValue,
	schemes: ReadonlySet<string> = DEFAULT_URI_SCHEME_SET,
): PropValue | null {
	if (sink === "text") return value;
	if (typeof value !== "string") return null;

	switch (sink) {
		case "uri":
			return sanitizeUri(value, "href", schemes);
		case "image-uri":
			return sanitizeUri(value, "src", schemes);
		case "css": {
			const cleaned = sanitizeStyleValue(value);
			if (cleaned === "" && value.trim() !== "") return null;
			return cleaned;
		}
		case "html":
			return sanitizeHTML(value);
	}
}

export function propSink(declaration: PropDefinition | undefined): Sink {
	const sink = declaration?.sink;
	if (sink === "uri" || sink === "image-uri" || sink === "css" || sink === "html") return sink;
	return "text";
}

/**
 * Writes a value into a node's prop through whatever sanitizer that prop's vocabulary
 * says applies. Under the built-in HTML vocabulary the prop name itself names the sink
 * (`href`/`src` are URIs, `style` is CSS); under a host-declared vocabulary the prop's
 * `sink` keyword does. Returns `null` when the value is rejected.
 */
export function routePropValue(
	profile: FormatProfile,
	nodeName: string,
	prop: string,
	value: PropValue,
): PropValue | null {
	const routed = routePropValueDetailed(profile, nodeName, prop, value);
	return routed.accepted ? routed.value : null;
}

/**
 * Why a routed value was refused: the node's vocabulary does not reach the prop at all,
 * or the prop's sink rejected the value.
 */
export type PropRouteResult =
	| { accepted: true; value: PropValue }
	| { accepted: false; reason: "undeclared" | "rejected" };

/** `routePropValue`, keeping the reason a value was refused so the caller can report it. */
export function routePropValueDetailed(
	profile: FormatProfile,
	nodeName: string,
	prop: string,
	value: PropValue,
): PropRouteResult {
	const settle = (routed: PropValue | null): PropRouteResult =>
		routed === null ? { accepted: false, reason: "rejected" } : { accepted: true, value: routed };

	const definition = nodeDefinition(profile, nodeName);
	if (definition) {
		if (PROTOCOL_PROPS.has(prop)) return settle(typeof value === "string" ? value : null);
		const declared = definition.props
			&& Object.prototype.hasOwnProperty.call(definition.props, prop)
			? definition.props[prop]
			: undefined;
		if (!declared) return { accepted: false, reason: "undeclared" };
		return settle(applySink(propSink(declared), value, profile.schemes));
	}

	if (!speaksHtml(profile)) return { accepted: false, reason: "undeclared" };

	const lower = prop.toLowerCase();
	if (!isAllowedAttribute(nodeName, lower)) return { accepted: false, reason: "undeclared" };
	if ((lower === "href" || lower === "src") && typeof value === "string") {
		return settle(sanitizeUri(value, lower, profile.schemes));
	}
	if (lower === "style" && typeof value === "string") {
		return settle(sanitizeStyleValue(value));
	}
	return settle(value);
}

function isVoidNode(profile: FormatProfile, node: FragmentElement): boolean {
	const definition = nodeDefinition(profile, node.name);
	if (definition) return definition.children === "none";
	return VOID_ELEMENTS.has(node.name);
}

function bindTarget(profile: FormatProfile, node: FragmentElement): string {
	const definition = nodeDefinition(profile, node.name);
	if (definition?.bindTo) return definition.bindTo;
	return isVoidNode(profile, node) ? "value" : "children";
}

/**
 * What a repeat site looked like on the previous render, keyed by `repeatSiteId`. A
 * fragment instance carries it from one `getContent` to the next so each repeat can
 * report how to patch the copies the host already drew.
 */
export type RepeatState = Map<string, { mode: RepeatMode; keys: RepeatKey[] }>;

/**
 * Resolves `data-each`, `data-bind`, and `data-if` against a sanitized tree. Fragments
 * stay inert: a `data-if` node is not pruned, its expression's truth is reported and the
 * host applies visibility. A `data-each` template is replaced by its copies before any
 * of their own attributes are read, so a `data-if` on the template is evaluated per copy
 * with the item in scope. A bound value written into a prop is routed through that
 * prop's sink, so binding is not a way around the vocabulary's safety declarations.
 */
export interface BoundTree {
	tree: FragmentTree;
	/** @deprecated Keyed by expression text; collides. Use `conditions`. */
	visibility: Record<string, boolean>;
	conditions: FragmentCondition[];
	/** Every `data-each` expansion, in document order. */
	repeats: FragmentRepeat[];
	/**
	 * Findings the bind pass made: bound values the vocabulary refused to write, duplicate
	 * or invalid repeat keys, and the copy ceiling.
	 */
	diagnostics: FragmentDiagnostic[];
	/** This render's repeat sites, to pass back as `previous` on the next render. */
	repeatState: RepeatState;
}

interface BindContext {
	profile: FormatProfile;
	visibility: Record<string, boolean>;
	conditions: FragmentCondition[];
	repeats: FragmentRepeat[];
	diagnostics: FragmentDiagnostic[];
	previous: RepeatState | null;
	next: RepeatState;
	remainingCopies: number;
}

export function processTree(
	tree: FragmentTree,
	bindings: Record<string, unknown>,
	profile: FormatProfile,
	previous: RepeatState | null = null,
): BoundTree {
	const ctx: BindContext = {
		profile,
		visibility: {},
		conditions: [],
		repeats: [],
		diagnostics: [],
		previous,
		next: new Map(),
		remainingCopies: MAX_REPEAT_COPIES,
	};
	const bound = bindChildren(tree, bindings, ctx, [], [], []);
	return {
		tree: bound,
		visibility: ctx.visibility,
		conditions: ctx.conditions,
		repeats: ctx.repeats,
		diagnostics: ctx.diagnostics,
		repeatState: ctx.next,
	};
}

function sourcePointer(path: readonly number[]): string {
	return path.map((index) => `/${index}`).join("");
}

function bindChildren(
	nodes: readonly FragmentNode[],
	bindings: Record<string, unknown>,
	ctx: BindContext,
	parentPath: number[],
	parentSource: number[],
	within: RepeatKey[],
): FragmentNode[] {
	const out: FragmentNode[] = [];
	nodes.forEach((node, index) => {
		const source = [...parentSource, index];
		if (node.kind === "element" && typeof node.props["data-each"] === "string") {
			expandRepeat(node, bindings, ctx, parentPath, source, within, out);
		} else {
			out.push(bindNode(node, bindings, ctx, [...parentPath, out.length], source, within));
		}
	});
	return out;
}

function expandRepeat(
	template: FragmentElement,
	bindings: Record<string, unknown>,
	ctx: BindContext,
	parentPath: number[],
	source: number[],
	within: RepeatKey[],
	out: FragmentNode[],
): void {
	const eachSource = template.props["data-each"] as string;
	const keyProp = template.props["data-key"];
	const keySource = typeof keyProp === "string" ? keyProp : null;
	const parsed = parseRepeatHeaderCached(eachSource);

	let items = parsed.ok ? evaluateRepeatItems(parsed.header, bindings) : [];
	if (items.length > ctx.remainingCopies) {
		ctx.diagnostics.push({
			code: "repeat-limit",
			severity: "warning",
			path: sourcePointer(source),
			node: template.name,
			prop: "data-each",
			message: `repeat truncated to ${ctx.remainingCopies} of ${items.length} copies; a render produces at most ${MAX_REPEAT_COPIES}`,
		});
		items = items.slice(0, ctx.remainingCopies);
	}
	ctx.remainingCopies -= items.length;

	const scopes = parsed.ok
		? items.map((item, index) => repeatScope(bindings, parsed.header, item, index))
		: [];
	const resolution = keySource === null
		? { mode: "replace" as const, keys: replaceKeys(scopes.length), problem: null }
		: resolveRepeatKeys(scopes.map((scope) => evaluateExpression(keySource, scope)));
	if (resolution.problem !== null) {
		ctx.diagnostics.push({
			code: resolution.problem,
			severity: "warning",
			path: sourcePointer(source),
			node: template.name,
			prop: "data-key",
			message: resolution.problem === "duplicate-key"
				? `data-key "${keySource}" produced a duplicate key; copies are keyed by index`
				: `data-key "${keySource}" produced a key that is not a string or a number; copies are keyed by index`,
		});
	}

	const site: RepeatSite = { template: source, within };
	const siteId = repeatSiteId(site);
	const previous = ctx.previous?.get(siteId) ?? null;
	ctx.next.set(siteId, { mode: resolution.mode, keys: resolution.keys });

	ctx.repeats.push({
		site,
		path: parentPath,
		start: out.length,
		count: scopes.length,
		expression: eachSource,
		key: keySource,
		mode: resolution.mode,
		keys: resolution.keys,
		patch: diffRepeat(previous, resolution),
	});

	const props: Record<string, PropValue> = {};
	for (const [name, value] of Object.entries(template.props)) {
		if (name !== "data-each" && name !== "data-key") props[name] = value;
	}
	const copy: FragmentElement = { ...template, props };
	scopes.forEach((scope, index) => {
		out.push(bindNode(copy, scope, ctx, [...parentPath, out.length], source, [...within, resolution.keys[index]]));
	});
}

/**
 * A bound value the target prop cannot take. The node's reachable props are the ones
 * its vocabulary lists, so a `data-bind` aimed at any other prop writes nothing; the
 * drop is reported rather than silent.
 */
function bindRefusal(
	node: string,
	prop: string,
	reason: "undeclared" | "rejected",
	path: number[],
): FragmentDiagnostic {
	return {
		code: reason === "undeclared" ? "unknown-prop" : "unsafe-prop",
		severity: "warning",
		path: `/${path.join("/")}`,
		node,
		prop,
		message: reason === "undeclared"
			? `data-bind target "${prop}" is not declared on node "${node}"; the bound value was dropped`
			: `data-bind value for prop "${prop}" on node "${node}" was rejected by its sink`,
	};
}

/**
 * Resolves what a `data-bind` writes, or `null` when it writes nothing.
 *
 * A value renders through `str()` on both paths, so a bare name renders exactly as the
 * same name inside an expression does: `null` is the empty string, `0` is `"0"`.
 *
 * The paths differ only in absence. A bare name whose binding is undeclared, or whose
 * path resolved to `undefined`, writes nothing, so the fragment's authored fallback
 * survives. An expression always writes, because a computed result has no absent state
 * to fall back from.
 */
function bindValue(source: string, bindings: Record<string, unknown>): string | null {
	const parsed = parseExpressionCached(source);
	if (parsed.ok && parsed.expression.kind === "expression") {
		return renderValue(evaluateAst(parsed.expression.ast, bindings));
	}
	const name = parsed.ok
		? (parsed.expression.ast as { t: "name"; name: string }).name
		: source;
	if (!Object.prototype.hasOwnProperty.call(bindings, name)) return null;
	const value = bindings[name];
	return value === undefined ? null : renderValue(toExprValue(value));
}

function bindNode(
	node: FragmentNode,
	bindings: Record<string, unknown>,
	ctx: BindContext,
	path: number[],
	source: number[],
	within: RepeatKey[],
): FragmentNode {
	if (node.kind === "text") {
		if (!node.segments) return node;
		return { kind: "text", value: resolveSegments(node.segments, bindings) };
	}

	const props: Record<string, PropValue> = { ...node.props };
	let children = bindChildren(node.children, bindings, ctx, path, source, within);

	const condition = props["data-if"];
	if (typeof condition === "string") {
		const visible = evaluateXegCondition(condition, bindings);
		ctx.visibility[condition] = visible;
		ctx.conditions.push({ path, expression: condition, visible });
	}

	const bindSource = props["data-bind"];
	if (typeof bindSource === "string") {
		const written = bindValue(bindSource, bindings);
		if (written !== null) {
			const target = bindTarget(ctx.profile, node);
			if (target === "children") {
				children = [{ kind: "text", value: written }];
			} else {
				const routed = routePropValueDetailed(ctx.profile, node.name, target, written);
				if (routed.accepted) props[target] = routed.value;
				else ctx.diagnostics.push(bindRefusal(node.name, target, routed.reason, path));
			}
		}
	}

	const element: FragmentElement = { kind: "element", name: node.name, props, children };
	if (node.selfClosing) element.selfClosing = true;
	return element;
}

export interface FragmentInstance {
	readonly id: string;
	readonly slot: string;
	readonly format: string;
	readonly priority: number;
	readonly declaration: FragmentDeclaration;
	/** The vocabulary this fragment's format resolves to. */
	readonly profile: FormatProfile;
	/** @deprecated HTML serialization; `""` for a host-declared vocabulary. Use `sanitizedTree`. */
	readonly sanitizedSource: string;
	readonly sanitizedTree: FragmentTree;
	readonly contentType: FragmentContentType;
	readonly diagnostics: FragmentDiagnostic[];
	getContent(bindings: Record<string, unknown>): FragmentUpdateResult;
	getHandlers(): FragmentHandler[];
	/** @deprecated Renamed to `getHandlers`. */
	getEvents(): FragmentHandler[];
}

export interface FragmentOptions {
	/** The host manifest's `formats` block, when it declares formats of its own. */
	formats?: Record<string, unknown> | null;
	/** The host manifest's `vocabularies` block, when it declares vocabularies of its own. */
	vocabularies?: Record<string, unknown> | null;
	/** Promotes an unknown node under the built-in HTML vocabulary from a warning to an error. */
	strictHtmlVocabulary?: boolean;
	/** Segments `{{ expr }}` sites in text nodes. Opt-in; see `FragmentDeclaration.interpolate`. */
	interpolate?: boolean;
}

/**
 * Resolves the vocabularies in scope for a fragment's format.
 *
 * @throws {FragmentFormatError} when the format is neither built in nor declared by the host
 */
export function resolveFragmentProfile(
	format: string,
	fragmentId: string,
	formats: Record<string, unknown> | null,
	vocabularies: Record<string, unknown> | null,
): FormatProfile {
	let profile: FormatProfile | null;
	try {
		profile = resolveFormatProfile(format, formats, vocabularies);
	} catch (err) {
		if (err instanceof FormatProfileError) throw new FragmentFormatError(fragmentId, format, err.message);
		throw err;
	}
	if (!profile) throw new FragmentFormatError(fragmentId, format);
	return profile;
}

/**
 * Sanitizes a fragment's source against the vocabularies its format brings into scope.
 *
 * @throws {FragmentFormatError} when the format resolves to no vocabulary
 */
export function sanitizeSource(
	source: string,
	format: string,
	options: FragmentOptions = {},
	fragmentId = format,
): SanitizedFragment {
	const profile = resolveFragmentProfile(
		format,
		fragmentId,
		options.formats ?? null,
		options.vocabularies ?? null,
	);
	return sanitizeFragment(source, profile, {
		strictVocabulary: options.strictHtmlVocabulary,
		interpolate: options.interpolate,
	});
}

export function createFragmentInstance(
	declaration: FragmentDeclaration,
	source: string,
	options: FragmentOptions = {},
): FragmentInstance {
	const profile = resolveFragmentProfile(
		declaration.format,
		declaration.id,
		options.formats ?? null,
		options.vocabularies ?? null,
	);
	const interpolate = declaration.interpolate === true;
	const sanitized = sanitizeFragment(source, profile, {
		strictVocabulary: options.strictHtmlVocabulary,
		interpolate,
	});

	const errors = sanitized.diagnostics.filter((d) => d.severity === "error");
	if (errors.length > 0) throw new FragmentSanitizeError(declaration.id, errors);

	const declaredHandlers = declaration.handlers ?? declaration.events ?? [];
	const handlers: FragmentHandler[] = declaredHandlers.map(h => ({
		selector: h.selector,
		target: parseNodeRef(h.selector),
		on: h.on,
		handler: h.handler,
	}));

	let repeatState: RepeatState | null = null;

	return {
		id: declaration.id,
		slot: declaration.slot,
		format: declaration.format,
		priority: declaration.priority ?? 0,
		declaration,
		profile,
		sanitizedSource: sanitized.html,
		sanitizedTree: sanitized.tree,
		contentType: sanitized.contentType,
		diagnostics: sanitized.diagnostics,

		getContent(data: Record<string, unknown>): FragmentUpdateResult {
			const bindings = declaration.bindings
				? resolveBindings(declaration.bindings, data)
				: {};
			const boundTree = processTree(sanitized.tree, bindings, profile, repeatState);
			repeatState = boundTree.repeatState;
			return {
				contract: TREE_CONTRACT_VERSION,
				fragmentId: declaration.id,
				format: declaration.format,
				contentType: sanitized.contentType,
				html: projectsToHtml(profile)
					? treeToHtml(boundTree.tree, propTypeLookup(profile))
					: "",
				tree: boundTree.tree,
				visibility: boundTree.visibility,
				conditions: boundTree.conditions,
				repeats: boundTree.repeats,
				diagnostics: [...sanitized.diagnostics, ...boundTree.diagnostics],
			};
		},

		getHandlers(): FragmentHandler[] {
			return handlers;
		},

		getEvents(): FragmentHandler[] {
			return handlers;
		},
	};
}

export interface ModInstance {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly fragments: FragmentInstance[];
	readonly provides: ProviderRole[];
	/** Slot fills that are neither fragments, roles, nor hooks, keyed by slot id. */
	readonly data: Record<string, unknown[]>;
	/**
	 * Typed command fills. Before v0.8.0 these arrived untyped in `data[slotId]`; a host
	 * reading them from there reads this (or `resolveCommands`) instead.
	 */
	readonly commandFills: CommandFill[];
	/**
	 * Findings raised while loading this mod, in the order they were raised: fragment
	 * declarations first, then the entry. Under the `report` entry error policy, an entry
	 * that did not run is recorded here instead of thrown.
	 */
	readonly diagnostics: ModDiagnostic[];
	updateBindings(data: Record<string, unknown>): FragmentUpdateResult[];
	dispose(): void;
}

export interface ModInstanceOptions extends FragmentOptions {
	dataFills?: Record<string, unknown[]>;
	commandFills?: CommandFill[];
}

let modIdCounter = 0;

/**
 * What an unsupplied fragment source mounts as: an empty document in the format's own
 * syntax, so a missing JSON-syntax source mounts empty (with a diagnostic) the same way a
 * missing HTML source always has, rather than failing to parse an empty string.
 */
function emptySource(decl: FragmentDeclaration, options: FragmentOptions): string {
	const profile = resolveFragmentProfile(decl.format, decl.id, options.formats ?? null, options.vocabularies ?? null);
	return profile.syntax === "j5ml" ? "[]" : "";
}

export function createModInstance(
	modManifest: ModManifest,
	fragmentSources: Record<string, string>,
	options: ModInstanceOptions = {},
): ModInstance {
	const id = `mod-${modIdCounter++}-${modManifest.name}`;
	const fragments: FragmentInstance[] = [];

	if (modManifest.fragments) {
		for (const decl of modManifest.fragments) {
			const source = decl.inline ? decl.source : (suppliedSource(fragmentSources, decl.source) ?? emptySource(decl, options));
			fragments.push(createFragmentInstance(decl, source, options));
		}
	}
	const diagnostics = fragmentDeclarationDiagnostics(
		modManifest.name,
		modManifest.fragments ?? [],
		fragmentSources,
	);

	return {
		id,
		name: modManifest.name,
		version: modManifest.version,
		fragments,
		provides: modProviderRoles(modManifest),
		data: options.dataFills ?? {},
		commandFills: options.commandFills ?? [],
		diagnostics,

		updateBindings(data: Record<string, unknown>): FragmentUpdateResult[] {
			return fragments.map(f => f.getContent(data));
		},

		dispose() {
			fragments.length = 0;
		},
	};
}
