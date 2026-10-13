import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { BindingError } from "./errors.js";

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

export function marshalToQuickJS(context: QuickJSContext, value: unknown, bindingName = "host function"): QuickJSHandle {
	if (value === undefined) return context.undefined;
	if (value === null) return context.null;
	if (typeof value === "boolean") return value ? context.true : context.false;
	if (typeof value === "number") return context.newNumber(value);
	if (typeof value === "string") return context.newString(value);

	if (isThenable(value)) {
		throw new BindingError(
			bindingName,
			"returned a promise, but the synchronous sandbox cannot await it. Declare the binding with \"async\": true in the manifest and create the runtime with initXriptAsync(), or return a plain value.",
		);
	}

	if (Array.isArray(value)) {
		const arr = context.newArray();
		try {
			for (let i = 0; i < value.length; i++) {
				const element = marshalToQuickJS(context, value[i], bindingName);
				context.setProp(arr, i, element);
				safeDispose(context, element);
			}
		} catch (e) {
			safeDispose(context, arr);
			throw e;
		}
		return arr;
	}

	if (typeof value === "object") {
		const obj = context.newObject();
		let hasProtoKey = false;
		try {
			for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
				const propHandle = marshalToQuickJS(context, val, bindingName);
				if (key === "__proto__") {
					hasProtoKey = true;
					context.defineProp(obj, key, { value: propHandle, configurable: true, enumerable: true });
				} else {
					context.setProp(obj, key, propHandle);
				}
				safeDispose(context, propHandle);
			}
		} catch (e) {
			safeDispose(context, obj);
			throw e;
		}
		return hasProtoKey ? withWritableProps(context, obj) : obj;
	}

	return context.undefined;
}

/**
 * An own `__proto__` key has to be defined rather than assigned, or it runs the
 * prototype setter and reparents the object. `defineProp` cannot mark the property
 * writable, so the object is re-spread inside the sandbox: object spread copies own
 * enumerable properties as plain writable data properties, in order, and is syntax
 * rather than a global a mod could have replaced.
 */
function withWritableProps(context: QuickJSContext, obj: QuickJSHandle): QuickJSHandle {
	const spreader = context.unwrapResult(context.evalCode("(source) => ({ ...source })"));
	try {
		return context.unwrapResult(context.callFunction(spreader, context.undefined, obj));
	} finally {
		spreader.dispose();
		obj.dispose();
	}
}
