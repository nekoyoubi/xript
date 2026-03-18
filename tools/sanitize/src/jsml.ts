import {
	ALLOWED_ELEMENTS,
	STRIPPED_ELEMENTS,
	VOID_ELEMENTS,
	isAllowedAttribute,
	sanitizeUri,
	sanitizeStyleValue,
} from "./rules.js";

export type JsmlNode = JsmlElement | string;
export type JsmlElement = [string, ...JsmlChild[]];
type JsmlChild = Record<string, unknown> | JsmlNode;

export interface JsmlSanitizeResult {
	tree: JsmlNode[];
	html: string;
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
}

export function jsmlToHtml(nodes: JsmlNode[]): string {
	return nodes.map(nodeToHtml).join("");
}

function nodeToHtml(node: JsmlNode): string {
	if (typeof node === "string") return escapeHtml(node);
	if (!Array.isArray(node) || node.length === 0) return "";

	const tag = node[0] as string;
	if (typeof tag !== "string") return "";

	let attrs: Record<string, unknown> = {};
	let childStart = 1;

	if (node.length > 1 && isAttributeObject(node[1])) {
		attrs = node[1] as Record<string, unknown>;
		childStart = 2;
	}

	const attrStr = Object.entries(attrs)
		.map(([key, val]) => {
			if (val === true) return ` ${key}`;
			if (val === false || val === null || val === undefined) return "";
			return ` ${key}="${escapeAttrValue(String(val))}"`;
		})
		.join("");

	if (VOID_ELEMENTS.has(tag)) {
		return `<${tag}${attrStr} />`;
	}

	const children = node.slice(childStart) as JsmlNode[];
	const childHtml = children.map(nodeToHtml).join("");

	return `<${tag}${attrStr}>${childHtml}</${tag}>`;
}

export function sanitizeJsml(nodes: JsmlNode[]): JsmlSanitizeResult {
	const strippedElements: string[] = [];
	const strippedAttributes: Array<{ element: string; attribute: string }> = [];

	const sanitized = sanitizeNodes(nodes, strippedElements, strippedAttributes);
	const html = jsmlToHtml(sanitized);

	return { tree: sanitized, html, strippedElements, strippedAttributes };
}

function sanitizeNodes(
	nodes: JsmlNode[],
	strippedElements: string[],
	strippedAttributes: Array<{ element: string; attribute: string }>,
): JsmlNode[] {
	const result: JsmlNode[] = [];

	for (const node of nodes) {
		if (typeof node === "string") {
			result.push(node);
			continue;
		}

		if (!Array.isArray(node) || node.length === 0) continue;

		const tag = (node[0] as string).toLowerCase();

		if (STRIPPED_ELEMENTS.has(tag)) {
			strippedElements.push(tag);
			continue;
		}

		if (!ALLOWED_ELEMENTS.has(tag)) continue;

		let attrs: Record<string, unknown> = {};
		let childStart = 1;

		if (node.length > 1 && isAttributeObject(node[1])) {
			attrs = node[1] as Record<string, unknown>;
			childStart = 2;
		}

		const cleanAttrs: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(attrs)) {
			const lowerKey = key.toLowerCase();

			if (!isAllowedAttribute(tag, lowerKey)) {
				strippedAttributes.push({ element: tag, attribute: lowerKey });
				continue;
			}

			if ((lowerKey === "href" || lowerKey === "src") && typeof val === "string") {
				const cleaned = sanitizeUri(val, lowerKey);
				if (cleaned === null) {
					strippedAttributes.push({ element: tag, attribute: lowerKey });
					continue;
				}
				cleanAttrs[lowerKey] = cleaned;
				continue;
			}

			if (lowerKey === "style" && typeof val === "string") {
				const cleaned = sanitizeStyleValue(val);
				if (cleaned) cleanAttrs[lowerKey] = cleaned;
				continue;
			}

			cleanAttrs[lowerKey] = val;
		}

		const children = node.slice(childStart) as JsmlNode[];
		const sanitizedChildren = sanitizeNodes(children, strippedElements, strippedAttributes);

		const element: JsmlElement = [tag];
		if (Object.keys(cleanAttrs).length > 0) {
			element.push(cleanAttrs);
		}
		element.push(...sanitizedChildren);

		result.push(element);
	}

	return result;
}

function isAttributeObject(value: unknown): boolean {
	return typeof value === "object"
		&& value !== null
		&& !Array.isArray(value);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttrValue(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
