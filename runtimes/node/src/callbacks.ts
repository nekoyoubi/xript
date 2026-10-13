import { CallbackError } from "./errors.js";

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

/** Counts callbacks running right now, so an async binding can refuse to start inside one. */
export interface CallbackTracker {
	depth: number;
	/** Re-creates a host value in the sandbox realm before a callback receives it. */
	toContext?: (value: unknown) => unknown;
	/** Copies a callback's return value out of the sandbox realm for the host. */
	toHost?: (value: unknown) => unknown;
}

function isThenable(value: unknown): boolean {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	return typeof (value as { then?: unknown }).then === "function";
}

/**
 * One binding call's callbacks. Script functions anywhere in the arguments are swapped for
 * proxies that are valid only while the scope is open; containers holding one are copied so
 * the host never receives the script's own function.
 */
export class CallbackScope {
	private active = true;
	private readonly thrown = new Map<CallbackError, unknown>();

	constructor(
		readonly binding: string,
		private readonly tracker: CallbackTracker,
	) {}

	wrapArgs(args: unknown[]): unknown[] {
		const seen = new Set<object>();
		return args.map((arg) => this.wrap(arg, seen));
	}

	private wrap(value: unknown, seen: Set<object>): unknown {
		if (typeof value === "function") return this.proxy(value as (...args: unknown[]) => unknown);
		if (value === null || typeof value !== "object") return value;
		if (seen.has(value) || ArrayBuffer.isView(value)) return value;
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				let copy: unknown[] | null = null;
				for (let i = 0; i < value.length; i++) {
					const wrapped = this.wrap(value[i], seen);
					if (wrapped !== value[i]) {
						copy ??= value.slice();
						copy[i] = wrapped;
					}
				}
				return copy ?? value;
			}
			let copy: Record<string, unknown> | null = null;
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				const original = record[key];
				const wrapped = this.wrap(original, seen);
				if (wrapped !== original) {
					copy ??= { ...record };
					copy[key] = wrapped;
				}
			}
			return copy ?? value;
		} finally {
			seen.delete(value);
		}
	}

	private proxy(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
		const scope = this;
		return function xriptCallback(...args: unknown[]): unknown {
			return scope.invoke(fn, args);
		};
	}

	private invoke(fn: (...args: unknown[]) => unknown, args: unknown[]): unknown {
		if (!this.active) throw new CallbackError(this.binding, "expired");
		this.tracker.depth++;
		let result: unknown;
		try {
			const toContext = this.tracker.toContext;
			result = Reflect.apply(fn, undefined, toContext ? args.map((arg) => toContext(arg)) : args);
		} catch (e) {
			const info =
				e !== null && typeof e === "object"
					? { name: (e as { name?: string }).name, message: (e as { message?: string }).message }
					: { message: String(e) };
			const error = new CallbackError(this.binding, "threw", info);
			this.thrown.set(error, e);
			throw error;
		} finally {
			this.tracker.depth--;
		}
		if (isThenable(result)) throw new CallbackError(this.binding, "promise");
		return this.tracker.toHost ? this.tracker.toHost(result) : result;
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
