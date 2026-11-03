import type { QuickJSContext, QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten-core";
import { CallbackError, RetainError } from "./errors.js";
import { callScriptFunction, type CallbackSupport } from "./callbacks.js";
import type { CallerContext } from "./caller-context.js";
import type { CancellationToken } from "./sandbox.js";
import { registerRetainedHandle } from "./retained-handles.js";

type Context = QuickJSContext | QuickJSAsyncContext;

/**
 * A callback the host retained past the binding call that received it. Call it from inside a
 * binding call (it spends that script call's budget) or between script calls (it gets a fresh
 * budget); release it when done. Passing the handle back into the sandbox delivers the
 * original script function.
 */
export interface RetainedCallback {
	call(...args: unknown[]): unknown;
	release(): void;
	readonly released: boolean;
	/** The binding the callback was first retained from. */
	readonly binding: string;
}

/** The limits and budget a context's retained callbacks run under. */
export interface RetainedOptions {
	callerContext: CallerContext;
	/** `limits.max_retained_callbacks`. */
	limit: number;
	/** The budget of a call made between script calls. */
	timeoutMs: number;
	pushInterruptFrame: (deadline: number, cancellation?: CancellationToken) => () => void;
	cancellation?: CancellationToken;
}

/** The default `limits.max_retained_callbacks`. */
export const DEFAULT_MAX_RETAINED_CALLBACKS = 10000;

interface RetainedRecord {
	key: string;
	fn: QuickJSHandle;
	owner: string | null;
	binding: string;
	released: boolean;
	handle: RetainedCallback;
}

/**
 * Hands out a stable id per script function, keyed in a sandbox-realm `WeakMap` captured
 * before any script runs, so a script cannot tamper with how its functions are identified.
 */
const FUNCTION_ID_SOURCE = `(function () {
	var ids = new WeakMap();
	var get = WeakMap.prototype.get;
	var set = WeakMap.prototype.set;
	var apply = Reflect.apply;
	var next = 0;
	return function (f) {
		var id = apply(get, ids, [f]);
		if (id === undefined) {
			next = next + 1;
			id = next;
			apply(set, ids, [f, id]);
		}
		return id;
	};
})()`;

/** One context's retained callbacks: one per script function per owning mod. */
export class RetainedRegistry {
	private readonly live = new Map<string, RetainedRecord>();
	private readonly idOf: QuickJSHandle;

	constructor(
		private readonly context: Context,
		private readonly support: CallbackSupport,
		private readonly options: RetainedOptions,
	) {
		this.idOf = context.unwrapResult(context.evalCode(FUNCTION_ID_SOURCE, "xript-retained.js"));
	}

	/** Retains `fn` for the mod running now, or returns the callback it already retained. */
	retain(fn: QuickJSHandle, binding: string, retainable: boolean): RetainedCallback {
		const owner = this.options.callerContext.current();
		const key = `${this.functionId(fn)}:${owner ?? ""}`;
		const existing = this.live.get(key);
		if (existing) return existing.handle;
		if (!retainable) throw new RetainError(binding, "undeclared");
		if (this.live.size >= this.options.limit) throw new RetainError(binding, "limit", this.options.limit);

		const record = { key, fn: fn.dup(), owner, binding, released: false } as RetainedRecord;
		const handle: RetainedCallback = Object.freeze({
			call: (...args: unknown[]) => this.invoke(record, args),
			release: () => this.release(record),
			get released() {
				return record.released;
			},
			get binding() {
				return record.binding;
			},
		});
		record.handle = handle;
		registerRetainedHandle(handle, (context) => this.resolve(record, context));
		this.live.set(key, record);
		return handle;
	}

	/** Releases every callback `mod` supplied; returns how many. */
	releaseOwner(mod: string): number {
		let released = 0;
		for (const record of [...this.live.values()]) {
			if (record.owner !== mod) continue;
			this.release(record);
			released++;
		}
		return released;
	}

	/** Releases everything; must run before the context is disposed. */
	dispose(): void {
		for (const record of [...this.live.values()]) this.release(record);
		if (this.idOf.alive) this.idOf.dispose();
	}

	private functionId(fn: QuickJSHandle): number {
		const result = this.context.callFunction(this.idOf, this.context.undefined, fn);
		const handle = this.context.unwrapResult(result);
		const id = this.context.getNumber(handle);
		handle.dispose();
		return id;
	}

	private release(record: RetainedRecord): void {
		if (record.released) return;
		record.released = true;
		this.live.delete(record.key);
		if (record.fn.alive) record.fn.dispose();
	}

	private resolve(record: RetainedRecord, context: QuickJSContext): QuickJSHandle {
		if (record.released) throw new CallbackError(record.binding, "released");
		const current = this.options.callerContext.current();
		if (context !== this.context || (current !== null && current !== record.owner)) {
			throw new CallbackError(record.binding, "expired", undefined, "foreign");
		}
		return record.fn.dup();
	}

	private invoke(record: RetainedRecord, args: unknown[]): unknown {
		if (record.released) throw new CallbackError(record.binding, "released");
		return this.options.callerContext.run(record.owner, () => {
			const running = this.support.scopes[this.support.scopes.length - 1];
			if (running) return running.call(record.fn, args, record.binding);
			return this.invokeBetweenCalls(record, args);
		});
	}

	private invokeBetweenCalls(record: RetainedRecord, args: unknown[]): unknown {
		const { pushInterruptFrame, timeoutMs, cancellation } = this.options;
		const popInterrupt = pushInterruptFrame(Date.now() + timeoutMs, cancellation);
		let outcome;
		try {
			outcome = callScriptFunction(this.context, this.support, record.fn, args, record.binding);
		} finally {
			popInterrupt();
		}
		switch (outcome.kind) {
			case "returned":
				return outcome.value;
			case "promise":
				throw new CallbackError(record.binding, "promise");
			case "limit":
				outcome.error.dispose();
				throw new CallbackError(record.binding, "limit");
			case "threw":
				outcome.error.dispose();
				throw new CallbackError(record.binding, "threw", outcome.info);
		}
	}
}
