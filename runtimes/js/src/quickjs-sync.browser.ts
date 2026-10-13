import RELEASE_SYNC_DEFAULT from "@jitl/quickjs-singlefile-browser-release-sync";
import type { QuickJSSyncVariant } from "quickjs-emscripten-core";
import { makeSyncLoader } from "./quickjs-loader.js";

export type { SyncVariant } from "./quickjs-loader.js";
export { QUICKJS_CORE_VERSION, QuickJSVariantMismatchError } from "./quickjs-loader.js";

/**
 * The default sync variant in a browser: the release build with its WASM inlined, so no bundler or
 * dev server has to serve a sibling `.wasm` asset.
 */
export const RELEASE_SYNC: QuickJSSyncVariant = RELEASE_SYNC_DEFAULT;

/**
 * Loads (and memoizes) the sync QuickJS WASM module for a variant.
 *
 * @param variant - A `@jitl/quickjs-*-sync` variant; defaults to {@link RELEASE_SYNC}.
 * @returns The instantiated module, shared across calls for the same variant.
 */
export const loadSync = makeSyncLoader(RELEASE_SYNC);
