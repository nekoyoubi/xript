import { sanitizeHTML, sanitizeHTMLDetailed, sanitizeJsml, type JsmlNode } from "@xriptjs/sanitize";

export interface ModManifest {
	xript: string;
	name: string;
	version: string;
	title?: string;
	description?: string;
	author?: string;
	capabilities?: string[];
	entry?: string | string[];
	fragments?: FragmentDeclaration[];
}

export interface FragmentDeclaration {
	id: string;
	slot: string;
	format: string;
	source: string;
	inline?: boolean;
	bindings?: FragmentBinding[];
	events?: FragmentEventDeclaration[];
	priority?: number;
}

export interface FragmentBinding {
	name: string;
	path: string;
}

export interface FragmentEventDeclaration {
	selector: string;
	on: string;
	handler: string;
}

export interface SlotDeclaration {
	id: string;
	accepts: string[];
	capability?: string;
	multiple?: boolean;
	style?: "inherit" | "isolated" | "scoped";
}

export interface FragmentEvent {
	selector: string;
	on: string;
	handler: string;
}

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

	if (issues.length > 0) {
		throw new ModManifestValidationError(issues);
	}

	return manifest as ModManifest;
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

			if (slot.capability && !grantedCapabilities.has(slot.capability)) {
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
	getEvents(): FragmentEvent[];
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
	const events = (declaration.events || []).map(e => ({
		selector: e.selector,
		on: e.on,
		handler: e.handler,
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

		getEvents(): FragmentEvent[] {
			return events;
		},
	};
}

export interface ModInstance {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly fragments: FragmentInstance[];
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

		updateBindings(data: Record<string, unknown>): FragmentUpdateResult[] {
			return fragments.map(f => f.getContent(data));
		},

		dispose() {
			fragments.length = 0;
		},
	};
}
