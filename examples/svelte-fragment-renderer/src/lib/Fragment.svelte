<script>
	import { applyVisibility, applyOps, wireEvents } from "./applyFragment.js";

	/**
	 * @typedef {import("./applyFragment.js").FragmentResult} FragmentResult
	 * @typedef {import("./applyFragment.js").FragmentOp} FragmentOp
	 * @typedef {import("./applyFragment.js").FragmentEventDeclaration} FragmentEventDeclaration
	 */

	let {
		/** @type {FragmentResult} */ fragment,
		/** @type {FragmentOp[]} */ ops = [],
		/** @type {FragmentEventDeclaration[]} */ events = [],
		/** @type {(detail: { handler: string, selector: string, on: string, event: Event }) => void} */ dispatch = () => {},
	} = $props();

	/** @type {HTMLDivElement | undefined} */
	let container = $state();
	let teardown = () => {};

	$effect(() => {
		const root = container;
		if (!root) return;
		root.innerHTML = fragment?.html ?? "";
		applyVisibility(root, fragment?.visibility ?? {});
		applyOps(root, ops);
		teardown();
		teardown = wireEvents(root, events, dispatch);
		return () => {
			teardown();
			teardown = () => {};
		};
	});
</script>

<div class="xript-fragment" data-fragment-id={fragment?.fragmentId} bind:this={container}></div>
