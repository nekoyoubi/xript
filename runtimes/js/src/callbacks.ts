import type { QuickJSContext, QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten-core";
import { CallbackError } from "./errors.js";
import { marshalToQuickJS, safeDispose } from "./marshal.js";

type Context = QuickJSContext | QuickJSAsyncContext;

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
			checks.push({ index, name: param.name, optional: param.required === false || param.default !== undefined });
		} else if (wrapped !== undefined && isFunctionTypeRef(wrapped)) {
			checks.push({ index, name: param.name, optional: true });
		}
	});
	return checks;
}

/** The refusal message for a declared function parameter that received something else. */
export function functionParamViolation(
	binding: string,
	checks: FunctionParamCheck[],
	typeOfArg: (index: number) => string,
): string | null {
	for (const check of checks) {
		const seen = typeOfArg(check.index);
		if (seen === "function") continue;
		if (check.optional && (seen === "undefined" || seen === "null")) continue;
		return `${binding}(): parameter "${check.name}" expects a function, got ${seen}`;
	}
	return null;
}

const COLLECTOR_SOURCE = `(function () {
	var stringify = JSON.stringify;
	return function (value, marker) {
		var fns = [];
		var json = stringify([value], function (key, v) {
			if (typeof v === "function") {
				var m = {};
				m[marker] = fns.length;
				fns[fns.length] = v;
				return m;
			}
			return v;
		});
		return [json, fns];
	};
})()`;

const TRAMPOLINE_SOURCE = `(function () {
	return function (f, args) {
		var r = f.apply(undefined, args);
		if (r !== null && (typeof r === "object" || typeof r === "function") && typeof r.then === "function") return [1];
		return [0, r];
	};
})()`;

/** Sandbox-side helpers held by the host, out of reach of script code. */
export interface CallbackSupport {
	collector: QuickJSHandle;
	trampoline: QuickJSHandle;
	marker: string;
	/** How many callbacks are running right now; an async binding refuses to start inside one. */
	depth: number;
	dispose(): void;
}

const supportByContext = new WeakMap<Context, CallbackSupport>();

/** The context's callback helpers, installed on first use and released by `releaseCallbackSupport`. */
export function callbackSupportFor(context: Context): CallbackSupport {
	let support = supportByContext.get(context);
	if (!support) {
		support = installCallbackSupport(context);
		supportByContext.set(context, support);
	}
	return support;
}

/** Releases the context's callback helpers; must run before the context is disposed. */
export function releaseCallbackSupport(context: Context): void {
	supportByContext.get(context)?.dispose();
	supportByContext.delete(context);
}

function installCallbackSupport(context: Context): CallbackSupport {
	const collector = context.unwrapResult(context.evalCode(COLLECTOR_SOURCE, "xript-callbacks.js"));
	const trampoline = context.unwrapResult(context.evalCode(TRAMPOLINE_SOURCE, "xript-callbacks.js"));
	const marker = `__xript_cb_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
	return {
		collector,
		trampoline,
		marker,
		depth: 0,
		dispose() {
			if (collector.alive) collector.dispose();
			if (trampoline.alive) trampoline.dispose();
		},
	};
}

/**
 * One binding call's callbacks. Every proxy it hands out is valid only while the scope is
 * open; `close` expires them and releases the sandbox functions they point at.
 */
export class CallbackScope {
	private active = true;
	private readonly retained: QuickJSHandle[] = [];
	private readonly thrown = new Map<CallbackError, QuickJSHandle>();
	private fatal: QuickJSHandle | null = null;

	constructor(
		private readonly context: Context,
		private readonly support: CallbackSupport,
		readonly binding: string,
	) {}

	/** Converts one argument handle, replacing every script function inside it with a proxy. */
	unmarshal(handle: QuickJSHandle): unknown {
		const kind = this.context.typeof(handle);
		if (kind === "function") {
			const fn = handle.dup();
			this.retained.push(fn);
			return this.proxy(fn);
		}
		if (kind !== "object") return this.context.dump(handle);

		const markerHandle = this.context.newString(this.support.marker);
		const collected = this.context.callFunction(this.support.collector, this.context.undefined, handle, markerHandle);
		markerHandle.dispose();
		if (collected.error) {
			collected.error.dispose();
			return this.context.dump(handle);
		}

		const pair = collected.value;
		try {
			const jsonHandle = this.context.getProp(pair, 0);
			const json = this.context.dump(jsonHandle);
			jsonHandle.dispose();
			if (typeof json !== "string") return this.context.dump(handle);

			const fnsHandle = this.context.getProp(pair, 1);
			const lengthHandle = this.context.getProp(fnsHandle, "length");
			const count = this.context.getNumber(lengthHandle);
			lengthHandle.dispose();
			if (count === 0) {
				fnsHandle.dispose();
				return (JSON.parse(json) as unknown[])[0];
			}

			const proxies: Array<(...args: unknown[]) => unknown> = [];
			for (let i = 0; i < count; i++) {
				const fn = this.context.getProp(fnsHandle, i);
				this.retained.push(fn);
				proxies.push(this.proxy(fn));
			}
			fnsHandle.dispose();

			const marker = this.support.marker;
			return (
				JSON.parse(json, (_key, value) => {
					if (value !== null && typeof value === "object" && !Array.isArray(value)) {
						const keys = Object.keys(value);
						if (keys.length === 1 && keys[0] === marker && typeof value[marker] === "number") {
							return proxies[value[marker]];
						}
					}
					return value;
				}) as unknown[]
			)[0];
		} finally {
			pair.dispose();
		}
	}

	private proxy(fn: QuickJSHandle): (...args: unknown[]) => unknown {
		const scope = this;
		return function xriptCallback(...args: unknown[]): unknown {
			return scope.invoke(fn, args);
		};
	}

	private invoke(fn: QuickJSHandle, args: unknown[]): unknown {
		if (!this.active || !fn.alive) {
			throw new CallbackError(this.binding, "expired");
		}
		if (this.fatal) {
			throw new CallbackError(this.binding, "limit");
		}

		const context = this.context;
		const argsHandle = marshalToQuickJS(context, args, this.binding);
		this.support.depth++;
		let result;
		try {
			result = context.callFunction(this.support.trampoline, context.undefined, fn, argsHandle);
		} finally {
			this.support.depth--;
			safeDispose(context, argsHandle);
		}

		if (result.error) {
			const dumped = context.dump(result.error) as { name?: string; message?: string } | string | undefined;
			const info = typeof dumped === "object" && dumped !== null ? dumped : { message: String(dumped) };
			if (typeof info.message === "string" && info.message.includes("interrupted")) {
				this.fatal = result.error;
				throw new CallbackError(this.binding, "limit");
			}
			const error = new CallbackError(this.binding, "threw", info);
			this.thrown.set(error, result.error);
			throw error;
		}

		const outcome = context.dump(result.value) as [number, unknown?];
		result.value.dispose();
		if (outcome[0] === 1) {
			throw new CallbackError(this.binding, "promise");
		}
		return outcome[1];
	}

	/**
	 * The sandbox exception a binding call must end with, if any: a budget stop from any
	 * callback (which the host may not swallow), else the original script error when the host
	 * let a callback's throw propagate. Ownership of the returned handle passes to the caller.
	 */
	takeOutcome(hostError: unknown): QuickJSHandle | null {
		if (this.fatal) {
			const fatal = this.fatal;
			this.fatal = null;
			return fatal;
		}
		if (hostError instanceof CallbackError) {
			const original = this.thrown.get(hostError);
			if (original) {
				this.thrown.delete(hostError);
				return original;
			}
		}
		return null;
	}

	close(): void {
		this.active = false;
		for (const handle of this.retained) if (handle.alive) handle.dispose();
		this.retained.length = 0;
		for (const handle of this.thrown.values()) if (handle.alive) handle.dispose();
		this.thrown.clear();
		if (this.fatal?.alive) this.fatal.dispose();
		this.fatal = null;
	}
}
