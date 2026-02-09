import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

function isStaticHandle(context: QuickJSContext, handle: QuickJSHandle): boolean {
	return handle === context.undefined || handle === context.null || handle === context.true || handle === context.false;
}

export function safeDispose(context: QuickJSContext, handle: QuickJSHandle): void {
	if (!isStaticHandle(context, handle)) {
		handle.dispose();
	}
}

export function marshalToQuickJS(context: QuickJSContext, value: unknown): QuickJSHandle {
	if (value === undefined) return context.undefined;
	if (value === null) return context.null;
	if (typeof value === "boolean") return value ? context.true : context.false;
	if (typeof value === "number") return context.newNumber(value);
	if (typeof value === "string") return context.newString(value);

	if (Array.isArray(value)) {
		const arr = context.newArray();
		for (let i = 0; i < value.length; i++) {
			const element = marshalToQuickJS(context, value[i]);
			context.setProp(arr, i, element);
			safeDispose(context, element);
		}
		return arr;
	}

	if (typeof value === "object") {
		const obj = context.newObject();
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			const propHandle = marshalToQuickJS(context, val);
			context.setProp(obj, key, propHandle);
			safeDispose(context, propHandle);
		}
		return obj;
	}

	return context.undefined;
}
