import {
	createFragmentInstance,
	type FragmentInstance,
	type FragmentNode,
	type FragmentOptions,
	type FragmentUpdateResult,
	type PropValue,
} from "@xriptjs/runtime";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface LiveFragment {
	/** Binds `data` through the runtime and redraws `container` from the bound tree. */
	render(container: HTMLElement, data: Record<string, unknown>): FragmentUpdateResult;
}

/**
 * A demo host for one fragment. Every `data-bind`, `data-if`, `data-each`, and `{{ }}` is
 * resolved by the real runtime; this module only draws the tree it hands back, the way
 * `spec/renderers.md` says a renderer should: by walking the tree and hiding nodes by path,
 * never by evaluating an expression itself.
 */
export function createLiveFragment(
	source: string,
	format: string,
	bindings: string[] | Array<{ name: string; path: string }>,
	interpolate = false,
	host: Pick<FragmentOptions, "formats" | "vocabularies"> = {},
): LiveFragment {
	const instance: FragmentInstance = createFragmentInstance(
		{
			id: "demo",
			slot: "demo",
			format,
			source,
			inline: true,
			interpolate,
			bindings: bindings.map((binding) => (typeof binding === "string" ? { name: binding, path: binding } : binding)),
		},
		source,
		{ formats: host.formats, vocabularies: host.vocabularies },
	);

	return {
		render(container, data) {
			const result = instance.getContent(data);
			const hidden = result.conditions.filter((c) => !c.visible).map((c) => c.path.join("."));
			container.replaceChildren(...buildNodes(result.tree, [], hidden, null));
			return result;
		},
	};
}

function isHidden(path: number[], hidden: string[]): boolean {
	const key = path.join(".");
	return hidden.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

function attributeValue(value: PropValue): string | null {
	if (value === null || value === false) return null;
	if (value === true) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function buildNodes(
	nodes: FragmentNode[],
	parentPath: number[],
	hidden: string[],
	namespace: string | null,
): Node[] {
	return nodes.map((node, index) => {
		const path = [...parentPath, index];
		if (node.kind === "text") return document.createTextNode(node.value);

		const ns = node.name === "svg" ? SVG_NAMESPACE : namespace;
		const element = ns ? document.createElementNS(ns, node.name) : document.createElement(node.name);
		for (const [name, value] of Object.entries(node.props)) {
			const text = attributeValue(value);
			if (text !== null) element.setAttribute(name, text);
		}
		if (isHidden(path, hidden)) (element as HTMLElement).style.display = "none";
		element.append(...buildNodes(node.children, path, hidden, ns));
		return element;
	});
}
