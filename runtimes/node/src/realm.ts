import vm from "node:vm";
import { BindingError, CrossingRefusal, MAX_CROSSING_DEPTH, TOO_DEEP_MESSAGE } from "./errors.js";

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
	var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	var hasOwn = Object.prototype.hasOwnProperty;
	var apply = Reflect.apply;
	var ErrorCtor = Error;
	var StringOf = String;
	var DateCtor = Date;
	var RegExpCtor = RegExp;
	var MapCtor = Map;
	var SetCtor = Set;
	var PromiseCtor = Promise;
	var BufferCtor = ArrayBuffer;
	var BytesCtor = Uint8Array;
	var mapSet = Map.prototype.set;
	var setAdd = Set.prototype.add;
	var bytesSet = Object.getPrototypeOf(Uint8Array.prototype).set;
	var errorCtors = {
		Error: Error, TypeError: TypeError, RangeError: RangeError, SyntaxError: SyntaxError,
		ReferenceError: ReferenceError, EvalError: EvalError, URIError: URIError,
	};
	var viewCtors = {
		DataView: DataView, Int8Array: Int8Array, Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray,
		Int16Array: Int16Array, Uint16Array: Uint16Array, Int32Array: Int32Array, Uint32Array: Uint32Array,
		Float32Array: Float32Array, Float64Array: Float64Array,
		BigInt64Array: typeof BigInt64Array === "function" ? BigInt64Array : undefined,
		BigUint64Array: typeof BigUint64Array === "function" ? BigUint64Array : undefined,
	};
	function owned(table, key) {
		return apply(hasOwn, table, [key]) ? table[key] : undefined;
	}
	function isForeign(value) {
		return value !== null && (typeof value === "object" || typeof value === "function") && !(value instanceof Object);
	}
	function sanitize(error) {
		if (!isForeign(error)) return error;
		var message = "";
		try { message = StringOf(error.message); } catch (e) {}
		return new ErrorCtor(message);
	}
	return {
		Function: Function,
		Object: Object,
		Promise: PromiseCtor,
		object: function () { return {}; },
		array: function () { return []; },
		define: function (target, key, value) {
			defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
		},
		accessor: function (target, key, get, set) {
			defineProperty(target, key, { get: get, set: set, enumerable: true, configurable: false });
		},
		freeze: function (target) { return freeze(target); },
		date: function (time) { return new DateCtor(time); },
		regexp: function (source, flags) { return new RegExpCtor(source, flags); },
		map: function () { return new MapCtor(); },
		mapSet: function (map, key, value) { apply(mapSet, map, [key, value]); },
		set: function () { return new SetCtor(); },
		setAdd: function (set, value) { apply(setAdd, set, [value]); },
		typed: function (kind, bytes) {
			var buffer = new BufferCtor(bytes.length);
			apply(bytesSet, new BytesCtor(buffer), [bytes]);
			if (kind === "ArrayBuffer") return buffer;
			var ctor = owned(viewCtors, kind) || BytesCtor;
			return new ctor(buffer);
		},
		promise: function (executor) { return new PromiseCtor(executor); },
		error: function (kind, ctorName, message) {
			var ctor = owned(errorCtors, ctorName) || ErrorCtor;
			var error = new ctor(message);
			var found = getOwnPropertyDescriptor(globalThis, kind);
			var custom = found && !found.configurable && !found.writable ? found.value : undefined;
			if (typeof custom === "function" && custom.prototype instanceof ErrorCtor) setPrototypeOf(error, custom.prototype);
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
	accessor(target: object, key: string, get: unknown, set: unknown): void;
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

/**
 * A host-side placeholder for an accessor binding. Where one sits in a value crossing into the
 * sandbox, the context-realm copy gets a live accessor property in its place, whose getter and
 * setter wrap these host functions, instead of a snapshot of a value.
 */
export class LiveAccessor {
	constructor(
		readonly get: () => unknown,
		readonly set: (value: unknown) => void,
	) {}
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

	/**
	 * Maps a retained-callback handle crossing in back to the script function it stands for,
	 * returning `undefined` for anything that is not a handle (and throwing for one that may not
	 * cross here). Every other value is re-created by the ordinary rules.
	 */
	resolveRetained?: (value: object) => unknown;

	/**
	 * Maps a callback proxy crossing back in to the script function it stands for (or to
	 * `undefined` once its call is over), returning null for any other function.
	 */
	resolveScoped?: (fn: object) => { value: unknown } | null;

	constructor(context: vm.Context) {
		this.helpers = vm.runInContext(REALM_SOURCE, context, { filename: "xript-realm.js" }) as RealmHelpers;
	}

	/** Whether `value` already belongs to the context realm. */
	private isContextValue(value: object): boolean {
		return typeof value === "function" ? value instanceof this.helpers.Function : value instanceof this.helpers.Object;
	}

	toContext(value: unknown, seen: Map<object, unknown> = new Map(), depth = 0): unknown {
		if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
		const source = value as object;
		const prior = seen.get(source);
		if (prior !== undefined) return prior;

		if (this.resolveRetained && typeof value === "object") {
			const original = this.resolveRetained(source);
			if (original !== undefined) return original;
		}

		if (typeof value === "function") {
			if (this.isContextValue(source)) return value;
			const scoped = this.resolveScoped?.(source);
			if (scoped) return scoped.value;
			return this.wrapFunction(value as (...args: unknown[]) => unknown);
		}

		if (depth >= MAX_CROSSING_DEPTH) throw new CrossingRefusal(TOO_DEEP_MESSAGE);
		if (this.isContextValue(source)) return this.reconcileContextValue(source, seen, depth);
		return this.copyHostValue(source, seen, depth);
	}

	/** Wraps a host function in a context-realm function; the same host function always gets the same wrapper. */
	wrapFunction(fn: (...args: unknown[]) => unknown, name = fn.name): unknown {
		const existing = this.wrappers.get(fn);
		if (existing) return existing;
		const invoke = (self: unknown, args: ArrayLike<unknown>): [boolean, unknown] => {
			try {
				return [true, this.toContext(Reflect.apply(fn, self, Array.prototype.slice.call(args)))];
			} catch (error) {
				const failure = error instanceof CrossingRefusal && name ? new BindingError(name, error.message) : error;
				return [false, this.toContextError(failure)];
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
	toHost(value: unknown, seen: Map<object, unknown> = new Map(), depth = 0, key = "", applyToJSON = true): unknown {
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
		if (depth >= MAX_CROSSING_DEPTH) throw new CrossingRefusal(TOO_DEEP_MESSAGE);
		const record = value as Record<string, unknown>;
		if (applyToJSON) {
			const toJSON = record.toJSON;
			if (typeof toJSON === "function") {
				let replaced: unknown;
				let threw = false;
				try {
					replaced = Reflect.apply(toJSON, value, [key]);
				} catch {
					threw = true;
				}
				if (!threw) return this.toHost(replaced, seen, depth, key, false);
			}
		}
		const copy: Record<string, unknown> | unknown[] = isArray ? [] : proto === null ? Object.create(null) : {};
		seen.set(value, copy);
		if (isArray) {
			const length = (value as unknown[]).length;
			for (let i = 0; i < length; i++) {
				const item = (value as unknown[])[i];
				(copy as unknown[])[i] = typeof item === "symbol" ? null : this.toHost(item, seen, depth + 1, String(i));
			}
		} else {
			for (const name of Object.keys(record)) {
				const item = record[name];
				if (typeof item === "function" || typeof item === "symbol") continue;
				Object.defineProperty(copy, name, { value: this.toHost(item, seen, depth + 1, name), writable: true, enumerable: true, configurable: true });
			}
		}
		return copy;
	}

	/** Defines a live, non-configurable accessor property on a context-realm object. */
	defineAccessor(target: object, key: string, accessor: LiveAccessor): void {
		this.helpers.accessor(target, key, this.wrapFunction(accessor.get, "get"), this.wrapFunction(accessor.set, "set"));
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
	private reconcileContextValue(source: object, seen: Map<object, unknown>, depth: number): unknown {
		if (!Array.isArray(source) && Object.getPrototypeOf(source) !== this.helpers.Object.prototype) return source;
		seen.set(source, source);
		const record = source as Record<string, unknown>;
		let copy: Record<string, unknown> | unknown[] | null = null;
		const keys = Object.keys(record);
		const read: unknown[] = [];
		for (let i = 0; i < keys.length; i++) {
			const original = record[keys[i]];
			read.push(original);
			const converted = this.toContext(original, seen, depth + 1);
			if (!Object.is(converted, original) && !copy) {
				copy = Array.isArray(source) ? this.helpers.array() : this.helpers.object();
				for (let j = 0; j < i; j++) this.helpers.define(copy, keys[j], read[j]);
				seen.set(source, copy);
			}
			if (copy) this.helpers.define(copy, keys[i], converted);
		}
		return copy ?? source;
	}

	private copyHostValue(source: object, seen: Map<object, unknown>, depth: number): unknown {
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
			for (const [key, value] of source) helpers.mapSet(copy, this.toContext(key, seen, depth + 1), this.toContext(value, seen, depth + 1));
			return copy;
		}
		if (source instanceof Set) {
			const copy = helpers.set();
			seen.set(source, copy);
			for (const value of source) helpers.setAdd(copy, this.toContext(value, seen, depth + 1));
			return copy;
		}

		const copy = Array.isArray(source) ? helpers.array() : helpers.object();
		seen.set(source, copy);
		const record = source as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const value = record[key];
			if (value instanceof LiveAccessor) this.defineAccessor(copy, key, value);
			else helpers.define(copy, key, this.toContext(value, seen, depth + 1));
		}
		return Object.isFrozen(source) ? helpers.freeze(copy) : copy;
	}
}
