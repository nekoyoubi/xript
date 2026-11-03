import type { CallerContext } from "./caller-context.js";

/** What a caller-aware binding learns about the call it is serving. */
export interface HostCallInfo {
	/** The calling mod's id, or `null` for code no mod owns. */
	modId: string | null;
	/** The binding's qualified name, `"save"` or `"world.getHealth"`. */
	binding: string;
}

/** A host binding that receives {@link HostCallInfo} ahead of the script's arguments. */
export type CallerAwareFunction = (info: HostCallInfo, ...args: any[]) => unknown;

const CALLER_AWARE = Symbol.for("xript.withCaller");

type Tagged = ((...args: any[]) => unknown) & { [CALLER_AWARE]?: CallerAwareFunction };

/**
 * Marks a host binding as caller-aware: the runtime calls `fn(info, ...args)`, where `info`
 * names the calling mod and the binding. Supply the result wherever a plain host function goes.
 * Called directly, outside a runtime, it reports a null caller and an empty binding name.
 */
export function withCaller(fn: CallerAwareFunction): (...args: any[]) => unknown {
	const plain: Tagged = (...args: unknown[]) => fn({ modId: null, binding: "" }, ...args);
	Object.defineProperty(plain, CALLER_AWARE, { value: fn });
	return plain;
}

type BindingTree = { [key: string]: unknown };

/**
 * Replaces every caller-aware function in a host binding tree with one that reads the caller
 * from `caller` at call time and knows its own qualified name. A namespace holding no
 * caller-aware function comes back as the same object.
 */
export function resolveCallerAware<T extends BindingTree>(bindings: T, caller: CallerContext, prefix = ""): T {
	if (bindings === null || typeof bindings !== "object") return bindings;
	let resolved: BindingTree | null = null;
	for (const name of Object.keys(bindings)) {
		const value = bindings[name];
		const qualified = prefix ? `${prefix}.${name}` : name;
		const aware = typeof value === "function" ? (value as Tagged)[CALLER_AWARE] : undefined;
		let next: unknown = value;
		if (aware) {
			next = (...args: unknown[]) => aware({ modId: caller.current(), binding: qualified }, ...args);
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			next = resolveCallerAware(value as BindingTree, caller, qualified);
		}
		if (next !== value) {
			resolved ??= { ...bindings };
			resolved[name] = next;
		}
	}
	return (resolved ?? bindings) as T;
}
