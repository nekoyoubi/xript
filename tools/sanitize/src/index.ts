import { tokenize, type Token, type Attribute } from "./tokenizer.js";
import { sanitizeJsml as sanitizeJsmlImpl } from "./jsml.js";
import {
	ALLOWED_ELEMENTS,
	STRIPPED_ELEMENTS,
	UNWRAPPED_ELEMENTS,
	VOID_ELEMENTS,
	isAllowedAttribute,
	sanitizeUri,
	sanitizeStyleValue,
	sanitizeStyleBlock,
} from "./rules.js";

export { ALLOWED_ELEMENTS, STRIPPED_ELEMENTS, UNWRAPPED_ELEMENTS, VOID_ELEMENTS } from "./rules.js";
export { jsmlToHtml, sanitizeJsml, type JsmlNode, type JsmlElement, type JsmlSanitizeResult } from "./jsml.js";

export interface SanitizeResult {
	html: string;
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
}

export interface FragmentValidationResult {
	valid: boolean;
	errors: Array<{ message: string; line?: number }>;
	sanitized: string;
}

export function sanitizeHTML(input: string): string {
	return sanitizeHTMLDetailed(input).html;
}

export function sanitizeHTMLDetailed(input: string): SanitizeResult {
	const tokens = tokenize(input);
	const strippedElements: string[] = [];
	const strippedAttributes: Array<{ element: string; attribute: string }> = [];

	let output = "";
	let stripDepth = 0;
	let currentStrippedTag = "";
	const stripStack: string[] = [];
	let insideStyle = false;

	for (let idx = 0; idx < tokens.length; idx++) {
		const token = tokens[idx];

		if (stripDepth > 0) {
			if (token.type === "open") {
				if (STRIPPED_ELEMENTS.has(token.tag)) {
					if (!VOID_ELEMENTS.has(token.tag) && !token.selfClosing) {
						stripStack.push(token.tag);
						stripDepth++;
					}
				}
			} else if (token.type === "close") {
				if (stripStack.length > 0 && stripStack[stripStack.length - 1] === token.tag) {
					stripStack.pop();
					stripDepth--;
				} else if (token.tag === currentStrippedTag && stripDepth === 1) {
					stripDepth--;
					currentStrippedTag = "";
				}
			}
			continue;
		}

		if (insideStyle) {
			if (token.type === "close" && token.tag === "style") {
				output += "</style>";
				insideStyle = false;
			}
			continue;
		}

		switch (token.type) {
			case "text":
				output += token.value;
				break;

			case "comment":
				break;

			case "open": {
				if (UNWRAPPED_ELEMENTS.has(token.tag)) {
					break;
				}

				if (STRIPPED_ELEMENTS.has(token.tag)) {
					strippedElements.push(token.tag);
					if (!VOID_ELEMENTS.has(token.tag) && !token.selfClosing) {
						stripDepth = 1;
						currentStrippedTag = token.tag;
					}
					break;
				}

				if (!ALLOWED_ELEMENTS.has(token.tag)) {
					break;
				}

				const cleanAttrs = sanitizeAttributes(token.tag, token.attributes, strippedAttributes);

				if (token.tag === "style") {
					output += buildOpenTag(token.tag, cleanAttrs, false);
					const styleContent = collectStyleContent(tokens, idx);
					output += sanitizeStyleBlock(styleContent);
					insideStyle = true;
					break;
				}

				const isVoid = VOID_ELEMENTS.has(token.tag);
				output += buildOpenTag(token.tag, cleanAttrs, token.selfClosing || isVoid);
				break;
			}

			case "close": {
				if (UNWRAPPED_ELEMENTS.has(token.tag)) break;
				if (STRIPPED_ELEMENTS.has(token.tag)) break;
				if (!ALLOWED_ELEMENTS.has(token.tag)) break;
				if (VOID_ELEMENTS.has(token.tag)) break;
				output += `</${token.tag}>`;
				break;
			}
		}
	}

	return { html: output, strippedElements, strippedAttributes };
}

function sanitizeAttributes(
	tag: string,
	attributes: Attribute[],
	strippedLog: Array<{ element: string; attribute: string }>,
): Attribute[] {
	const result: Attribute[] = [];

	for (const attr of attributes) {
		const lowerName = attr.name.toLowerCase();

		if (!isAllowedAttribute(tag, lowerName)) {
			strippedLog.push({ element: tag, attribute: lowerName });
			continue;
		}

		if (lowerName === "href" || lowerName === "src") {
			const cleaned = sanitizeUri(attr.value, lowerName);
			if (cleaned === null) {
				strippedLog.push({ element: tag, attribute: lowerName });
				continue;
			}
			result.push({ name: lowerName, value: cleaned });
			continue;
		}

		if (lowerName === "style") {
			const cleaned = sanitizeStyleValue(attr.value);
			if (cleaned) {
				result.push({ name: lowerName, value: cleaned });
			}
			continue;
		}

		result.push({ name: lowerName, value: attr.value });
	}

	return result;
}

function buildOpenTag(tag: string, attributes: Attribute[], selfClosing: boolean): string {
	let html = `<${tag}`;
	for (const attr of attributes) {
		if (attr.value === "") {
			html += ` ${attr.name}`;
		} else {
			html += ` ${attr.name}="${escapeAttrValue(attr.value)}"`;
		}
	}
	html += selfClosing ? " />" : ">";
	return html;
}

function escapeAttrValue(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function collectStyleContent(tokens: Token[], styleOpenIndex: number): string {
	let content = "";
	for (let i = styleOpenIndex + 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === "close" && token.tag === "style") break;
		if (token.type === "text") content += token.value;
	}
	return content;
}

export function validateFragment(input: string, format: string = "text/html"): FragmentValidationResult {
	if (format === "application/jsml+json") {
		return validateJsmlFragment(input);
	}

	if (format !== "text/html") {
		return {
			valid: false,
			errors: [{ message: `unsupported fragment format: ${format}` }],
			sanitized: "",
		};
	}

	const result = sanitizeHTMLDetailed(input);
	const errors: Array<{ message: string }> = [];

	for (const tag of result.strippedElements) {
		errors.push({ message: `stripped dangerous element: <${tag}>` });
	}

	for (const attr of result.strippedAttributes) {
		errors.push({ message: `stripped dangerous attribute: ${attr.attribute} on <${attr.element}>` });
	}

	return {
		valid: errors.length === 0,
		errors,
		sanitized: result.html,
	};
}

function validateJsmlFragment(input: string): FragmentValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return {
			valid: false,
			errors: [{ message: "invalid JSON" }],
			sanitized: "",
		};
	}

	const isSingleElement = Array.isArray(parsed)
		&& parsed.length > 0
		&& typeof parsed[0] === "string";
	const nodes = isSingleElement ? [parsed] : (Array.isArray(parsed) ? parsed : [parsed]);
	const result = sanitizeJsmlImpl(nodes);
	const errors: Array<{ message: string }> = [];

	for (const tag of result.strippedElements) {
		errors.push({ message: `stripped dangerous element: <${tag}>` });
	}
	for (const attr of result.strippedAttributes) {
		errors.push({ message: `stripped dangerous attribute: ${attr.attribute} on <${attr.element}>` });
	}

	return {
		valid: errors.length === 0,
		errors,
		sanitized: result.html,
	};
}
