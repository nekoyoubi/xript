import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { grantedSatisfies } from "./capabilities.js";
import type { CallerContext } from "./caller-context.js";
import { UNTIMED, type HandlerClock } from "./deprecations.js";
import { BindingError } from "./errors.js";
import { EVENT_BUS_KERNEL } from "./event-bus-kernel.js";
import { readResult } from "./callbacks.js";
import { marshalToQuickJS, safeDispose } from "./marshal.js";

/** One handler's result from a host emit, tagged with the mod that subscribed it. */
export interface EmitResult {
	owner: string | null;
	value: unknown;
}

/** The host's side of the events bus installed in one sandbox. */
export interface EventBus {
	emit(eventId: string, args: unknown[]): EmitResult[];
	cancelOwned(owner: string | null): number;
	declare(entry: unknown): unknown;
	dispose(): void;
}

type Context = QuickJSContext | QuickJSAsyncContext;

/** A per-runtime secret the kernel demands on every host-only call. */
export function busToken(): string {
	const bytes = new Uint8Array(16);
	const crypto = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
	if (crypto?.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unwrap(context: Context, result: { error?: QuickJSHandle; value?: QuickJSHandle }, what: string): QuickJSHandle {
	if (result.error) {
		const dumped = context.dump(result.error) as { message?: string } | undefined;
		result.error.dispose();
		throw new Error(`${what}: ${dumped?.message ?? String(dumped)}`);
	}
	return result.value as QuickJSHandle;
}

function setFunction(context: Context, target: QuickJSHandle, name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void): void {
	const handle = context.newFunction(name, fn);
	context.setProp(target, name, handle);
	handle.dispose();
}

/**
 * Installs the events bus into a QuickJS context: evaluates the shared kernel, hands it the
 * host object, and keeps the host API it returns. The kernel defines the `events` global.
 */
export function installEventBus(
	context: Context,
	manifestEvents: unknown[] | undefined,
	granted: Set<string>,
	caller: CallerContext,
	clock: HandlerClock = UNTIMED,
): EventBus {
	const token = busToken();
	const kernel = unwrap(context, context.evalCode(EVENT_BUS_KERNEL, "xript-event-bus.js"), "event bus kernel");

	const host = context.newObject();
	const tokenHandle = context.newString(token);
	context.setProp(host, "token", tokenHandle);
	tokenHandle.dispose();
	const eventsHandle = context.newString(JSON.stringify(manifestEvents ?? []));
	context.setProp(host, "events", eventsHandle);
	eventsHandle.dispose();
	setFunction(context, host, "caller", () => {
		const current = caller.current();
		return current === null ? context.null : context.newString(current);
	});
	setFunction(context, host, "enter", (owner) => {
		const value = owner === undefined ? null : context.dump(owner);
		caller.enter(typeof value === "string" ? value : null);
		clock.start(caller.depth);
	});
	setFunction(context, host, "leave", () => {
		clock.stop(caller.depth);
		caller.leave();
	});
	setFunction(context, host, "satisfies", (capability) => {
		const value = capability === undefined ? undefined : context.dump(capability);
		return typeof value === "string" && grantedSatisfies(granted, value) ? context.true : context.false;
	});

	const installed = context.callFunction(kernel, context.undefined, host);
	kernel.dispose();
	host.dispose();
	const api = unwrap(context, installed, "event bus install");

	function callApi(method: string, args: unknown[]): unknown {
		const handle = callApiHandle(method, args);
		const value = context.dump(handle);
		handle.dispose();
		return value;
	}

	function callApiHandle(method: string, args: unknown[]): QuickJSHandle {
		const marshalled: QuickJSHandle[] = [];
		try {
			for (const arg of args) marshalled.push(marshalToQuickJS(context, arg));
		} catch (error) {
			for (const handle of marshalled) safeDispose(context, handle);
			throw error;
		}
		const fn = context.getProp(api, method);
		const handles = [context.newString(token), ...marshalled];
		const result = context.callFunction(fn, context.undefined, ...handles);
		fn.dispose();
		for (const handle of handles) safeDispose(context, handle);
		if (result.error) {
			const dumped = context.dump(result.error) as { name?: string; message?: string; binding?: string } | undefined;
			result.error.dispose();
			const message = dumped?.message ?? String(dumped);
			if (dumped?.name === "BindingError" && typeof dumped.binding === "string") {
				const prefix = `${dumped.binding}(): `;
				throw new BindingError(dumped.binding, message.startsWith(prefix) ? message.slice(prefix.length) : message);
			}
			throw new Error(message);
		}
		return result.value;
	}

	/** Reads one result's field on its own, as hook results are read. */
	function readField(entry: QuickJSHandle, key: string): unknown {
		const field = context.getProp(entry, key);
		try {
			return context.typeof(field) === "function" ? undefined : readResult(context, field);
		} finally {
			field.dispose();
		}
	}

	return {
		emit(eventId: string, args: unknown[]): EmitResult[] {
			const results = callApiHandle("emit", [eventId, args]);
			try {
				const lengthHandle = context.getProp(results, "length");
				const length = context.dump(lengthHandle);
				lengthHandle.dispose();
				const tagged: EmitResult[] = [];
				for (let i = 0; i < (typeof length === "number" ? length : 0); i++) {
					const entry = context.getProp(results, String(i));
					try {
						const owner = readField(entry, "owner");
						tagged.push({ owner: typeof owner === "string" ? owner : null, value: readField(entry, "value") });
					} finally {
						entry.dispose();
					}
				}
				return tagged;
			} finally {
				results.dispose();
			}
		},
		cancelOwned(owner: string | null): number {
			return callApi("cancelOwned", [owner]) as number;
		},
		declare(entry: unknown): unknown {
			return callApi("declare", [entry]);
		},
		dispose(): void {
			if (api.alive) api.dispose();
		},
	};
}
