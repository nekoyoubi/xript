import { CallbackError, CrossingRefusal, MAX_CROSSING_DEPTH, TOO_DEEP_MESSAGE } from "./errors.js";
import type { CallerContext } from "./caller-context.js";
import type { DeclaredTypes, RetainedCallback, RetainedRegistry, RetainPositions } from "./retained.js";

/** A parameter the manifest declares as a function, checked before the host runs. */
export interface FunctionParamCheck {
	index: number;
	name: string;
	optional: boolean;
}

interface DeclaredParam {
	name: string;
	type: unknown;
	default?: unknown;
	required?: boolean;
	optional?: boolean;
}

function isFunctionTypeRef(type: unknown): boolean {
	if (type === "function") return true;
	return typeof type === "object" && type !== null && !Array.isArray(type) && "function" in type;
}

/**
 * The parameters a binding declares as `function` (bare, with a signature, or wrapped in
 * `optional`), in the order the runtime checks them.
 */
export function functionParamChecks(params: DeclaredParam[] | undefined): FunctionParamCheck[] {
	if (!params) return [];
	const checks: FunctionParamCheck[] = [];
	params.forEach((param, index) => {
		const type = param.type;
		const wrapped =
			typeof type === "object" && type !== null && "optional" in type
				? (type as { optional: unknown }).optional
				: undefined;
		if (isFunctionTypeRef(type)) {
			checks.push({ index, name: param.name, optional: param.required === false || param.optional === true || param.default !== undefined });
		} else if (wrapped !== undefined && isFunctionTypeRef(wrapped)) {
			checks.push({ index, name: param.name, optional: true });
		}
	});
	return checks;
}

function typeOfArg(value: unknown): string {
	return value === null ? "null" : typeof value;
}

/** The refusal message for a declared function parameter that received something else. */
export function functionParamViolation(binding: string, checks: FunctionParamCheck[], args: unknown[]): string | null {
	for (const check of checks) {
		const seen = typeOfArg(args[check.index]);
		if (seen === "function") continue;
		if (check.optional && (seen === "undefined" || seen === "null")) continue;
		return `${binding}(): parameter "${check.name}" expects a function, got ${seen}`;
	}
	return null;
}

/**
 * The sandbox's callback state: how many callbacks are running (an async binding refuses to
 * start inside one), the binding calls running synchronously right now (innermost last), and
 * what retaining needs.
 */
export interface CallbackTracker {
	depth: number;
	/** Binding calls whose host function is running right now; a retained call inside one is re-entrant. */
	scopes: CallbackScope[];
	/** Re-creates a host value in the sandbox realm before a callback receives it. */
	toContext?: (value: unknown) => unknown;
	/** Copies a callback's return value out of the sandbox realm for the host. */
	toHost?: (value: unknown) => unknown;
	retained?: RetainedRegistry;
	caller?: CallerContext;
	/** The manifest's declared types, which retain positions are found through. */
	types?: DeclaredTypes;
}

interface ScopedProxy {
	scope: CallbackScope;
	fn: ScriptFunction;
}

const scopedProxies = new WeakMap<object, ScopedProxy>();

/**
 * What a callback proxy crossing back into the sandbox becomes: the script's own function while
 * its binding call is still running in the runtime `tracker` belongs to, otherwise `undefined`.
 * Returns null for a function that is no callback proxy.
 */
export function resolveScopedProxy(fn: object, tracker: CallbackTracker): { value: unknown } | null {
	const proxy = scopedProxies.get(fn);
	if (!proxy) return null;
	return { value: proxy.scope.isActiveIn(tracker) ? proxy.fn : undefined };
}

/** A callback as the host receives it: the proxy function, plus `retain()`. */
export type HostCallback = ((...args: unknown[]) => unknown) & { retain(): RetainedCallback };

export function isThenable(value: unknown): boolean {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	return typeof (value as { then?: unknown }).then === "function";
}

/** The name and message of a value a script threw. */
export function describeThrown(e: unknown): { name?: string; message?: string } {
	return e !== null && typeof e === "object"
		? { name: (e as { name?: string }).name, message: (e as { message?: string }).message }
		: { message: String(e) };
}

type ScriptFunction = (...args: unknown[]) => unknown;

function put(target: object, key: string | number, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * One binding call's callbacks. Script functions anywhere in the arguments are swapped for
 * proxies that are valid only while the scope is open; containers holding one are copied so
 * the host never receives the script's own function. Each proxy remembers whether it was
 * found at a position the manifest marks `retain`.
 */
export class CallbackScope {
	private active = true;
	private readonly thrown = new Map<CallbackError, unknown>();

	constructor(
		readonly binding: string,
		private readonly tracker: CallbackTracker,
		private readonly retainable: RetainPositions = () => false,
	) {}

	/**
	 * Swaps every script function in the arguments for a proxy. Each property is read once; a
	 * getter that throws ends the call with its own error, and a value nested past
	 * `MAX_CROSSING_DEPTH` is refused with a `CrossingRefusal`.
	 */
	wrapArgs(args: unknown[]): unknown[] {
		const seen = new Set<object>();
		return args.map((arg, index) => this.wrap(arg, seen, [index]));
	}

	private wrap(value: unknown, seen: Set<object>, path: (string | number)[]): unknown {
		if (typeof value === "function") {
			return this.proxy(value as ScriptFunction, this.retainable(path));
		}
		if (value === null || typeof value !== "object") return value;
		if (seen.has(value) || ArrayBuffer.isView(value)) return value;
		if (seen.size >= MAX_CROSSING_DEPTH) throw new CrossingRefusal(TOO_DEEP_MESSAGE);
		seen.add(value);
		try {
			const array = Array.isArray(value);
			const record = value as Record<string, unknown>;
			const keys = array ? null : Object.keys(record);
			const length = array ? (value as unknown[]).length : (keys as string[]).length;
			const read: unknown[] = [];
			let copy: Record<string, unknown> | unknown[] | null = null;
			for (let i = 0; i < length; i++) {
				const key = array ? i : (keys as string[])[i];
				const original = record[key as string];
				read.push(original);
				const wrapped = this.wrap(original, seen, [...path, key]);
				if (Object.is(wrapped, original)) {
					if (copy) put(copy, key, original);
					continue;
				}
				if (!copy) {
					copy = array ? [] : {};
					for (let j = 0; j < i; j++) put(copy, array ? j : (keys as string[])[j], read[j]);
				}
				put(copy, key, wrapped);
			}
			return copy ?? value;
		} finally {
			seen.delete(value);
		}
	}

	private proxy(fn: ScriptFunction, retainable: boolean): HostCallback {
		const scope = this;
		const callback = function xriptCallback(...args: unknown[]): unknown {
			if (!scope.active) throw new CallbackError(scope.binding, "expired");
			return scope.invoke(fn, args, scope.binding);
		};
		Object.defineProperty(callback, "retain", {
			value: function retain(): RetainedCallback {
				const registry = scope.tracker.retained;
				if (!scope.active || !registry) throw new CallbackError(scope.binding, "expired");
				return registry.retain(fn, scope.binding, scope.tracker.caller?.current() ?? null, retainable);
			},
		});
		scopedProxies.set(callback, { scope, fn });
		return callback as HostCallback;
	}

	/** Whether this binding call is still running in the runtime `tracker` belongs to. */
	isActiveIn(tracker: CallbackTracker): boolean {
		return this.active && this.tracker === tracker;
	}

	/**
	 * Re-creates `value` in the sandbox realm while this binding call is still open, so a
	 * callback of the call that comes back in it arrives as the script's own function.
	 */
	cross(value: unknown): unknown {
		const toContext = this.tracker.toContext;
		return toContext ? toContext(value) : value;
	}

	/**
	 * Runs a script function inside this binding call, on the calling script's budget. A throw
	 * is remembered so a host that lets it escape rethrows the script's own error.
	 */
	invoke(fn: ScriptFunction, args: unknown[], binding: string): unknown {
		this.tracker.depth++;
		let result: unknown;
		try {
			result = Reflect.apply(fn, undefined, args.map((arg) => this.cross(arg)));
		} catch (e) {
			const error = new CallbackError(binding, "threw", describeThrown(e));
			this.thrown.set(error, e);
			throw error;
		} finally {
			this.tracker.depth--;
		}
		let thenable: boolean;
		let crossed: unknown;
		try {
			thenable = isThenable(result);
			crossed = thenable || !this.tracker.toHost ? result : this.tracker.toHost(result);
		} catch (e) {
			if (e instanceof CrossingRefusal) throw e;
			const error = new CallbackError(binding, "threw", describeThrown(e));
			this.thrown.set(error, e);
			throw error;
		}
		if (thenable) throw new CallbackError(binding, "promise");
		return crossed;
	}

	/** The script's own error when the host let a callback's throw escape, else the host error. */
	original(hostError: unknown): { value: unknown } | null {
		if (hostError instanceof CallbackError && this.thrown.has(hostError)) return { value: this.thrown.get(hostError) };
		return null;
	}

	close(): void {
		this.active = false;
		this.thrown.clear();
	}
}
