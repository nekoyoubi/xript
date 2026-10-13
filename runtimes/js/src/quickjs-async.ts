import RELEASE_ASYNC_DEFAULT from "@jitl/quickjs-wasmfile-release-asyncify";
import type { QuickJSAsyncVariant, QuickJSAsyncContext } from "quickjs-emscripten-core";
import { makeAsyncLoader, type AsyncVariant } from "./quickjs-loader.js";

export type { AsyncVariant } from "./quickjs-loader.js";
export { QUICKJS_CORE_VERSION, QuickJSVariantMismatchError } from "./quickjs-loader.js";

/** The default asyncify variant outside a browser: the release build with a sibling `.wasm` file. */
export const RELEASE_ASYNC: QuickJSAsyncVariant = RELEASE_ASYNC_DEFAULT;

/**
 * Loads the asyncify QuickJS WASM module for a variant.
 *
 * @param variant - A `@jitl/quickjs-*-asyncify` variant; defaults to {@link RELEASE_ASYNC}.
 */
export const loadAsync = makeAsyncLoader(RELEASE_ASYNC);

/**
 * Creates a fresh async context on its own WASM module instance.
 *
 * @param variant - A `@jitl/quickjs-*-asyncify` variant; defaults to {@link RELEASE_ASYNC}.
 */
export async function newAsyncContext(variant?: AsyncVariant): Promise<QuickJSAsyncContext> {
	const module = await loadAsync(variant);
	return module.newContext();
}
