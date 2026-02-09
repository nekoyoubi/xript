import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

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
			if (element !== context.undefined && element !== context.null && element !== context.true && element !== context.false) {
				element.dispose();
			}
		}
		return arr;
	}

	if (typeof value === "object") {
		const obj = context.newObject();
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			const propHandle = marshalToQuickJS(context, val);
			context.setProp(obj, key, propHandle);
			if (propHandle !== context.undefined && propHandle !== context.null && propHandle !== context.true && propHandle !== context.false) {
				propHandle.dispose();
			}
		}
		return obj;
	}

	return context.undefined;
}

function isStaticHandle(context: QuickJSContext, handle: QuickJSHandle): boolean {
	return handle === context.undefined || handle === context.null || handle === context.true || handle === context.false;
}

export function safeDispose(context: QuickJSContext, handle: QuickJSHandle): void {
	if (!isStaticHandle(context, handle)) {
		handle.dispose();
	}
}
