import { newQuickJSWASMModuleFromVariant, newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import type {
	QuickJSSyncVariant,
	QuickJSAsyncVariant,
	QuickJSWASMModule,
	QuickJSAsyncWASMModule,
	QuickJSAsyncContext,
	QuickJSContext,
} from "quickjs-emscripten-core";

/**
 * The exact `quickjs-emscripten-core` version this runtime is built against. Every `@jitl/quickjs-*`
 * variant handed to the runtime must be published at this same version: the core and a variant's
 * FFI share an unversioned callback protocol, and a mismatched pair fails at the first host call.
 */
export const QUICKJS_CORE_VERSION = "0.31.0";

export type SyncVariant = QuickJSSyncVariant | Promise<QuickJSSyncVariant>;
export type AsyncVariant = QuickJSAsyncVariant | Promise<QuickJSAsyncVariant>;

/**
 * Thrown when a QuickJS variant cannot talk to the bundled `quickjs-emscripten-core`, almost always
 * because the two were installed at different versions.
 */
export class QuickJSVariantMismatchError extends Error {
	constructor(cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`the QuickJS variant is incompatible with quickjs-emscripten-core@${QUICKJS_CORE_VERSION}: ` +
				`a host function call across the FFI failed (${detail}). ` +
				`Install every @jitl/quickjs-* variant at exactly ${QUICKJS_CORE_VERSION}, the version this runtime pins.`,
		);
		this.name = "QuickJSVariantMismatchError";
	}
}

const verified = new WeakSet<object>();

/**
 * Round-trips one host function call through a fresh context. A core/variant version mismatch
 * surfaces here as an opaque callback-registry failure, so it is caught and rethrown with the
 * version rule attached instead of escaping from the first mod that calls a binding.
 */
function probeCallbacks(context: QuickJSContext | QuickJSAsyncContext): void {
	try {
		const fn = context.newFunction("__xript_probe", () => context.newNumber(2));
		context.setProp(context.global, "__xript_probe", fn);
		fn.dispose();
		const result = context.evalCode("__xript_probe() + 1");
		if (result.error) {
			const error = context.dump(result.error);
			result.error.dispose();
			throw new Error(typeof error === "object" && error && "message" in error ? String(error.message) : String(error));
		}
		const value = context.getNumber(result.value);
		result.value.dispose();
		if (value !== 3) throw new Error(`probe returned ${value}`);
	} catch (cause) {
		throw new QuickJSVariantMismatchError(cause);
	}
}

function verifyOnce(key: object, module: QuickJSWASMModule | QuickJSAsyncWASMModule): void {
	if (verified.has(key)) return;
	const context = module.newContext();
	try {
		probeCallbacks(context);
	} finally {
		context.dispose();
	}
	verified.add(key);
}

/**
 * Builds a memoized sync module loader whose default is `defaultVariant`. Each distinct variant is
 * instantiated once and checked against the core before it is handed out.
 */
export function makeSyncLoader(defaultVariant: SyncVariant): (variant?: SyncVariant) => Promise<QuickJSWASMModule> {
	const modules = new Map<SyncVariant, Promise<QuickJSWASMModule>>();
	return (variant = defaultVariant) => {
		let module = modules.get(variant);
		if (!module) {
			module = newQuickJSWASMModuleFromVariant(variant).then((loaded) => {
				verifyOnce(variant, loaded);
				return loaded;
			});
			module.catch(() => modules.delete(variant));
			modules.set(variant, module);
		}
		return module;
	};
}

/**
 * Builds an asyncify module loader whose default is `defaultVariant`. Every call instantiates a
 * fresh module, since an asyncify module can only suspend one context at a time; the core check
 * runs once per variant.
 */
export function makeAsyncLoader(
	defaultVariant: AsyncVariant,
): (variant?: AsyncVariant) => Promise<QuickJSAsyncWASMModule> {
	return async (variant = defaultVariant) => {
		const loaded = await newQuickJSAsyncWASMModuleFromVariant(variant);
		verifyOnce(variant, loaded);
		return loaded;
	};
}
