import { tokenize, type Token, type Attribute } from "./tokenizer.js";
import {
	ALLOWED_ELEMENTS,
	STRIPPED_ELEMENTS,
	SVG_TEXT_ELEMENTS,
	UNWRAPPED_ELEMENTS,
	VOID_ELEMENTS,
	isAllowedAttribute,
	canonicalAttributeName,
	sanitizeUri,
	sanitizeStyleValue,
	sanitizeStyleBlock,
} from "./rules.js";
import {
	escapeAttrValue,
	setProp,
	type FragmentElement,
	type FragmentTree,
	type PropValue,
} from "./tree.js";
import { anyVocabularyDeclares, speaksHtml, type FormatProfile } from "./profiles.js";

export interface SanitizeResult {
	html: string;
	strippedElements: string[];
	strippedAttributes: Array<{ element: string; attribute: string }>;
}

/**
 * Elements whose content the HTML parser reads as raw text rather than markup.
 * An unclosed one genuinely does run to the end of input — a browser treats a
 * `</div>` inside `<script>` as text — so skipping to EOF is correct for these
 * and only for these.
 */
const RAWTEXT_ELEMENTS = new Set([
	"script",
	"style",
	"title",
	"textarea",
	"noscript",
	"iframe",
	"xmp",
	"noembed",
	"noframes",
]);

function collectStyleContent(tokens: Token[], styleOpenIndex: number): string {
	let content = "";
	for (let i = styleOpenIndex + 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === "close" && token.tag === "style") break;
		if (token.type === "text") content += token.value;
	}
	return content;
}

/**
 * Parses an HTML source string into an unsanitized fragment tree, preserving node
 * and prop name casing. Vocabulary rules are applied afterwards by `sanitizeTree`.
 *
 * HTML's raw-text elements (`<style>`, and every element the vocabulary strips
 * outright, such as `<script>`) do not have their content parsed as markup. Their
 * content is a raw-text region in the HTML grammar, so a `</div>` inside one is
 * text, not a close tag — parsing it as markup would let content escape the region
 * that was supposed to swallow it.
 *
 * @param input - the HTML source
 * @param profile - the active vocabulary; a node it declares by name is never
 *   treated as an HTML raw-text element, even when an HTML element shares the name
 */
export function htmlToTree(input: string, profile?: FormatProfile): FragmentTree {
	const tokens = tokenize(input);
	const root: FragmentElement = { kind: "element", name: "#root", props: {}, children: [] };
	const stack: FragmentElement[] = [root];
	let skipUntil = "";
	let skipIsRawText = false;

	const htmlRulesApply = (rawName: string): boolean => {
		if (!profile) return true;
		return speaksHtml(profile) && !anyVocabularyDeclares(profile, rawName);
	};

	for (let idx = 0; idx < tokens.length; idx++) {
		const token = tokens[idx];
		const parent = stack[stack.length - 1];

		if (skipUntil) {
			if (token.type === "close" && token.tag === skipUntil) {
				skipUntil = "";
				continue;
			}
			// A stripped element that never closes must not eat the rest of the
			// document: an ancestor's close tag implicitly closes it. The stripped
			// element was never pushed, so anything still on the stack is an
			// ancestor. Raw-text elements keep skipping, matching the parser.
			const ancestorCloses =
				token.type === "close"
				&& !skipIsRawText
				&& stack.some((element) => element.name.toLowerCase() === token.tag);
			if (!ancestorCloses) continue;
			skipUntil = "";
		}

		switch (token.type) {
			case "text":
				parent.children.push({ kind: "text", value: token.value });
				break;

			case "comment":
				break;

			case "open": {
				const element: FragmentElement = {
					kind: "element",
					name: token.rawTag,
					props: attributesToProps(token.attributes),
					children: [],
				};
				if (token.selfClosing && !VOID_ELEMENTS.has(token.tag)) element.selfClosing = true;
				parent.children.push(element);

				const rawText = htmlRulesApply(token.rawTag)
					&& (token.tag === "style" || STRIPPED_ELEMENTS.has(token.tag))
					&& !(SVG_TEXT_ELEMENTS.has(token.tag) && insideSvg(stack));

				if (rawText) {
					if (token.tag === "style") {
						const cleaned = sanitizeStyleBlock(collectStyleContent(tokens, idx));
						if (cleaned) element.children.push({ kind: "text", value: cleaned });
					}
					if (!token.selfClosing && !VOID_ELEMENTS.has(token.tag)) {
						skipUntil = token.tag;
						skipIsRawText = RAWTEXT_ELEMENTS.has(token.tag);
					}
					break;
				}

				if (token.selfClosing || VOID_ELEMENTS.has(token.tag)) break;
				stack.push(element);
				break;
			}

			case "close": {
				if (VOID_ELEMENTS.has(token.tag)) break;
				let depth = stack.length - 1;
				while (depth > 0 && stack[depth].name.toLowerCase() !== token.tag) depth--;
				if (depth > 0) stack.length = depth;
				break;
			}
		}
	}

	return root.children;
}

/**
 * Whether an open `<svg>` encloses the insertion point. Inside SVG the HTML parser
 * reads `<title>` as a foreign element with ordinary content, not as the document
 * title's raw-text region.
 */
function insideSvg(stack: FragmentElement[]): boolean {
	return stack.some((element) => element.name.toLowerCase() === "svg");
}

/**
 * A repeated attribute name resolves to its first occurrence: the parser discards
 * a duplicate rather than overwriting the one already collected. Taking the last
 * would disagree with what a browser reads out of the same source, so a value the
 * browser never honours could be the one that gets validated.
 */
function attributesToProps(attributes: Attribute[]): Record<string, PropValue> {
	const props: Record<string, PropValue> = {};
	for (const attr of attributes) {
		if (Object.hasOwn(props, attr.name)) continue;
		setProp(props, attr.name, attr.value === "" ? true : attr.value);
	}
	return props;
}
