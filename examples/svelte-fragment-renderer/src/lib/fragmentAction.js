import { applyVisibility, applyOps, wireEvents } from "./applyFragment.js";

/**
 * Svelte action form of the fragment renderer, for hosts that prefer
 * `use:fragmentRenderer={...}` on an element they already own instead of the
 * `<Fragment>` component. Identical inert-fragment behavior: it injects the
 * runtime-sanitized html, applies visibility + the command buffer, and wires
 * declared events out to the host `dispatch` callback.
 *
 * @param {HTMLElement} node
 * @param {{ fragment: import("./applyFragment.js").FragmentResult, ops?: import("./applyFragment.js").FragmentOp[], events?: import("./applyFragment.js").FragmentEventDeclaration[], dispatch?: (detail: { handler: string, selector: string, on: string, event: Event }) => void }} params
 */
export function fragmentRenderer(node, params) {
	let teardown = () => {};

	function render(p) {
		node.innerHTML = p.fragment?.html ?? "";
		applyVisibility(node, p.fragment?.visibility ?? {});
		applyOps(node, p.ops ?? []);
		teardown();
		teardown = wireEvents(node, p.events ?? [], p.dispatch ?? (() => {}));
	}

	render(params);

	return {
		update(next) {
			render(next);
		},
		destroy() {
			teardown();
		},
	};
}
