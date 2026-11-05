import type { QuickJSContext, QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten-core";
import { CallbackError, RetainError } from "./errors.js";
import { installCrossing, readFromQuickJS, releaseCrossing } from "./crossing.js";
import { marshalArgsToQuickJS, safeDispose } from "./marshal.js";
import { assertUsable, containFault } from "./stack-guard.js";
import type { PathStep, RetainPositions } from "./retain-positions.js";
import { RetainedRegistry, type RetainedCallback, type RetainedOptions } from "./retained.js";
import { registerScopedCallback } from "./retained-handles.js";

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

const TRAMPOLINE_SOURCE = `(function () {
	return function (f, args) {
		var r = f.apply(undefined, args);
		if (r !== null && (typeof r === "object" || typeof r === "function") && typeof r.then === "function") return [1];
		return [0, r];
	};
})()`;


/** Sandbox-side helpers held by the host, out of reach of script code. */
export interface CallbackSupport {
	trampoline: QuickJSHandle;
	/** How many callbacks are running right now; an async binding refuses to start inside one. */
	depth: number;
	/** The binding calls running right now, innermost last; a retained callback called while one runs spends its budget. */
	scopes: CallbackScope[];
	/** The manifest's declared types, through which a retain field is reached. */
	types: Record<string, { fields?: Record<string, { type: unknown; retain?: boolean }> }> | undefined;
	/** The context's retained callbacks, once `configureCallbacks` has run. */
	retained: RetainedRegistry | null;
	/** Builds the errors a binding throws as instances of the sandbox's own error classes. */
	errors: QuickJSHandle | null;
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

/**
 * Installs the context's callback support with the manifest's declared types and its retained
 * callback registry. Must run before any binding is injected.
 */
export function configureCallbacks(
	context: Context,
	types: CallbackSupport["types"],
	retained: RetainedOptions,
): CallbackSupport {
	const support = callbackSupportFor(context);
	support.types = types;
	support.retained = new RetainedRegistry(context, support, retained);
	return support;
}

/** Releases the context's callback helpers; must run before the context is disposed. */
export function releaseCallbackSupport(context: Context): void {
	supportByContext.get(context)?.dispose();
	supportByContext.delete(context);
	releaseCrossing(context);
}

function installCallbackSupport(context: Context): CallbackSupport {
	installCrossing(context);
	const trampoline = context.unwrapResult(context.evalCode(TRAMPOLINE_SOURCE, "xript-callbacks.js"));
	const support: CallbackSupport = {
		trampoline,
		depth: 0,
		scopes: [],
		types: undefined,
		retained: null,
		errors: null,
		dispose() {
			support.retained?.dispose();
			if (trampoline.alive) trampoline.dispose();
			if (support.errors?.alive) support.errors.dispose();
		},
	};
	return support;
}

/**
 * Reads a script value the host receives as data: a result, a hook or event handler's return,
 * a callback's return. Functions carry nothing across; a top-level object gains the `name`,
 * `message`, and `stack` a dump gives it. The caller keeps ownership of `handle`.
 */
export function readResult(context: Context, handle: QuickJSHandle, copyNamed = true): unknown {
	return readFromQuickJS(context, handle, { copyNamed });
}

/** How one call into a script function ended. Error handles belong to the receiver. */
export type ScriptCallOutcome =
	| { kind: "returned"; value: unknown }
	| { kind: "promise" }
	| { kind: "limit"; error: QuickJSHandle }
	| { kind: "threw"; error: QuickJSHandle; info: { name?: string; message?: string } };

/** A budget interrupt ends the call as a limit stop; any other sandbox error is the script's own throw. */
function failedCall(context: Context, error: QuickJSHandle): ScriptCallOutcome {
	const dumped = context.dump(error) as { name?: string; message?: string } | string | undefined;
	const info = typeof dumped === "object" && dumped !== null ? dumped : { message: String(dumped) };
	if (typeof info.message === "string" && info.message.includes("interrupted")) {
		return { kind: "limit", error };
	}
	return { kind: "threw", error, info };
}

/** Calls a script function synchronously with host arguments, counting it as a running callback. */
export function callScriptFunction(
	context: Context,
	support: CallbackSupport,
	fn: QuickJSHandle,
	args: unknown[],
	binding: string,
): ScriptCallOutcome {
	assertUsable(context);
	const argsHandle = marshalArgsToQuickJS(context, args, binding);
	support.depth++;
	let result;
	try {
		result = context.callFunction(support.trampoline, context.undefined, fn, argsHandle);
	} catch (error) {
		throw containFault(context, error);
	} finally {
		support.depth--;
		safeDispose(context, argsHandle);
	}

	if (result.error) return failedCall(context, result.error);

	const outcome = result.value;
	try {
		const tag = context.getProp(outcome, 0);
		const settled = context.getNumber(tag);
		tag.dispose();
		if (settled === 1) return { kind: "promise" };
		const returned = context.getProp(outcome, 1);
		try {
			let stopped: QuickJSHandle | null = null;
			const value = readFromQuickJS(context, returned, { onStopped: (error) => (stopped = error) });
			if (stopped) return failedCall(context, stopped);
			return { kind: "returned", value };
		} finally {
			returned.dispose();
		}
	} finally {
		outcome.dispose();
	}
}

/** A callback proxy as the host receives it: callable, and retainable during its call. */
export type XriptCallback = ((...args: unknown[]) => unknown) & { retain(): RetainedCallback };

/**
 * One binding call's callbacks. Every proxy it hands out is valid only while the scope is
 * open; `close` expires them and releases the sandbox functions they point at. A proxy records
 * whether it was found at a retain position, which is the only place `retain()` may keep it.
 */
export class CallbackScope {
	private active = true;
	private readonly held: QuickJSHandle[] = [];
	private readonly thrown = new Map<CallbackError, QuickJSHandle>();
	private fatal: QuickJSHandle | null = null;

	constructor(
		private readonly context: Context,
		private readonly support: CallbackSupport,
		readonly binding: string,
		private readonly retainsAt: RetainPositions = () => false,
	) {}

	/** Marks this binding call as running, so a retained callback called now spends its budget. */
	enter(): void {
		this.support.scopes.push(this);
	}

	/** Marks this binding call as no longer running synchronously; its callbacks stay valid. */
	leave(): void {
		const index = this.support.scopes.lastIndexOf(this);
		if (index !== -1) this.support.scopes.splice(index, 1);
	}

	/** Converts the argument at `index`, replacing every script function inside it with a proxy. */
	unmarshal(handle: QuickJSHandle, index: number): unknown {
		return readFromQuickJS(this.context, handle, {
			path: [index],
			onFunction: (fn: QuickJSHandle, path: PathStep[]) => {
				this.held.push(fn);
				return this.proxy(fn, this.retainsAt(path));
			},
			onStopped: (error: QuickJSHandle) => {
				if (this.fatal) error.dispose();
				else this.fatal = error;
			},
		});
	}

	private proxy(fn: QuickJSHandle, retainable: boolean): XriptCallback {
		const scope = this;
		const callback = function xriptCallback(...args: unknown[]): unknown {
			return scope.invoke(fn, args);
		};
		Object.defineProperty(callback, "retain", {
			value: (): RetainedCallback => scope.retain(fn, retainable),
		});
		registerScopedCallback(callback, (context) =>
			scope.active && fn.alive && context === scope.context ? fn.dup() : undefined,
		);
		return callback as XriptCallback;
	}

	private retain(fn: QuickJSHandle, retainable: boolean): RetainedCallback {
		if (!this.active || !fn.alive) throw new CallbackError(this.binding, "expired");
		const registry = this.support.retained;
		if (!registry) throw new RetainError(this.binding, "undeclared");
		return registry.retain(fn, this.binding, retainable);
	}

	private invoke(fn: QuickJSHandle, args: unknown[]): unknown {
		if (!this.active || !fn.alive) {
			throw new CallbackError(this.binding, "expired");
		}
		return this.call(fn, args, this.binding);
	}

	/**
	 * Calls a script function inside this running binding call, on the calling script's budget:
	 * a budget stop ends the binding call, and a throw the host lets escape becomes the script's
	 * own error again. `binding` names the binding the function was passed to.
	 */
	call(fn: QuickJSHandle, args: unknown[], binding: string): unknown {
		if (this.fatal) {
			throw new CallbackError(binding, "limit");
		}
		const outcome = callScriptFunction(this.context, this.support, fn, args, binding);
		switch (outcome.kind) {
			case "returned":
				return outcome.value;
			case "promise":
				throw new CallbackError(binding, "promise");
			case "limit":
				this.fatal = outcome.error;
				throw new CallbackError(binding, "limit");
			case "threw": {
				const error = new CallbackError(binding, "threw", outcome.info);
				this.thrown.set(error, outcome.error);
				throw error;
			}
		}
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
		this.leave();
		this.active = false;
		for (const handle of this.held) if (handle.alive) handle.dispose();
		this.held.length = 0;
		for (const handle of this.thrown.values()) if (handle.alive) handle.dispose();
		this.thrown.clear();
		if (this.fatal?.alive) this.fatal.dispose();
		this.fatal = null;
	}
}
