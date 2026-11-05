import type { QuickJSAsyncContext, QuickJSContext } from "quickjs-emscripten-core";
import { NATIVE_STRINGIFY_DEPTH } from "./crossing.js";
import { EngineStackExhaustedError } from "./errors.js";

type Context = QuickJSContext | QuickJSAsyncContext;

/**
 * The engine's stack limit, in bytes, when the embedder sets no tighter one. QuickJS measures
 * its stack in WebAssembly linear memory, while the built-ins that recurse in C (`JSON.parse`,
 * `Array.prototype.join`) spend far more of the host engine's own stack per level than that
 * measure sees. Under the QuickJS default (256 KiB) a script can exhaust the host's stack before
 * QuickJS notices, which leaves the engine unusable; at this size every such recursion stops
 * with a catchable error first in the synchronous build, called from a shallow host stack.
 */
export const SAFE_STACK_BYTES = 128 * 1024;

/**
 * The same limit for the asyncify build. Asyncify instruments every engine function, and once
 * the host engine's optimizing compiler takes those functions over, each level costs more host
 * stack than in the synchronous build; at this size every recursion still stops with a
 * catchable error first under that compiler.
 */
export const SAFE_ASYNC_STACK_BYTES = 64 * 1024;

/**
 * The stack limit a runtime gets: the manifest's `max_stack_depth` (KiB) when tighter, else the
 * safe one for its build.
 */
export function stackLimitBytes(maxStackDepthKib: number | undefined, safeBytes = SAFE_STACK_BYTES): number {
	if (!maxStackDepthKib) return safeBytes;
	return Math.min(maxStackDepthKib * 1024, safeBytes);
}

/**
 * Replaces `JSON.stringify` and `JSON.parse` with ones that refuse nesting deeper than
 * `NATIVE_STRINGIFY_DEPTH` with the engine's own catchable stack-overflow error. QuickJS checks
 * its stack limit when one script function calls another; as `JSON.stringify` and `JSON.parse`
 * descend, it checks a measure that barely moves while each level spends real host stack, so
 * without this a deep enough value or text exhausts the host's stack. A replacer function and a
 * property-list replacer keep their meaning: the list is applied by copying each object's listed
 * properties once, in list order, which is what the engine reads.
 *
 * `JSON.parse` measures a text's nesting before the engine sees it, at native speed for any text
 * that could nest too deep: one pass drops string literals and everything else but brackets, a
 * few more drop innermost bracket pairs, and only a text still holding brackets after those is
 * walked bracket by bracket. The patterns carry their own `exec`, flags, and replace method, so
 * a script that rewrites `RegExp.prototype` cannot steer the measure.
 */
export const GUARDED_JSON_SOURCE = `(function () {
	var nativeStringify = JSON.stringify;
	var nativeParse = JSON.parse;
	var apply = Reflect.apply;
	var stringReplace = String.prototype.replace;
	var charCodeAt = String.prototype.charCodeAt;
	var regExpExec = RegExp.prototype.exec;
	var regExpReplace = RegExp.prototype[Symbol.replace];
	var replaceKey = Symbol.replace;
	var isArray = Array.isArray;
	var defineProperty = Object.defineProperty;
	var setProtoOf = Object.setPrototypeOf;
	var protoOf = Object.getPrototypeOf;
	var objectToString = Object.prototype.toString;
	function toTag(value) {
		return apply(objectToString, value, []);
	}
	var StringOf = String;
	var Overflow = typeof InternalError === "function" ? InternalError : RangeError;
	var LIMIT = ${NATIVE_STRINGIFY_DEPTH};
	var JSONObject = JSON;

	function list() {
		var made = [];
		setProtoOf(made, null);
		return made;
	}

	function propertyList(replacer) {
		var keys = list();
		var seen = Object.create(null);
		for (var i = 0; i < replacer.length; i++) {
			var item = replacer[i];
			var key;
			if (typeof item === "string") key = item;
			else if (typeof item === "number") key = StringOf(item);
			else if (item !== null && typeof item === "object") {
				var tag = toTag(item);
				if (tag !== "[object String]" && tag !== "[object Number]") continue;
				key = StringOf(item);
			} else continue;
			if (seen[key] === true) continue;
			seen[key] = true;
			keys[keys.length] = key;
		}
		return keys;
	}

	function picked(value, keys) {
		var copy = {};
		for (var i = 0; i < keys.length; i++) {
			defineProperty(copy, keys[i], { value: value[keys[i]], writable: true, enumerable: true, configurable: true });
		}
		return copy;
	}

	function isPlainContainer(item) {
		if (isArray(item)) return false;
		var tag = toTag(item);
		return tag !== "[object String]" && tag !== "[object Number]" && tag !== "[object Boolean]" && tag !== "[object BigInt]";
	}

	function stringify(value, replacer, space) {
		var user = typeof replacer === "function" ? replacer : null;
		var keys = user === null && isArray(replacer) ? propertyList(replacer) : null;
		var stack = list();
		var top = null;
		var opened = null;
		function guard(key, item) {
			if (this !== top) {
				top = this;
				if (top === opened) stack[stack.length] = top;
				else while (stack.length > 0 && stack[stack.length - 1] !== top) stack.length -= 1;
			}
			if (user !== null) item = apply(user, this, [key, item]);
			if (item !== null && typeof item === "object") {
				if (keys !== null && isPlainContainer(item)) item = picked(item, keys);
				if (stack.length >= LIMIT) throw new Overflow("stack overflow");
				opened = item;
			}
			return item;
		}
		return apply(nativeStringify, JSONObject, [value, guard, space]);
	}

	function fix(target, key, value) {
		defineProperty(target, key, { value: value, writable: false, enumerable: false, configurable: false });
	}

	function sealedPattern(pattern) {
		fix(pattern, "exec", regExpExec);
		fix(pattern, "flags", "g");
		fix(pattern, "global", true);
		fix(pattern, "unicode", false);
		fix(pattern, "unicodeSets", false);
		fix(pattern, "sticky", false);
		fix(pattern, replaceKey, regExpReplace);
		return pattern;
	}

	var NOT_STRUCTURE = sealedPattern(/"[^"\\\\]*(?:\\\\[\\s\\S][^"\\\\]*)*"|[^\\[\\]{}"]+/g);
	var INNERMOST_PAIRS = sealedPattern(/\\[\\]|\\{\\}/g);
	var NATIVE_PASSES = 8;

	function erase(text, pattern) {
		return apply(stringReplace, text, [pattern, ""]);
	}

	function nestsTooDeep(text) {
		if (text.length <= LIMIT) return false;
		var brackets = erase(text, NOT_STRUCTURE);
		var allowed = LIMIT;
		while (brackets.length > allowed && LIMIT - allowed < NATIVE_PASSES) {
			var inner = erase(brackets, INNERMOST_PAIRS);
			if (inner.length === brackets.length) break;
			brackets = inner;
			allowed -= 1;
		}
		if (brackets.length <= allowed) return false;
		var depth = 0;
		for (var i = 0; i < brackets.length; i++) {
			var code = apply(charCodeAt, brackets, [i]);
			if (code === 91 || code === 123) {
				if (++depth > allowed) return true;
			} else if ((code === 93 || code === 125) && depth > 0) depth -= 1;
		}
		return false;
	}

	function parse(text, reviver) {
		var source = StringOf(text);
		if (nestsTooDeep(source)) throw new Overflow("stack overflow");
		return apply(nativeParse, JSONObject, [source, reviver]);
	}

	defineProperty(stringify, "name", { value: "stringify", configurable: true });
	defineProperty(JSONObject, "stringify", { value: stringify, writable: true, enumerable: false, configurable: true });
	defineProperty(parse, "name", { value: "parse", configurable: true });
	defineProperty(JSONObject, "parse", { value: parse, writable: true, enumerable: false, configurable: true });
})()`;


/** Whether an engine fault has left a runtime unusable. One record per QuickJS runtime. */
interface FaultRecord {
	faulted: boolean;
}

const records = new WeakMap<object, FaultRecord>();

/** The fault record of a QuickJS runtime, created on first use. */
function recordOf(runtime: object): FaultRecord {
	let record = records.get(runtime);
	if (!record) {
		record = { faulted: false };
		records.set(runtime, record);
	}
	return record;
}

/**
 * Stands for "nothing was thrown". A catch block on a nearly full host stack runs out of stack
 * again if it calls anything, so every guard here only records what was thrown, sets its
 * record's flag with plain property writes and `instanceof` checks, and calls nothing until the
 * frames that failed have unwound.
 */
const NO_FAILURE = Symbol("no failure");

/**
 * Whether `error` is the host engine running out of stack, or the WebAssembly module trapping,
 * underneath a call into the sandbox. A script's own errors and a host binding's throws never
 * reach the host as either: the sandbox reports the first as values and the binding wrappers
 * turn the second into binding errors, so any `RangeError` that does is the stack running out.
 * One that unwound through the module may have left the engine half-way through an operation,
 * so the runtime is treated as unusable whichever frame it was raised in.
 */
export function isEngineFault(error: unknown): boolean {
	return error instanceof RangeError || (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError);
}

type HostCallback = (this: unknown, ...args: unknown[]) => unknown;

/**
 * The host function a script calls runs on the same nearly exhausted stack as the script, and
 * the engine glue around it swallows a throw it cannot report (logging it and handing the
 * engine an empty value), so a stack overflow there can leave the engine holding references it
 * will never release. Each host function the context creates records such an overflow, so the
 * runtime is retired rather than freed in an inconsistent state.
 */
export function guardHostCallbacks(context: Context): void {
	const record = recordOf(context.runtime);
	const wasmFault = typeof WebAssembly !== "undefined" ? WebAssembly.RuntimeError : RangeError;
	const newFunction = context.newFunction.bind(context);
	context.newFunction = ((name: string, fn: HostCallback) =>
		newFunction(name, function (this: unknown, ...args: unknown[]) {
			try {
				return Reflect.apply(fn, this, args);
			} catch (error) {
				if (error instanceof RangeError || error instanceof wasmFault) record.faulted = true;
				throw error;
			}
		} as never)) as typeof context.newFunction;
	const asyncContext = context as QuickJSAsyncContext;
	if (typeof asyncContext.newAsyncifiedFunction === "function") {
		const newAsyncified = asyncContext.newAsyncifiedFunction.bind(asyncContext);
		asyncContext.newAsyncifiedFunction = ((name: string, fn: HostCallback) =>
			newAsyncified(name, async function (this: unknown, ...args: unknown[]) {
				try {
					return await Reflect.apply(fn, this, args);
				} catch (error) {
					if (error instanceof RangeError || error instanceof wasmFault) record.faulted = true;
					throw error;
				}
			} as never)) as typeof asyncContext.newAsyncifiedFunction;
	}
}

/**
 * Wraps an engine callback (an interrupt check) of `runtime` so an overflow inside it retires the
 * runtime and answers `onFault`, instead of reaching engine glue that would swallow it.
 */
export function guardEngineCallback<T>(runtime: object, callback: () => T, onFault: T): () => T {
	const record = recordOf(runtime);
	return () => {
		try {
			return callback();
		} catch (error) {
			if (error instanceof RangeError) {
				record.faulted = true;
				return onFault;
			}
			throw error;
		}
	};
}

/** Marks the context unusable when `error` is an engine fault; returns the error the host should see. */
export function containFault(context: Context, error: unknown): unknown {
	if (!isEngineFault(error)) return error;
	recordOf(context.runtime).faulted = true;
	return new EngineStackExhaustedError();
}

/** Whether an engine fault has left this context unusable. */
export function isExhausted(context: Context): boolean {
	return recordOf(context.runtime).faulted;
}

/** Throws when an engine fault has left this context unusable. */
export function assertUsable(context: Context): void {
	if (isExhausted(context)) throw new EngineStackExhaustedError();
}

/**
 * Wraps every method of a sandbox surface so an engine fault anywhere under it leaves the
 * runtime refusing later calls with `EngineStackExhaustedError`, instead of running on a
 * corrupted engine. `dispose` is left to the caller, which skips freeing an exhausted engine.
 */
export function containSurface<T extends object>(context: Context, surface: T): T {
	const record = recordOf(context.runtime);
	const wasmFault = typeof WebAssembly !== "undefined" ? WebAssembly.RuntimeError : RangeError;
	const contained = { ...surface } as Record<string, unknown>;
	for (const [name, member] of Object.entries(surface)) {
		if (typeof member !== "function" || name === "dispose") continue;
		const method = member as (...args: unknown[]) => unknown;
		contained[name] = function (this: unknown, ...args: unknown[]): unknown {
			if (record.faulted) throw new EngineStackExhaustedError();
			let result: unknown;
			let failure: unknown = NO_FAILURE;
			try {
				result = Reflect.apply(method, this, args);
			} catch (error) {
				if (error instanceof RangeError || error instanceof wasmFault) record.faulted = true;
				failure = error;
			}
			if (record.faulted) throw new EngineStackExhaustedError();
			if (failure !== NO_FAILURE) throw failure;
			if (result instanceof Promise) {
				return result.catch((error: unknown) => {
					throw containFault(context, error);
				});
			}
			return result;
		};
	}
	return contained as T;
}
