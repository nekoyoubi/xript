/**
 * Build the host dispatch callback the Svelte renderer hands declared fragment
 * events to. This is the OUT seam: a user interaction in the rendered DOM is
 * turned into a sandbox call. Nothing the fragment authored executes in the
 * page — the renderer only knows the handler *name*, and the host decides it
 * maps to `runtime.invokeExport`.
 *
 * @param {{ invokeExport: (name: string, args: unknown[]) => unknown, fireFragmentHook: (id: string, lifecycle: string, bindings?: Record<string, unknown>) => unknown[] }} runtime
 * @returns {(detail: { handler: string, selector: string, on: string, event?: Event }) => unknown}
 */
export function makeDispatch(runtime) {
	return (detail) => runtime.invokeExport(detail.handler, []);
}
