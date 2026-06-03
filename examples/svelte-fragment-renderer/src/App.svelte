<script>
	import Fragment from "./lib/Fragment.svelte";

	/**
	 * Example host wiring. The host owns the runtime (created in browser-side
	 * glue mirroring `src/host/host.js`) and re-derives fragment output whenever
	 * app state changes, then feeds the plain-data results to <Fragment>.
	 *
	 * @typedef {import("./lib/applyFragment.js").FragmentResult} FragmentResult
	 * @typedef {import("./lib/applyFragment.js").FragmentOp} FragmentOp
	 * @typedef {import("./lib/applyFragment.js").FragmentHandlerDeclaration} FragmentHandlerDeclaration
	 */

	let {
		/** @type {() => FragmentResult} */ updateBindings,
		/** @type {() => FragmentOp[]} */ fireFragmentHook,
		/** @type {FragmentHandlerDeclaration[]} */ handlers = [],
		/** @type {(detail: { handler: string, selector: string, on: string, event: Event }) => void} */ dispatch = () => {},
		/** @type {number} */ frame = 0,
	} = $props();

	let result = $derived.by(() => {
		void frame;
		return updateBindings();
	});
	let ops = $derived.by(() => {
		void frame;
		return fireFragmentHook();
	});
</script>

<main class="dashboard">
	<aside class="sidebar-left">
		<Fragment fragment={result} {ops} {handlers} {dispatch} />
	</aside>
</main>

<style>
	.dashboard {
		display: flex;
		font-family: system-ui, sans-serif;
	}
	.sidebar-left {
		width: 16rem;
		padding: 1rem;
	}
	:global(.xript-fragment [hidden]) {
		display: none;
	}
</style>
