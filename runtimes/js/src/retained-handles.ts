import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";

/**
 * Resolves a retained callback handle crossing back into a sandbox to a fresh handle on the
 * original script function, or throws the `CallbackError` that refuses it.
 */
export type RetainedResolver = (context: QuickJSContext) => QuickJSHandle;

const resolvers = new WeakMap<object, RetainedResolver>();

/** Records `handle` as a retained callback, so every runtime recognizes it when it crosses in. */
export function registerRetainedHandle(handle: object, resolver: RetainedResolver): void {
	resolvers.set(handle, resolver);
}

/** The resolver for `value` when it is a retained callback handle from any runtime. */
export function retainedResolverFor(value: unknown): RetainedResolver | undefined {
	if (value === null || typeof value !== "object") return undefined;
	return resolvers.get(value);
}
