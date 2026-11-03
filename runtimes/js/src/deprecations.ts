/** The codes the runtime raises on its deprecation channel. See `spec/deprecations.md`. */
export type DeprecationCode = "binding-shadows-builtin" | "unbudgeted-handler";

/** One notice on the deprecation channel. */
export interface Deprecation {
	code: DeprecationCode;
	message: string;
	/** What to do instead. */
	replacement: string;
}

/** Receives deprecation notices in place of the default console warning. */
export type DeprecationHandler = (notice: Deprecation) => void;

/**
 * Delivers each deprecation code at most once per runtime: to the host's handler when it set
 * one, otherwise as a single `console.warn`. A handler that throws never breaks the runtime.
 */
export class DeprecationChannel {
	private readonly raised = new Set<DeprecationCode>();

	constructor(private readonly handler?: DeprecationHandler) {}

	raise(code: DeprecationCode, message: string, replacement: string): void {
		if (this.raised.has(code)) return;
		this.raised.add(code);
		if (!this.handler) {
			console.warn(`xript: ${message} (${code}). ${replacement}`);
			return;
		}
		try {
			this.handler({ code, message, replacement });
		} catch {
			// a host handler that throws never changes what the runtime does
		}
	}
}

/** The globals the runtime installs over a top-level binding of the same name, in report order. */
export const SHADOWING_BUILTINS = ["events", "hooks", "xript"] as const;

/** Raises `binding-shadows-builtin` for the bindings a built-in replaced, if any. */
export function reportShadowedBindings(channel: DeprecationChannel, replaced: readonly string[]): void {
	const ordered = SHADOWING_BUILTINS.filter((name) => replaced.includes(name));
	if (ordered.length === 0) return;
	channel.raise(
		"binding-shadows-builtin",
		`host bindings replaced by a built-in global of the same name, which mods see instead: ${ordered.join(", ")}`,
		"Rename the binding or move it under a namespace.",
	);
}

/** Times hook and event handlers that run without a budget. */
export interface HandlerClock {
	start(depth: number): void;
	stop(depth: number): void;
}

export const UNTIMED: HandlerClock = { start() {}, stop() {} };

/**
 * A clock that raises `unbudgeted-handler` the first time one handler runs longer than the
 * script timeout would have allowed it. Starts are keyed by caller depth, so a handler stopped
 * without its matching `stop` leaves nothing behind for the next one to inherit.
 */
export function unbudgetedHandlerClock(limitMs: number, channel: DeprecationChannel): HandlerClock {
	const starts = new Map<number, number>();
	return {
		start(depth) {
			starts.set(depth, Date.now());
		},
		stop(depth) {
			const startedAt = starts.get(depth);
			starts.delete(depth);
			if (startedAt === undefined) return;
			const elapsed = Date.now() - startedAt;
			if (elapsed <= limitMs) return;
			channel.raise(
				"unbudgeted-handler",
				`a hook or event handler ran for ${elapsed}ms, past the ${limitMs}ms script timeout, because handlers run without a budget unless the host opts in`,
				"Create the runtime with budgetHandlers: true so each fire runs under the script timeout, and keep handlers short.",
			);
		},
	};
}
