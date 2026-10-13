import { isPlainObject } from "./tree.js";
import {
	DEFAULT_URI_SCHEME_SET,
	PROHIBITED_URI_SCHEMES,
	STRIPPED_ELEMENTS,
	URI_SCHEME_NAME_PATTERN,
} from "./rules.js";

export type FragmentSyntax = "html" | "j5ml";

/**
 * Wire spellings accepted for a format's `syntax`, mapped to the canonical
 * value. `jsml` is deprecated and parses identically to `j5ml`.
 */
export const SYNTAX_ALIASES: Readonly<Record<string, FragmentSyntax>> = Object.freeze({
	html: "html",
	j5ml: "j5ml",
	jsml: "j5ml",
});
/** The only vocabulary a format may name without declaring it. */
export const BUILTIN_VOCABULARY_IDS = ["html"] as const;

/**
 * Where a prop's value lands. This — not the node's name — is the only thing
 * sanitization ever needed to know.
 */
export type Sink = "text" | "uri" | "image-uri" | "css" | "html";

export const SINKS: readonly Sink[] = ["text", "uri", "image-uri", "css", "html"];

/** A JSON Schema body plus the reserved `sink` keyword. */
export interface PropDefinition {
	sink?: Sink;
	type?: string | string[];
	[jsonSchemaKeyword: string]: unknown;
}

export type ChildrenConstraint = "any" | "none" | "text" | string[];

export interface NodeDefinition {
	description?: string;
	props?: Record<string, PropDefinition>;
	children?: ChildrenConstraint;
	bindTo?: string;
}

/**
 * One vocabulary in a format's resolved scope. A `declared` vocabulary carries its
 * own nodes and, when it came from the manifest's `vocabularies` block rather than a
 * format's inline `nodes`, the id it was declared under.
 */
export type ResolvedVocabulary =
	| { kind: "declared"; id: string | null; nodes: Record<string, NodeDefinition> }
	| { kind: "builtin-html" };

export interface FormatProfile {
	id: string;
	syntax: FragmentSyntax;
	/** The vocabularies in scope, in resolution order: the first to claim a node name wins. */
	scope: readonly ResolvedVocabulary[];
	/**
	 * The URI schemes a `uri` or `image-uri` value may name, lowercase and without the
	 * colon. Absolute URIs naming anything else are dropped; relative values carry no
	 * scheme and are unaffected. Empty means deliberate closure: no absolute URIs at all.
	 */
	schemes: ReadonlySet<string>;
	/** True for the four reserved built-in profiles. Drives `contentType`. */
	builtin: boolean;
}

const BUILTIN_HTML_SCOPE: readonly ResolvedVocabulary[] = Object.freeze([
	Object.freeze({ kind: "builtin-html" }) as ResolvedVocabulary,
]);

/** Props legal on every node of every vocabulary. Always strings, never sanitized, never dropped. */
export const PROTOCOL_PROPS = new Set(["id", "data-bind", "data-if", "data-each", "data-key"]);

export const BUILTIN_FORMAT_IDS = [
	"text/html",
	"text/html+jsml",
	"application/j5ml+json",
	"application/jsml+json",
] as const;

/** Slot content types that are not fragments at all and are never sanitized. */
export const NON_FRAGMENT_FORMAT_IDS = [
	"application/x-xript-role",
	"application/x-xript-hook",
	"application/x-xript-command",
] as const;

/** Format ids a host may not declare in its own `formats` block. */
export const RESERVED_FORMAT_IDS: ReadonlySet<string> = new Set<string>([
	...BUILTIN_FORMAT_IDS,
	...NON_FRAGMENT_FORMAT_IDS,
]);

export const BUILTIN_PROFILES: Readonly<Record<string, FormatProfile>> = Object.freeze({
	"text/html": Object.freeze({
		id: "text/html",
		syntax: "html",
		scope: BUILTIN_HTML_SCOPE,
		schemes: DEFAULT_URI_SCHEME_SET,
		builtin: true,
	}),
	"text/html+jsml": Object.freeze({
		id: "text/html+jsml",
		syntax: "html",
		scope: BUILTIN_HTML_SCOPE,
		schemes: DEFAULT_URI_SCHEME_SET,
		builtin: true,
	}),
	"application/j5ml+json": Object.freeze({
		id: "application/j5ml+json",
		syntax: "j5ml",
		scope: BUILTIN_HTML_SCOPE,
		schemes: DEFAULT_URI_SCHEME_SET,
		builtin: true,
	}),
	"application/jsml+json": Object.freeze({
		id: "application/jsml+json",
		syntax: "j5ml",
		scope: BUILTIN_HTML_SCOPE,
		schemes: DEFAULT_URI_SCHEME_SET,
		builtin: true,
	}),
} as Record<string, FormatProfile>);

/**
 * Why a format declaration was refused. Callers that report rather than throw — the
 * validator's lint pass, chiefly — need to tell an undeclared vocabulary reference apart
 * from a malformed scope without reading the message text.
 */
export type FormatProfileErrorCode =
	| "malformed"
	| "unknown-syntax"
	| "unknown-vocabulary"
	| "html-not-last"
	| "empty-scope"
	| "stripped-name-shadowed"
	| "invalid-schemes"
	| "prohibited-scheme";

export class FormatProfileError extends Error {
	readonly format: string;
	readonly code: FormatProfileErrorCode;

	constructor(format: string, message: string, code: FormatProfileErrorCode = "malformed") {
		super(message);
		this.name = "FormatProfileError";
		this.format = format;
		this.code = code;
	}
}

function parseNodes(
	raw: unknown,
	format: string,
	origin: string,
): Record<string, NodeDefinition> {
	if (!isPlainObject(raw)) {
		throw new FormatProfileError(format, `${origin} declares a non-object 'nodes'`);
	}

	const nodes: Record<string, NodeDefinition> = {};
	for (const name of Object.keys(raw)) {
		const definition = raw[name];
		if (!isPlainObject(definition)) {
			throw new FormatProfileError(format, `${origin} declares a non-object node: ${name}`);
		}
		Object.defineProperty(nodes, name, {
			value: definition as NodeDefinition,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return nodes;
}

/**
 * Reads a format's `schemes` into the effective scheme set.
 *
 * Absent means the default safe set. Present replaces it wholesale, so a host both
 * widens and narrows through the same key, and `[]` is deliberate closure rather than
 * a shorthand for the default. Naming `javascript` or `vbscript` is refused outright:
 * dropping them silently would let a host believe it had granted something it had not,
 * and the whole point of the floor is that no host can argue its way under it.
 */
function parseSchemes(raw: unknown, format: string): ReadonlySet<string> {
	if (raw === undefined) return DEFAULT_URI_SCHEME_SET;
	if (!Array.isArray(raw)) {
		throw new FormatProfileError(
			format,
			`fragment format "${format}" declares a non-array 'schemes'`,
			"invalid-schemes",
		);
	}

	const schemes = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== "string") {
			throw new FormatProfileError(
				format,
				`fragment format "${format}" declares a non-string scheme: ${JSON.stringify(entry)}`,
				"invalid-schemes",
			);
		}
		const scheme = entry.toLowerCase();
		if (PROHIBITED_URI_SCHEMES.has(scheme)) {
			throw new FormatProfileError(
				format,
				`fragment format "${format}" declares the prohibited scheme "${scheme}"; it is refused in every fragment and cannot be allow-listed`,
				"prohibited-scheme",
			);
		}
		if (!URI_SCHEME_NAME_PATTERN.test(scheme)) {
			throw new FormatProfileError(
				format,
				`fragment format "${format}" declares a malformed scheme: ${JSON.stringify(entry)}; a scheme is a lowercase name with no colon`,
				"invalid-schemes",
			);
		}
		schemes.add(scheme);
	}
	return schemes;
}

function isBuiltinVocabularyId(ref: string): boolean {
	return (BUILTIN_VOCABULARY_IDS as readonly string[]).includes(ref);
}

/**
 * Resolves a media type to the vocabularies a fragment of that type may speak.
 *
 * @param format - the fragment's media type
 * @param formats - the host manifest's `formats` block, if it declares one
 * @param vocabularies - the host manifest's `vocabularies` block, if it declares one
 * @returns the profile, or `null` when the format is unknown (built-in ids always win)
 * @throws {FormatProfileError} when the format is declared but malformed
 */
export function resolveFormatProfile(
	format: string,
	formats: Record<string, unknown> | null,
	vocabularies: Record<string, unknown> | null,
): FormatProfile | null {
	const builtin = Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, format)
		? BUILTIN_PROFILES[format]
		: undefined;
	if (builtin) return builtin;

	if (!formats || !Object.prototype.hasOwnProperty.call(formats, format)) return null;

	const declaration = formats[format];
	if (!isPlainObject(declaration)) {
		throw new FormatProfileError(format, `fragment format "${format}" is not an object`);
	}

	const declaredSyntax = declaration.syntax;
	const syntax =
		typeof declaredSyntax === "string"
			? (SYNTAX_ALIASES[declaredSyntax] ?? undefined)
			: undefined;
	if (syntax === undefined) {
		throw new FormatProfileError(
			format,
			`fragment format "${format}" declares an unknown syntax: ${JSON.stringify(declaredSyntax)}`,
			"unknown-syntax",
		);
	}

	const schemes = parseSchemes(declaration.schemes, format);

	const scope: ResolvedVocabulary[] = [];

	if (declaration.nodes !== undefined) {
		scope.push({
			kind: "declared",
			id: null,
			nodes: parseNodes(declaration.nodes, format, `fragment format "${format}"`),
		});
	}

	const refs = declaration.vocabularies;
	if (refs !== undefined) {
		if (!Array.isArray(refs)) {
			throw new FormatProfileError(
				format,
				`fragment format "${format}" declares a non-array 'vocabularies'`,
			);
		}
		for (const ref of refs) {
			if (typeof ref !== "string") {
				throw new FormatProfileError(
					format,
					`fragment format "${format}" references a non-string vocabulary: ${JSON.stringify(ref)}`,
				);
			}
			if (isBuiltinVocabularyId(ref)) {
				scope.push({ kind: "builtin-html" });
				continue;
			}
			if (vocabularies && Object.prototype.hasOwnProperty.call(vocabularies, ref)) {
				const declared = vocabularies[ref];
				if (!isPlainObject(declared)) {
					throw new FormatProfileError(format, `vocabulary "${ref}" is not an object`);
				}
				scope.push({
					kind: "declared",
					id: ref,
					nodes: parseNodes(declared.nodes, format, `vocabulary "${ref}"`),
				});
				continue;
			}
			if (!ref.includes(".")) {
				throw new FormatProfileError(
					format,
					`fragment format "${format}" references "${ref}", which is not a built-in vocabulary (built-ins: ${BUILTIN_VOCABULARY_IDS.join(", ")}); a host-declared vocabulary id needs two or more dot-separated segments`,
					"unknown-vocabulary",
				);
			}
			throw new FormatProfileError(
				format,
				`fragment format "${format}" references an undeclared vocabulary: "${ref}"`,
				"unknown-vocabulary",
			);
		}
	}

	const htmlIndex = scope.findIndex((entry) => entry.kind === "builtin-html");
	if (htmlIndex >= 0 && htmlIndex !== scope.length - 1) {
		throw new FormatProfileError(
			format,
			`fragment format "${format}" lists the built-in html vocabulary before a declared vocabulary; html must be last so declared nodes always win`,
			"html-not-last",
		);
	}

	if (scope.length === 0) {
		throw new FormatProfileError(
			format,
			`fragment format "${format}" declares no vocabulary and admits no nodes`,
			"empty-scope",
		);
	}

	if (htmlIndex >= 0) {
		for (const entry of scope) {
			if (entry.kind !== "declared") continue;
			for (const name of Object.keys(entry.nodes)) {
				if (!STRIPPED_ELEMENTS.has(name.toLowerCase())) continue;
				throw new FormatProfileError(
					format,
					`fragment format "${format}" brings a vocabulary declaring "${name}" into scope alongside the built-in html vocabulary; "${name}" is an element the sanitizer always strips and may not be shadowed`,
					"stripped-name-shadowed",
				);
			}
		}
	}

	return { id: format, syntax, scope, schemes, builtin: false };
}

/** Whether the built-in HTML vocabulary is anywhere in the format's scope. */
export function speaksHtml(profile: FormatProfile): boolean {
	return profile.scope.some((entry) => entry.kind === "builtin-html");
}

/** Whether any declared vocabulary in scope owns `name` verbatim. */
export function anyVocabularyDeclares(profile: FormatProfile, name: string): boolean {
	return nodeDefinition(profile, name) !== undefined;
}

/**
 * The definition the first vocabulary in scope claiming `name` gives it. Names are
 * matched verbatim and case-sensitively; the built-in HTML vocabulary is not consulted,
 * since it resolves tags rather than declaring nodes.
 */
export function nodeDefinition(profile: FormatProfile, name: string): NodeDefinition | undefined {
	for (const entry of profile.scope) {
		if (entry.kind !== "declared") continue;
		if (Object.prototype.hasOwnProperty.call(entry.nodes, name)) return entry.nodes[name];
	}
	return undefined;
}

/**
 * The declared JSON Schema `type` of a node's prop under this profile, for the HTML
 * projection's structured-value encoding. `undefined` for an undeclared node or prop.
 */
export function declaredPropType(
	profile: FormatProfile,
	node: string,
	prop: string,
): string | string[] | undefined {
	const definition = nodeDefinition(profile, node);
	if (!definition) return undefined;
	return propDefinition(definition, prop)?.type;
}

/** Binds `declaredPropType` to a profile, in the shape `treeToHtml` takes. */
export function propTypeLookup(profile: FormatProfile): (node: string, prop: string) => string | string[] | undefined {
	return (node, prop) => declaredPropType(profile, node, prop);
}

export function propDefinition(node: NodeDefinition, name: string): PropDefinition | undefined {
	if (!node.props) return undefined;
	return Object.prototype.hasOwnProperty.call(node.props, name) ? node.props[name] : undefined;
}
