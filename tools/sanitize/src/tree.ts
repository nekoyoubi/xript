import { stringify, type Node as J5mlNode, type JsonValue } from "@nxis/j5ml";
import { VOID_ELEMENTS, isValidAttributeName } from "./rules.js";
import type { TextSegment } from "./interpolate.js";

export type { TextSegment };

export type JsmlNode = JsmlElement | string;
export type JsmlElement = [string, ...JsmlChild[]];
export type JsmlChild = Record<string, unknown> | JsmlNode;

/**
 * A value a fragment node prop may carry. Arrays and objects are first-class:
 * component vocabularies routinely take structured props, and an HTML attribute
 * is only one of the places a prop value can land.
 */
export type PropValue =
	| string
	| number
	| boolean
	| null
	| PropValue[]
	| { [key: string]: PropValue };

export interface FragmentText {
	kind: "text";
	/**
	 * The authored source, escapes intact. Round-trips byte-exact through
	 * `nodeToHtml` / `nodeToJ5ml`. When `segments` is present this string is a
	 * serialization artifact, not a rendering: consumers render `segments`.
	 */
	value: string;
	/**
	 * Present iff the node opened at least one interpolation site under an
	 * `interpolate` fill. Absent — never empty — otherwise, so a non-interpolating
	 * fragment produces a tree byte-identical to one parsed without the mode.
	 */
	segments?: TextSegment[];
}

export interface FragmentElement {
	kind: "element";
	/** The node name, case preserved exactly as authored. */
	name: string;
	/** Declaration order preserved. A bare HTML attribute (`disabled`) carries `true`. */
	props: Record<string, PropValue>;
	children: FragmentNode[];
	/**
	 * Serialization hint: the source closed this node with `/>` even though it is not a
	 * void element (`<circle />`). Carries no semantics — it exists so the HTML
	 * projection can reproduce the source's syntax byte-for-byte.
	 */
	selfClosing?: boolean;
}

export type FragmentNode = FragmentElement | FragmentText;
export type FragmentTree = FragmentNode[];

/**
 * Prop names that would corrupt the prototype chain of the object the tree is
 * assembled into. Rejected in every vocabulary, declared or built-in.
 */
export const FORBIDDEN_PROP_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function isFragmentElement(node: FragmentNode): node is FragmentElement {
	return node.kind === "element";
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Escapes a value for placement inside a double-quoted attribute.
 *
 * Quoting alone would make the value inert — a double-quoted attribute does not
 * terminate until an unescaped `"`, and that character is escaped here. Angle
 * brackets and the single quote are escaped anyway so the serialized attribute
 * never carries a raw `<script>` substring: downstream consumers scan output for
 * markup-shaped text, and a value that reads as a tag defeats those checks even
 * when it cannot execute.
 */
export function escapeAttrValue(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Writes a prop without invoking a setter or the prototype chain, so a `__proto__`
 * key cannot mutate the target's prototype.
 */
export function setProp(target: Record<string, PropValue>, key: string, value: PropValue): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

/**
 * Deep-copies a value into the `PropValue` domain, dropping anything JSON cannot
 * express. Returns `undefined` when the value has no `PropValue` representation.
 */
export function toPropValue(value: unknown): PropValue | undefined {
	if (value === null) return null;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean") return value as PropValue;

	if (Array.isArray(value)) {
		const items: PropValue[] = [];
		for (const item of value) {
			const converted = toPropValue(item);
			if (converted !== undefined) items.push(converted);
		}
		return items;
	}

	if (isPlainObject(value)) {
		const result: Record<string, PropValue> = {};
		for (const key of Object.keys(value)) {
			if (FORBIDDEN_PROP_NAMES.has(key)) continue;
			const converted = toPropValue(value[key]);
			if (converted !== undefined) setProp(result, key, converted);
		}
		return result;
	}

	return undefined;
}

/**
 * JavaScript `String(value)` semantics over the `PropValue` domain, so an HTML
 * projection of a typed prop renders the same bytes on every runtime.
 *
 * Implemented structurally rather than by calling `String(value)`: a JSON object
 * may carry an own `toString` key that shadows `Object.prototype.toString` with a
 * non-callable value, which makes the built-in conversion throw.
 */
export function jsString(value: PropValue): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return value.map((item) => (item === null ? "" : jsString(item))).join(",");
	}
	return "[object Object]";
}

export function treeToHtml(tree: FragmentTree): string {
	return tree.map(nodeToHtml).join("");
}

function nodeToHtml(node: FragmentNode): string {
	if (node.kind === "text") return escapeHtml(node.value);

	const attrStr = Object.entries(node.props)
		.map(([key, val]) => {
			if (!isValidAttributeName(key)) return "";
			if (val === true) return ` ${key}`;
			if (val === false || val === null || val === undefined) return "";
			return ` ${key}="${escapeAttrValue(jsString(val))}"`;
		})
		.join("");

	if (VOID_ELEMENTS.has(node.name) || (node.selfClosing && node.children.length === 0)) {
		return `<${node.name}${attrStr} />`;
	}

	const childHtml = node.children.map(nodeToHtml).join("");
	return `<${node.name}${attrStr}>${childHtml}</${node.name}>`;
}

/**
 * Projects a fragment tree into J5ML array form.
 *
 * Serialization runs through `@nxis/j5ml` rather than emitting the arrays
 * directly, because J5ML normatively orders attribute names by Unicode code
 * point on serialization. That ordering is not a language's default string
 * comparison — JavaScript compares UTF-16 code units, which sorts names above
 * U+FFFF differently — so the rule is delegated to the implementation that owns
 * it instead of restated here.
 */
export function treeToJsml(tree: FragmentTree): JsmlNode[] {
	return tree.map((node) => JSON.parse(stringify(nodeToJ5ml(node))) as JsmlNode);
}

function nodeToJ5ml(node: FragmentNode): J5mlNode {
	if (node.kind === "text") return { text: node.value };
	return {
		name: node.name,
		attrs: node.props as Record<string, JsonValue>,
		children: node.children.map(nodeToJ5ml),
	};
}

export function jsmlToTree(nodes: JsmlNode[]): FragmentTree {
	const tree: FragmentTree = [];
	for (const node of nodes) {
		const converted = jsmlNodeToTree(node);
		if (converted) tree.push(converted);
	}
	return tree;
}

function jsmlNodeToTree(node: unknown): FragmentNode | null {
	if (typeof node === "string") return { kind: "text", value: node };
	if (!Array.isArray(node) || node.length === 0) return null;

	const name = node[0];
	if (typeof name !== "string") return null;

	const props: Record<string, PropValue> = {};
	let childStart = 1;

	if (node.length > 1 && isPlainObject(node[1])) {
		const raw = node[1] as Record<string, unknown>;
		for (const key of Object.keys(raw)) {
			const value = toPropValue(raw[key]);
			if (value !== undefined) setProp(props, key, value);
		}
		childStart = 2;
	}

	const children: FragmentNode[] = [];
	for (let i = childStart; i < node.length; i++) {
		const child = jsmlNodeToTree(node[i]);
		if (child) children.push(child);
	}

	return { kind: "element", name, props, children };
}
