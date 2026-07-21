import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import type { QuickJSSyncVariant, QuickJSWASMModule } from "quickjs-emscripten-core";

export type SyncVariant = QuickJSSyncVariant | Promise<QuickJSSyncVariant>;

const modules = new Map<SyncVariant, Promise<QuickJSWASMModule>>();

/**
 * Loads (and memoizes) the sync QuickJS WASM module for a variant.
 *
 * @param variant - A `@jitl/quickjs-wasmfile-*-sync` variant; defaults to the release build.
 * @returns The instantiated module, shared across calls for the same variant.
 */
export function loadSync(variant: SyncVariant = RELEASE_SYNC): Promise<QuickJSWASMModule> {
	let module = modules.get(variant);
	if (!module) {
		module = newQuickJSWASMModuleFromVariant(variant);
		modules.set(variant, module);
	}
	return module;
}

export { RELEASE_SYNC };
