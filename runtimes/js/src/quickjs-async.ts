import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import RELEASE_ASYNC from "@jitl/quickjs-wasmfile-release-asyncify";
import type { QuickJSAsyncVariant, QuickJSAsyncWASMModule, QuickJSAsyncContext } from "quickjs-emscripten-core";

export type AsyncVariant = QuickJSAsyncVariant | Promise<QuickJSAsyncVariant>;

/**
 * Loads the asyncify QuickJS WASM module for a variant.
 *
 * @param variant - A `@jitl/quickjs-wasmfile-*-asyncify` variant; defaults to the release build.
 */
export function loadAsync(variant: AsyncVariant = RELEASE_ASYNC): Promise<QuickJSAsyncWASMModule> {
	return newQuickJSAsyncWASMModuleFromVariant(variant);
}

/**
 * Creates a fresh async context on its own WASM module instance.
 *
 * @param variant - A `@jitl/quickjs-wasmfile-*-asyncify` variant; defaults to the release build.
 */
export async function newAsyncContext(variant?: AsyncVariant): Promise<QuickJSAsyncContext> {
	const module = await loadAsync(variant);
	return module.newContext();
}

export { RELEASE_ASYNC };
