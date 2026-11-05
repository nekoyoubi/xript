import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { cStringSafe, CrossingRefusal, InboundTape, MAX_CROSSING_DEPTH, parseIntoSandbox, TOO_DEEP_MESSAGE } from "./crossing.js";
import { BindingError } from "./errors.js";
import { retainedResolverFor, scopedResolverFor } from "./retained-handles.js";

function isThenable(value: unknown): boolean {
	if (value === null) return false;
	if (typeof value !== "object" && typeof value !== "function") return false;
	return typeof (value as { then?: unknown }).then === "function";
}

function isStaticHandle(context: QuickJSContext, handle: QuickJSHandle): boolean {
	return handle === context.undefined || handle === context.null || handle === context.true || handle === context.false;
}

export function safeDispose(context: QuickJSContext, handle: QuickJSHandle): void {
	if (!isStaticHandle(context, handle)) {
		handle.dispose();
	}
}

function promiseRefusal(bindingName: string): BindingError {
	return new BindingError(
		bindingName,
		"returned a promise, but the synchronous sandbox cannot await it. Declare the binding with \"async\": true in the manifest and create the runtime with initXriptAsync(), or return a plain value.",
	);
}

/**
 * Copies a host value into the sandbox. Primitives cross directly; anything with structure, a
 * BigInt, a symbol, or a string holding NUL, crosses as one tape built inside the sandbox (see
 * `crossingSource`). A cyclic value crosses with its cycles intact. A callback proxy whose
 * binding call is still running arrives as the script's own function; one whose call has ended,
 * one from another runtime, and any other host function arrive as `undefined`.
 */
export function marshalToQuickJS(context: QuickJSContext, value: unknown, bindingName = "host function"): QuickJSHandle {
	if (value === undefined) return context.undefined;
	if (value === null) return context.null;
	if (typeof value === "boolean") return value ? context.true : context.false;
	if (typeof value === "number") return context.newNumber(value);
	if (typeof value === "string" && cStringSafe(value)) return context.newString(value);

	const retained = retainedResolverFor(value);
	if (retained) return retained(context);
	if (typeof value === "function") return scopedFunction(context, value) ?? context.undefined;
	if (isThenable(value)) throw promiseRefusal(bindingName);
	if ((typeof value === "object" || typeof value === "string") && isJsonExact(value, new Set(), 0)) {
		return parseIntoSandbox(context, value);
	}

	const tape = new InboundTape();
	try {
		spell(context, tape, value, bindingName, [], true);
	} catch (error) {
		tape.discard(context);
		throw error;
	}
	return tape.build(context);
}

function scopedFunction(context: QuickJSContext, value: unknown): QuickJSHandle | undefined {
	return scopedResolverFor(value)?.(context);
}

/**
 * Copies an argument list into the sandbox as one array, each argument crossing as a top-level
 * value would, so a symbol argument arrives as a symbol rather than by JSON's array rule.
 */
export function marshalArgsToQuickJS(context: QuickJSContext, args: unknown[], bindingName = "host function"): QuickJSHandle {
	if (isJsonExact(args, new Set(), 0)) return parseIntoSandbox(context, args);
	const tape = new InboundTape();
	try {
		tape.open(true);
		for (const arg of args) spell(context, tape, arg, bindingName, [args], true);
		tape.close(true);
	} catch (error) {
		tape.discard(context);
		throw error;
	}
	return tape.build(context);
}

const MAX_JSON_DEPTH = 512;

/**
 * Whether `JSON.stringify` and `JSON.parse` carry `value` exactly: only finite non-negative-zero
 * numbers, strings, booleans, null, dense arrays, and plain objects without an own `__proto__`
 * key, with no cycle. Anything else (a special number, `undefined`, a BigInt, a function or
 * retained callback, a class instance, a `Date`, a hole, a cycle) takes the tape.
 */
function isJsonExact(value: unknown, ancestors: Set<object>, depth: number): boolean {
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value) && !Object.is(value, -0);
		case "object": {
			if (value === null) return true;
			if (depth > MAX_JSON_DEPTH || ancestors.has(value) || retainedResolverFor(value)) return false;
			ancestors.add(value);
			try {
				if (Array.isArray(value)) {
					for (let i = 0; i < value.length; i++) {
						if (!(i in value) || !isJsonExact(value[i], ancestors, depth + 1)) return false;
					}
					return true;
				}
				const proto = Object.getPrototypeOf(value);
				if (proto !== Object.prototype && proto !== null) return false;
				for (const key in value) {
					if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
					if (key === "__proto__" || !isJsonExact((value as Record<string, unknown>)[key], ancestors, depth + 1)) return false;
				}
				return true;
			} finally {
				ancestors.delete(value);
			}
		}
		default:
			return false;
	}
}

function spell(context: QuickJSContext, tape: InboundTape, value: unknown, bindingName: string, ancestors: object[], top = false): void {
	if (value === null) return tape.null();
	switch (typeof value) {
		case "boolean":
			return tape.boolean(value);
		case "number":
			return tape.number(value);
		case "string":
			return tape.text(value);
		case "bigint":
			return tape.bigint(value);
		case "symbol":
			return top ? tape.symbol(value) : tape.undefined();
		case "object":
		case "function": {
			const retained = retainedResolverFor(value);
			if (retained) return tape.leaf(retained(context));
			if (typeof value === "function") {
				const original = scopedFunction(context, value);
				return original ? tape.leaf(original) : tape.undefined();
			}
			if (isThenable(value)) throw promiseRefusal(bindingName);
			const at = ancestors.lastIndexOf(value);
			if (at !== -1) return tape.cycle(ancestors.length - at);
			if (ancestors.length >= MAX_CROSSING_DEPTH) throw new CrossingRefusal(TOO_DEEP_MESSAGE);
			const array = Array.isArray(value);
			ancestors.push(value);
			tape.open(array);
			if (array) {
				for (let i = 0; i < value.length; i++) spell(context, tape, value[i], bindingName, ancestors);
			} else {
				for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
					tape.text(key);
					spell(context, tape, item, bindingName, ancestors);
				}
			}
			ancestors.pop();
			return tape.close(array);
		}
		default:
			return tape.undefined();
	}
}
