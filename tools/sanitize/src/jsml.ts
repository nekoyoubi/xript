import { BUILTIN_PROFILES } from "./profiles.js";
import { sanitizeTree, type FragmentDiagnostic } from "./vocabulary.js";
import { jsmlToTree, treeToHtml, treeToJsml, type JsmlNode } from "./tree.js";

export type { JsmlNode, JsmlElement, JsmlChild } from "./tree.js";

export interface JsmlSanitizeResult {
	tree: JsmlNode[];
	html: string;
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
	diagnostics: FragmentDiagnostic[];
}

export function jsmlToHtml(nodes: JsmlNode[]): string {
	return treeToHtml(jsmlToTree(nodes));
}

/**
 * Sanitizes J5ML nodes against the built-in HTML vocabulary.
 *
 * Returns the sanitized nodes in J5ML array form. A host-declared vocabulary is
 * reached through `sanitizeFragment` with a resolved `FormatProfile`.
 */
export function sanitizeJsml(nodes: JsmlNode[]): JsmlSanitizeResult {
	const result = sanitizeTree(jsmlToTree(nodes), BUILTIN_PROFILES["application/jsml+json"]);

	return {
		tree: treeToJsml(result.tree),
		html: treeToHtml(result.tree),
		strippedElements: result.strippedElements,
		strippedAttributes: result.strippedAttributes,
		diagnostics: result.diagnostics,
	};
}
