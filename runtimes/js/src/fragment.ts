import { sanitizeHTML, sanitizeHTMLDetailed, sanitizeJsml, type JsmlNode } from "@xriptjs/sanitize";
import { grantedSatisfies } from "./capabilities.js";

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
}

export interface NormalizedMod {
	manifest: unknown;
	hookFills: HookFill[];
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
	/** @deprecated Use `handlers`. Accepted as an alias; if both are present, `handlers` wins. */
	events?: FragmentHandlerDeclaration[];
	priority?: number;
}

export interface FragmentBinding {
	name: string;
	path: string;
}

export interface FragmentHandlerDeclaration {
	selector: string;
	on: string;
	handler: string;
}

/** @deprecated Use `FragmentHandlerDeclaration`. */
export type FragmentEventDeclaration = FragmentHandlerDeclaration;

export interface SlotDeclaration {
	id: string;
	accepts: string[];
	capability?: string;
	multiple?: boolean;
	style?: "inherit" | "isolated" | "scoped";
}

export interface FragmentHandler {
	selector: string;
	on: string;
	handler: string;
}

/** @deprecated Use `FragmentHandler`. */
export type FragmentEvent = FragmentHandler;

export interface FragmentUpdateResult {
	fragmentId: string;
	html: string;
	visibility: Record<string, boolean>;
}

export class ModManifestValidationError extends Error {
	public readonly issues: Array<{ path: string; message: string }>;

	constructor(issues: Array<{ path: string; message: string }>) {
		const summary = issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
		super(`Invalid xript mod manifest:\n${summary}`);
		this.name = "ModManifestValidationError";
		this.issues = issues;
	}
}

function isEntryObject(entry: unknown): entry is ModEntry {
	return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

function validateEntry(entry: unknown, issues: Array<{ path: string; message: string }>): void {
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

export function modEntryScripts(entry: string | string[] | ModEntry | undefined): string[] {
	if (entry === undefined) return [];
	if (typeof entry === "string") return [entry];
	if (Array.isArray(entry)) return entry;
	return [entry.script];
}

export function modEntryExports(entry: string | string[] | ModEntry | undefined): Record<string, ExportDeclaration> {
	if (isEntryObject(entry) && entry.exports) return entry.exports;
	return {};
}

export function modEntryFormat(entry: string | string[] | ModEntry | undefined): "script" | "module" {
	if (isEntryObject(entry) && entry.format === "module") return "module";
	return "script";
}

export function validateModManifest(manifest: unknown): ModManifest {
	if (typeof manifest !== "object" || manifest === null) {
		throw new ModManifestValidationError([{ path: "/", message: "mod manifest must be a non-null object" }]);
	}

	const m = manifest as Record<string, unknown>;
	const issues: Array<{ path: string; message: string }> = [];

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

function validateContributions(contributions: unknown, issues: Array<{ path: string; message: string }>): void {
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

const ROLE_SLOT_ACCEPT = "application/x-xript-role";
const HOOK_SLOT_ACCEPT = "application/x-xript-hook";

/**
 * Resolves a mod's canonical `fills` surface into the runtime's internal
 * contribution model, typed by each target slot's `accepts`: a fragment-format
 * fill becomes a fragment declaration, a role fill becomes a provider role, an
 * event/hook fill becomes an export-backed hook handler the host fires. A mod
 * that mixes `fills` with the deprecated `fragments`/`contributions` surfaces
 * is rejected rather than silently double-contributing.
 */
export function normalizeModFills(
	modManifest: unknown,
	slots: SlotDeclaration[],
	grantedCapabilities: Set<string>,
): NormalizedMod {
	if (typeof modManifest !== "object" || modManifest === null) {
		return { manifest: modManifest, hookFills: [] };
	}
	const m = modManifest as Record<string, unknown>;
	if (m.fills === undefined) {
		return { manifest: modManifest, hookFills: [] };
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

	const issues: Array<{ path: string; message: string }> = [];
	const slotMap = new Map(slots.map((slot) => [slot.id, slot]));
	const fragments: Array<Record<string, unknown>> = [];
	const provides: Array<Record<string, unknown>> = [];
	const hookFills: HookFill[] = [];

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
		entries.forEach((entry, index) => {
			const prefix = `/fills/${slotId}/${index}`;
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				issues.push({ path: prefix, message: "a fill must be an object" });
				return;
			}
			const fill = entry as Record<string, unknown>;
			if (slot.accepts.includes(ROLE_SLOT_ACCEPT)) {
				if (typeof fill.fns !== "object" || fill.fns === null || Array.isArray(fill.fns)) {
					issues.push({ path: `${prefix}/fns`, message: "a role fill must map logical fn names to exports via 'fns'" });
					return;
				}
				if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
					issues.push({ path: prefix, message: `slot '${slotId}' requires capability '${slot.capability}'` });
					return;
				}
				provides.push({ role: slotId, fns: fill.fns });
			} else if (slot.accepts.includes(HOOK_SLOT_ACCEPT)) {
				if (typeof fill.handler !== "string" || fill.handler.length === 0) {
					issues.push({ path: `${prefix}/handler`, message: "an event/hook fill must name a 'handler' export" });
					return;
				}
				if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
					issues.push({ path: prefix, message: `slot '${slotId}' requires capability '${slot.capability}'` });
					return;
				}
				hookFills.push({ hook: slotId, handler: fill.handler });
			} else {
				fragments.push({ id: `${slotId}-fill-${index}`, ...fill, slot: slotId });
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
	};
}

export function validateModAgainstApp(
	modManifest: ModManifest,
	slots: SlotDeclaration[],
	grantedCapabilities: Set<string>,
): Array<{ path: string; message: string }> {
	const issues: Array<{ path: string; message: string }> = [];
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
			}

			if (slot.capability && !grantedSatisfies(grantedCapabilities, slot.capability)) {
				issues.push({ path: `${prefix}/slot`, message: `slot '${frag.slot}' requires capability '${slot.capability}'` });
			}
		}
	}

	return issues;
}

export function resolveBindingPath(data: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = data;

	for (const part of parts) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
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

export function processFragment(
	sanitizedSource: string,
	bindings: Record<string, unknown>,
): { html: string; visibility: Record<string, boolean> } {
	let html = sanitizedSource.replace(DATA_BIND_PATTERN, (match, openTag, bindName, _content, closeTag) => {
		const value = bindings[bindName];
		if (value === undefined) return match;
		return `${openTag}${String(value)}${closeTag}`;
	});

	html = html.replace(SELF_CLOSING_DATA_BIND_PATTERN, (match, beforeClose, bindName) => {
		const value = bindings[bindName];
		if (value === undefined) return match;
		const valueAttr = `value="${String(value)}"`;
		if (beforeClose.includes("value=")) {
			return beforeClose.replace(/value="[^"]*"/, valueAttr) + " />";
		}
		return `${beforeClose} ${valueAttr} />`;
	});

	const visibility: Record<string, boolean> = {};
	let ifMatch;
	DATA_IF_PATTERN.lastIndex = 0;
	while ((ifMatch = DATA_IF_PATTERN.exec(html)) !== null) {
		const expression = ifMatch[1];
		visibility[expression] = evaluateCondition(expression, bindings);
	}

	return { html, visibility };
}

const SAFE_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export function evaluateCondition(expression: string, bindings: Record<string, unknown>): boolean {
	try {
		const safeBindings: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(bindings)) {
			if (!SAFE_IDENTIFIER.test(name)) continue;
			safeBindings[name] = value;
		}

		const varDeclarations = Object.entries(safeBindings)
			.map(([name, value]) => `var ${name} = ${JSON.stringify(value)};`)
			.join(" ");
		const code = `${varDeclarations} return !!(${expression})`;
		const fn = new Function(code);
		return fn();
	} catch {
		return false;
	}
}

export function sanitizeFragmentSource(source: string): { html: string; stripped: boolean } {
	const result = sanitizeHTMLDetailed(source);
	return {
		html: result.html,
		stripped: result.strippedElements.length > 0 || result.strippedAttributes.length > 0,
	};
}

export interface FragmentInstance {
	readonly id: string;
	readonly slot: string;
	readonly format: string;
	readonly priority: number;
	readonly declaration: FragmentDeclaration;
	readonly sanitizedSource: string;
	getContent(bindings: Record<string, unknown>): FragmentUpdateResult;
	getHandlers(): FragmentHandler[];
	/** @deprecated Use `getHandlers()`. */
	getEvents(): FragmentHandler[];
}

function sanitizeSource(source: string, format: string): string {
	if (format === "application/jsml+json") {
		const parsed = JSON.parse(source);
		const nodes: JsmlNode[] = Array.isArray(parsed) && typeof parsed[0] === "string"
			? [parsed]
			: (Array.isArray(parsed) ? parsed : [parsed]);
		return sanitizeJsml(nodes).html;
	}
	return sanitizeHTML(source);
}

export function createFragmentInstance(
	declaration: FragmentDeclaration,
	source: string,
): FragmentInstance {
	const sanitized = sanitizeSource(source, declaration.format);
	const handlerSource = declaration.handlers ?? declaration.events ?? [];
	const handlers = handlerSource.map(h => ({
		selector: h.selector,
		on: h.on,
		handler: h.handler,
	}));

	return {
		id: declaration.id,
		slot: declaration.slot,
		format: declaration.format,
		priority: declaration.priority ?? 0,
		declaration,
		sanitizedSource: sanitized,

		getContent(data: Record<string, unknown>): FragmentUpdateResult {
			const bindings = declaration.bindings
				? resolveBindings(declaration.bindings, data)
				: {};
			const result = processFragment(sanitized, bindings);
			return {
				fragmentId: declaration.id,
				html: result.html,
				visibility: result.visibility,
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
	updateBindings(data: Record<string, unknown>): FragmentUpdateResult[];
	dispose(): void;
}

let modIdCounter = 0;

export function createModInstance(
	modManifest: ModManifest,
	fragmentSources: Record<string, string>,
): ModInstance {
	const id = `mod-${modIdCounter++}-${modManifest.name}`;
	const fragments: FragmentInstance[] = [];

	if (modManifest.fragments) {
		for (const decl of modManifest.fragments) {
			const source = decl.inline ? decl.source : (fragmentSources[decl.source] ?? "");
			fragments.push(createFragmentInstance(decl, source));
		}
	}

	return {
		id,
		name: modManifest.name,
		version: modManifest.version,
		fragments,
		provides: modProviderRoles(modManifest),

		updateBindings(data: Record<string, unknown>): FragmentUpdateResult[] {
			return fragments.map(f => f.getContent(data));
		},

		dispose() {
			fragments.length = 0;
		},
	};
}
