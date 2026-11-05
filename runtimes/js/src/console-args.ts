import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { readFromQuickJS } from "./crossing.js";

type Context = QuickJSContext | QuickJSAsyncContext;

/** How one console argument was read: its host value, or a budget stop the call must end with. */
export type ConsoleArgument = { value: unknown } | { interrupted: QuickJSHandle };

/**
 * Describes a thrown value the way a console line names it: `name: message` for an object with a
 * non-empty string `message` (`Error` standing in for a missing `name`), the bare name when the
 * message is empty, and `String(value)` for anything else.
 */
export function describeThrown(thrown: unknown): string {
	if (thrown !== null && typeof thrown === "object") {
		const { name, message } = thrown as { name?: unknown; message?: unknown };
		const label = typeof name === "string" ? name : "Error";
		return typeof message === "string" && message !== "" ? `${label}: ${message}` : label;
	}
	try {
		return String(thrown);
	} catch {
		return "Error";
	}
}

/** The text an argument that cannot be read reaches the host as. */
export function unreadable(thrown: unknown): string {
	return `[unreadable: ${describeThrown(thrown)}]`;
}

const FUNCTION_TEXT_SOURCE = "(function () { var text = String; return function (fn) { return text(fn); }; })()";

const functionTextByContext = new WeakMap<Context, QuickJSHandle>();

/** Installs the context's console helpers; must run before any script does. */
export function installConsoleSupport(context: Context): void {
	if (functionTextByContext.has(context)) return;
	functionTextByContext.set(context, context.unwrapResult(context.evalCode(FUNCTION_TEXT_SOURCE, "xript-console.js")));
}

/** Releases the context's console helpers; must run before the context is disposed. */
export function releaseConsoleSupport(context: Context): void {
	const helper = functionTextByContext.get(context);
	functionTextByContext.delete(context);
	if (helper?.alive) helper.dispose();
}

function dumpThrown(context: Context, error: QuickJSHandle): unknown {
	try {
		return context.dump(error);
	} catch {
		return undefined;
	}
}

function settleStop(context: Context, error: QuickJSHandle): ConsoleArgument {
	const thrown = dumpThrown(context, error);
	const message = thrown !== null && typeof thrown === "object" ? (thrown as { message?: unknown }).message : undefined;
	if (typeof message === "string" && message.includes("interrupted")) return { interrupted: error };
	error.dispose();
	return { value: unreadable(thrown) };
}

function readFunctionText(context: Context, handle: QuickJSHandle): ConsoleArgument {
	const helper = functionTextByContext.get(context)!;
	const result = context.callFunction(helper, context.undefined, handle);
	if (result.error) return settleStop(context, result.error);
	try {
		return { value: readFromQuickJS(context, result.value) };
	} finally {
		result.value.dispose();
	}
}

/**
 * Reads one console argument for the host. A console call never throws on what it is given: an
 * argument whose reading throws (a revoked proxy, a getter that throws, a value nested too deep)
 * reaches the host as `[unreadable: <description>]`. Only a budget interrupt escapes, because the
 * host may not swallow an execution-limit stop. The caller keeps ownership of `handle`.
 */
export function readConsoleArgument(context: Context, handle: QuickJSHandle): ConsoleArgument {
	const stop: { error: QuickJSHandle | null } = { error: null };
	let value: unknown;
	try {
		if (context.typeof(handle) === "function") return readFunctionText(context, handle);
		value = readFromQuickJS(context, handle, {
			copyNamed: true,
			onStopped: (error) => {
				if (stop.error) error.dispose();
				else stop.error = error;
			},
		});
	} catch (error) {
		return { value: unreadable(error) };
	}
	return stop.error ? settleStop(context, stop.error) : { value };
}
