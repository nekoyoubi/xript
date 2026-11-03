import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { cStringSafe, InboundTape, parseIntoSandbox } from "./crossing.js";
import { BindingError } from "./errors.js";
import { retainedResolverFor } from "./retained-handles.js";

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
 * Copies a host value into the sandbox. Primitives cross directly; anything with structure, or a
 * string holding NUL, crosses as one tape built inside the sandbox (see `CROSSING_SOURCE`).
 */
export function marshalToQuickJS(context: QuickJSContext, value: unknown, bindingName = "host function"): QuickJSHandle {
	if (value === undefined) return context.undefined;
	if (value === null) return context.null;
	if (typeof value === "boolean") return value ? context.true : context.false;
	if (typeof value === "number") return context.newNumber(value);
	if (typeof value === "string" && cStringSafe(value)) return context.newString(value);

	const retained = retainedResolverFor(value);
	if (retained) return retained(context);
	if (isThenable(value)) throw promiseRefusal(bindingName);
	if (typeof value !== "object" && typeof value !== "string") return context.undefined;
	if (isJsonExact(value, 0)) return parseIntoSandbox(context, value);

	const tape = new InboundTape();
	try {
		spell(context, tape, value, bindingName);
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
 * key. Anything else (a special number, `undefined`, a function or retained callback, a class
 * instance, a `Date`, a hole) takes the tape.
 */
function isJsonExact(value: unknown, depth: number): boolean {
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value) && !Object.is(value, -0);
		case "object": {
			if (value === null) return true;
			if (depth > MAX_JSON_DEPTH || retainedResolverFor(value)) return false;
			if (Array.isArray(value)) {
				for (let i = 0; i < value.length; i++) {
					if (!(i in value) || !isJsonExact(value[i], depth + 1)) return false;
				}
				return true;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) return false;
			for (const key in value) {
				if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
				if (key === "__proto__" || !isJsonExact((value as Record<string, unknown>)[key], depth + 1)) return false;
			}
			return true;
		}
		default:
			return false;
	}
}

function spell(context: QuickJSContext, tape: InboundTape, value: unknown, bindingName: string): void {
	if (value === null) return tape.null();
	switch (typeof value) {
		case "boolean":
			return tape.boolean(value);
		case "number":
			return tape.number(value);
		case "string":
			return tape.text(value);
		case "object":
		case "function": {
			const retained = retainedResolverFor(value);
			if (retained) return tape.leaf(retained(context));
			if (isThenable(value)) throw promiseRefusal(bindingName);
			if (typeof value === "function") return tape.undefined();
			const array = Array.isArray(value);
			tape.open(array);
			if (array) {
				for (let i = 0; i < value.length; i++) spell(context, tape, value[i], bindingName);
			} else {
				for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
					tape.text(key);
					spell(context, tape, item, bindingName);
				}
			}
			return tape.close(array);
		}
		default:
			return tape.undefined();
	}
}
