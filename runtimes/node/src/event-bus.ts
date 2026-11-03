import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { grantedSatisfies } from "./capabilities.js";
import type { CallerContext } from "./caller-context.js";
import { UNTIMED, type HandlerClock } from "./deprecations.js";
import { BindingError } from "./errors.js";
import { EVENT_BUS_KERNEL } from "./event-bus-kernel.js";
import type { RealmBridge } from "./realm.js";

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
}

interface KernelApi {
	emit(token: string, id: string, args: unknown): Array<{ owner: string | null; value: unknown }>;
	cancelOwned(token: string, owner: string | null): number;
	declare(token: string, entry: unknown): unknown;
}

function asHostError(error: unknown): unknown {
	const err = error as { name?: unknown; message?: unknown; binding?: unknown } | null;
	if (err && err.name === "BindingError" && typeof err.binding === "string") {
		const message = String(err.message);
		const prefix = `${err.binding}(): `;
		return new BindingError(err.binding, message.startsWith(prefix) ? message.slice(prefix.length) : message);
	}
	return error;
}

/**
 * Installs the events bus into a `vm` context: evaluates the shared kernel in the context's
 * realm, hands it the host object through the realm bridge, and keeps the host API it returns.
 * The kernel defines the `events` global.
 */
export function installEventBus(
	context: vm.Context,
	realm: RealmBridge,
	manifestEvents: unknown[] | undefined,
	granted: Set<string>,
	caller: CallerContext,
	clock: HandlerClock = UNTIMED,
): EventBus {
	const token = randomBytes(16).toString("hex");
	const kernel = vm.runInContext(EVENT_BUS_KERNEL, context, { filename: "xript-event-bus.js" }) as (host: unknown) => KernelApi;
	const host = realm.toContext({
		token,
		events: JSON.stringify(manifestEvents ?? []),
		caller: () => caller.current(),
		enter: (owner: unknown) => {
			caller.enter(typeof owner === "string" ? owner : null);
			clock.start(caller.depth);
		},
		leave: () => {
			clock.stop(caller.depth);
			caller.leave();
		},
		satisfies: (capability: unknown) => typeof capability === "string" && grantedSatisfies(granted, capability),
	});
	const api = kernel(host);

	return {
		emit(eventId: string, args: unknown[]): EmitResult[] {
			const results = api.emit(token, eventId, realm.toContext(args));
			return Array.from(results, (result) => ({ owner: result.owner, value: realm.toHost(result.value) }));
		},
		cancelOwned(owner: string | null): number {
			return api.cancelOwned(token, owner);
		},
		declare(entry: unknown): unknown {
			try {
				return realm.toHost(api.declare(token, realm.toContext(entry)));
			} catch (error) {
				throw asHostError(error);
			}
		},
	};
}
