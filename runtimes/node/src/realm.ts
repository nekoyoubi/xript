import vm from "node:vm";

/**
 * Context-side helpers, evaluated once inside the sandbox realm. Everything a value needs in
 * order to be re-created in that realm (objects, arrays, errors, promises, wrappers around host
 * functions) is built by these, so it carries the context's prototypes and the context's
 * `Function`, which refuses to compile strings.
 */
const REALM_SOURCE = `"use strict";
(function () {
	var defineProperty = Object.defineProperty;
	var freeze = Object.freeze;
	var setPrototypeOf = Object.setPrototypeOf;
	var errorCtors = {
		Error: Error, TypeError: TypeError, RangeError: RangeError, SyntaxError: SyntaxError,
		ReferenceError: ReferenceError, EvalError: EvalError, URIError: URIError,
	};
	function isForeign(value) {
		return value !== null && (typeof value === "object" || typeof value === "function") && !(value instanceof Object);
	}
	function sanitize(error) {
		if (!isForeign(error)) return error;
		var message = "";
		try { message = String(error.message); } catch (e) {}
		return new Error(message);
	}
	return {
		Function: Function,
		Object: Object,
		Promise: Promise,
		object: function () { return {}; },
		array: function () { return []; },
		define: function (target, key, value) {
			defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
		},
		freeze: function (target) { return freeze(target); },
		date: function (time) { return new Date(time); },
		regexp: function (source, flags) { return new RegExp(source, flags); },
		map: function () { return new Map(); },
		mapSet: function (map, key, value) { map.set(key, value); },
		set: function () { return new Set(); },
		setAdd: function (set, value) { set.add(value); },
		typed: function (kind, bytes) {
			var ctor = globalThis[kind];
			var buffer = new ArrayBuffer(bytes.length);
			new Uint8Array(buffer).set(bytes);
			return kind === "ArrayBuffer" ? buffer : kind === "DataView" ? new DataView(buffer) : new ctor(buffer);
		},
		promise: function (executor) { return new Promise(executor); },
		error: function (kind, ctorName, message) {
			var ctor = errorCtors[ctorName] || Error;
			var error = new ctor(message);
			var custom = globalThis[kind];
			if (typeof custom === "function" && custom.prototype instanceof Error) setPrototypeOf(error, custom.prototype);
			if (kind !== ctorName) defineProperty(error, "name", { value: kind, writable: true, enumerable: false, configurable: true });
			return error;
		},
		wrap: function (invoke, name) {
			var wrapped = function () {
				var outcome;
				try {
					outcome = invoke(this, arguments);
				} catch (error) {
					throw sanitize(error);
				}
				if (outcome[0]) return outcome[1];
				throw outcome[1];
			};
			defineProperty(wrapped, "name", { value: name, configurable: true });
			return wrapped;
		},
	};
})()`;

interface RealmHelpers {
	Function: FunctionConstructor;
	Object: ObjectConstructor;
	Promise: PromiseConstructor;
	object(): Record<string, unknown>;
	array(): unknown[];
	define(target: object, key: string, value: unknown): void;
	freeze<T>(target: T): T;
	date(time: number): Date;
	regexp(source: string, flags: string): RegExp;
	map(): Map<unknown, unknown>;
	mapSet(map: Map<unknown, unknown>, key: unknown, value: unknown): void;
	set(): Set<unknown>;
	setAdd(set: Set<unknown>, value: unknown): void;
	typed(kind: string, bytes: Uint8Array): unknown;
	promise(executor: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => void): Promise<unknown>;
	error(kind: string, ctorName: string, message: string): Error;
	wrap(invoke: (self: unknown, args: ArrayLike<unknown>) => [boolean, unknown], name: string): (...args: unknown[]) => unknown;
}

const BUILTIN_ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]);

/**
 * Re-creates host values in a `vm` context's realm. A `vm` context shares the host's engine,
 * so a host-realm object handed to a script is a step from the host's `Function` (through
 * `.constructor`), and the context's `codeGeneration` setting governs only the context's own
 * `Function`. Every value crossing host to sandbox therefore goes through `toContext`: data is
 * copied into context-realm objects, errors become context-realm errors, promises become
 * context-realm promises, and host functions become context-realm wrappers whose arguments
 * stay as the script passed them and whose results and throws are re-created in turn.
 */
export class RealmBridge {
	private readonly helpers: RealmHelpers;
	private readonly wrappers = new WeakMap<object, unknown>();

	constructor(context: vm.Context) {
		this.helpers = vm.runInContext(REALM_SOURCE, context, { filename: "xript-realm.js" }) as RealmHelpers;
	}

	/** Whether `value` already belongs to the context realm. */
	private isContextValue(value: object): boolean {
		return typeof value === "function" ? value instanceof this.helpers.Function : value instanceof this.helpers.Object;
	}

	toContext(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
		if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
		const source = value as object;
		const prior = seen.get(source);
		if (prior !== undefined) return prior;

		if (typeof value === "function") {
			if (this.isContextValue(source)) return value;
			return this.wrapFunction(value as (...args: unknown[]) => unknown);
		}

		if (this.isContextValue(source)) return this.reconcileContextValue(source, seen);
		return this.copyHostValue(source, seen);
	}

	/** Wraps a host function in a context-realm function; the same host function always gets the same wrapper. */
	wrapFunction(fn: (...args: unknown[]) => unknown, name = fn.name): unknown {
		const existing = this.wrappers.get(fn);
		if (existing) return existing;
		const invoke = (self: unknown, args: ArrayLike<unknown>): [boolean, unknown] => {
			try {
				return [true, this.toContext(Reflect.apply(fn, self, Array.prototype.slice.call(args)))];
			} catch (error) {
				return [false, this.toContextError(error)];
			}
		};
		const wrapped = this.helpers.wrap(invoke, name);
		this.wrappers.set(fn, wrapped);
		return wrapped;
	}

	/**
	 * Copies the plain data in a value leaving the sandbox (context-realm objects and arrays)
	 * into host-realm objects and arrays, so a host reads ordinary values. Functions, class
	 * instances, and host values pass through unchanged.
	 */
	toHost(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
		// A script function carries no data across to the host, and handing one over would let
		// the host call sandbox code outside the execution budget. It marshals to null at the top
		// level and as an array element, and is omitted as an object property below, matching what
		// JSON serialization produces and what the other runtimes already do.
		if (typeof value === "function") return null;
		if (value === null || typeof value !== "object") return value;
		const prior = seen.get(value);
		if (prior !== undefined) return prior;
		if (value instanceof this.helpers.Promise) {
			const hostPromise = Promise.resolve(value as PromiseLike<unknown>).then((settled) => this.toHost(settled));
			// A host that ignores the returned promise must not crash the process: this promise is
			// the runtime's own wrapper around a sandbox result, so attach a terminal handler that
			// keeps its rejection from floating while leaving the host free to await it and observe
			// the rejection through its own reaction.
			hostPromise.catch(() => {});
			return hostPromise;
		}
		const isArray = Array.isArray(value);
		const proto = Object.getPrototypeOf(value);
		if (!isArray && proto !== this.helpers.Object.prototype && proto !== null) return value;
		if (!isArray && !this.isContextValue(value) && proto !== null) return value;
		const copy: Record<string, unknown> | unknown[] = isArray ? [] : proto === null ? Object.create(null) : {};
		seen.set(value, copy);
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!isArray && typeof record[key] === "function") continue;
			Object.defineProperty(copy, key, { value: this.toHost(record[key], seen), writable: true, enumerable: true, configurable: true });
		}
		return copy;
	}

	/** Re-creates a thrown value in the context realm; a context-realm value passes through. */
	toContextError(error: unknown): unknown {
		if (error === null || (typeof error !== "object" && typeof error !== "function")) return error;
		if (this.isContextValue(error as object)) return error;
		if (!(error instanceof Error)) return this.toContext(error);

		const name = typeof error.name === "string" ? error.name : "Error";
		const ctorName = BUILTIN_ERRORS.has(name) ? name : error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : "Error";
		const copy = this.helpers.error(name, ctorName, String(error.message));
		for (const key of Object.keys(error)) {
			if (key === "name" || key === "message" || key === "stack") continue;
			this.helpers.define(copy, key, this.toContext((error as unknown as Record<string, unknown>)[key]));
		}
		return copy;
	}

	/**
	 * A context-realm container may still hold host values a host planted in it; the container
	 * is kept when nothing inside needs re-creating, and copied when something does.
	 */
	private reconcileContextValue(source: object, seen: Map<object, unknown>): unknown {
		if (!Array.isArray(source) && Object.getPrototypeOf(source) !== this.helpers.Object.prototype) return source;
		seen.set(source, source);
		const record = source as Record<string, unknown>;
		let copy: Record<string, unknown> | unknown[] | null = null;
		for (const key of Object.keys(record)) {
			const original = record[key];
			const converted = this.toContext(original, seen);
			if (converted !== original) {
				if (!copy) {
					copy = Array.isArray(source) ? this.helpers.array() : this.helpers.object();
					for (const earlier of Object.keys(record)) {
						if (earlier === key) break;
						this.helpers.define(copy, earlier, record[earlier]);
					}
					seen.set(source, copy);
				}
			}
			if (copy) this.helpers.define(copy, key, converted);
		}
		return copy ?? source;
	}

	private copyHostValue(source: object, seen: Map<object, unknown>): unknown {
		const helpers = this.helpers;

		if (source instanceof Error) {
			const copy = this.toContextError(source);
			seen.set(source, copy);
			return copy;
		}
		if (source instanceof Date) return helpers.date(source.getTime());
		if (source instanceof RegExp) return helpers.regexp(source.source, source.flags);
		if (typeof (source as { then?: unknown }).then === "function") {
			const thenable = source as PromiseLike<unknown>;
			return helpers.promise((resolve, reject) => {
				thenable.then(
					(value) => resolve(this.toContext(value)),
					(error) => reject(this.toContextError(error)),
				);
			});
		}
		if (source instanceof ArrayBuffer) return helpers.typed("ArrayBuffer", new Uint8Array(source.slice(0)));
		if (ArrayBuffer.isView(source)) {
			const bytes = new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
			return helpers.typed(source.constructor.name, bytes);
		}
		if (source instanceof Map) {
			const copy = helpers.map();
			seen.set(source, copy);
			for (const [key, value] of source) helpers.mapSet(copy, this.toContext(key, seen), this.toContext(value, seen));
			return copy;
		}
		if (source instanceof Set) {
			const copy = helpers.set();
			seen.set(source, copy);
			for (const value of source) helpers.setAdd(copy, this.toContext(value, seen));
			return copy;
		}

		const copy = Array.isArray(source) ? helpers.array() : helpers.object();
		seen.set(source, copy);
		const record = source as Record<string, unknown>;
		for (const key of Object.keys(record)) helpers.define(copy, key, this.toContext(record[key], seen));
		return Object.isFrozen(source) ? helpers.freeze(copy) : copy;
	}
}
