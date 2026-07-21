import { htmlToTree, type SanitizeResult } from "./html.js";
import { jsmlToTree, treeToHtml, type FragmentTree, type JsmlNode } from "./tree.js";
import {
	sanitizeHtmlString,
	sanitizeTree,
	type FragmentDiagnostic,
	type VocabularyOptions,
} from "./vocabulary.js";
import { speaksHtml, type FormatProfile } from "./profiles.js";

export type FragmentContentType = "html" | "tree";

export interface SanitizedFragment {
	tree: FragmentTree;
	/**
	 * HTML serialization. Byte-identical to the string sanitizer's output for the
	 * built-in profiles; `""` for a host-declared vocabulary, which has no HTML
	 * projection — the host mounts the tree.
	 */
	html: string;
	contentType: FragmentContentType;
	diagnostics: FragmentDiagnostic[];
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
}

export class FragmentParseError extends Error {
	readonly format: string;

	constructor(format: string, message: string) {
		super(message);
		this.name = "FragmentParseError";
		this.format = format;
	}
}

/**
 * Whether a format has a meaningful HTML projection.
 *
 * Built-in formats always do. A host-declared format does when it is HTML plus
 * custom elements: the built-in `html` vocabulary is in scope, and every node
 * every other vocabulary in scope declares is a valid custom element name. Those
 * names mean something to a browser, so the tree serializes to markup a host can
 * mount directly instead of walking itself.
 *
 * Both halves are load-bearing. A scope without HTML carries no HTML meaning at
 * all. And a vocabulary that declares a name HTML already owns, or one a browser
 * would not treat as a custom element, must not project: a declared node named
 * `style` would become a live `<style>` element, and a name without a hyphen is
 * inert markup rather than a component. The scan spans every vocabulary in scope,
 * not just the format's inline nodes, so a referenced vocabulary cannot smuggle a
 * bare `<Panel>` into projected markup.
 */
function projectsToHtml(profile: FormatProfile): boolean {
	if (profile.builtin) return true;
	if (!speaksHtml(profile)) return false;
	return profile.scope.every(
		(entry) => entry.kind !== "declared" || Object.keys(entry.nodes).every(isCustomElementName),
	);
}

/**
 * A name a browser resolves as a custom element: it carries a hyphen, starts
 * with an ASCII letter, and is not one of the hyphenated names SVG and MathML
 * already define.
 */
function isCustomElementName(name: string): boolean {
	const lower = name.toLowerCase();
	if (!/^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(lower)) return false;
	return !RESERVED_HYPHENATED_NAMES.has(lower);
}

const RESERVED_HYPHENATED_NAMES = new Set([
	"annotation-xml",
	"color-profile",
	"font-face",
	"font-face-src",
	"font-face-uri",
	"font-face-format",
	"font-face-name",
	"missing-glyph",
]);

/**
 * Sanitizes a fragment source against the vocabulary its format declares.
 *
 * @param source - the fragment source, in the format's syntax
 * @param profile - the resolved format profile
 * @throws {FragmentParseError} when a `jsml`-syntax source is not valid JSON
 */
export function sanitizeFragment(
	source: string,
	profile: FormatProfile,
	options: VocabularyOptions = {},
): SanitizedFragment {
	if (profile.syntax === "j5ml") {
		const parsed = sanitizeTree(jsmlToTree(parseJsmlSource(source, profile.id)), profile, options);
		return {
			tree: parsed.tree,
			html: projectsToHtml(profile) ? treeToHtml(parsed.tree) : "",
			contentType: profile.builtin ? "html" : "tree",
			diagnostics: parsed.diagnostics,
			strippedElements: parsed.strippedElements,
			strippedAttributes: parsed.strippedAttributes,
		};
	}

	const parsed = sanitizeTree(htmlToTree(source, profile), profile, options);

	if (!profile.builtin) {
		return {
			tree: parsed.tree,
			html: projectsToHtml(profile) ? treeToHtml(parsed.tree) : "",
			contentType: "tree",
			diagnostics: parsed.diagnostics,
			strippedElements: parsed.strippedElements,
			strippedAttributes: parsed.strippedAttributes,
		};
	}

	return {
		tree: parsed.tree,
		html: treeToHtml(parsed.tree),
		contentType: "html",
		diagnostics: parsed.diagnostics,
		strippedElements: parsed.strippedElements,
		strippedAttributes: parsed.strippedAttributes,
	};
}

/**
 * Parses a JSML source string into the J5ML node list the tree builder expects.
 * A bare element (`["div", …]`) and a node list (`[["div"], ["p"]]`) are both accepted.
 */
export function parseJsmlSource(source: string, format = "application/jsml+json"): JsmlNode[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new FragmentParseError(format, "invalid JSON");
	}

	const isSingleElement = Array.isArray(parsed)
		&& parsed.length > 0
		&& typeof parsed[0] === "string";

	if (isSingleElement) return [parsed as JsmlNode];
	return (Array.isArray(parsed) ? parsed : [parsed]) as JsmlNode[];
}

/**
 * Sanitizes an HTML string against the built-in HTML vocabulary.
 *
 * The output is produced by serializing the sanitized tree, never by patching the
 * input string, so it is always well-formed: an input that leaves elements
 * unclosed still yields balanced markup. That matters because a caller inserts
 * this output somewhere, and unbalanced markup re-parses against its insertion
 * context and adopts whatever follows it.
 */
export function sanitizeHTMLDetailed(input: string): SanitizeResult {
	return sanitizeHtmlString(input);
}

export function sanitizeHTML(input: string): string {
	return sanitizeHtmlString(input).html;
}
