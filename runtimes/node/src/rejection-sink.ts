import vm from "node:vm";

/**
 * A sandbox script runs in a `vm` context that shares the host's V8 isolate and, with it,
 * the host process's unhandled-rejection reporting. A floating rejected promise inside the
 * sandbox (`Promise.reject(...)`, an async body that throws and is never awaited, a bare
 * `import(...)`) therefore surfaces as a process-level `unhandledRejection`, which under
 * Node's default policy terminates the host. A script must not be able to stop the host.
 *
 * This sink is a single, reference-counted process listener shared by every Node sandbox.
 * It swallows a rejection whose promise belongs to a tracked sandbox context (identified by
 * that context's own `Promise` constructor) and leaves every other rejection to the host:
 * when the sink is the only `unhandledRejection` listener it re-raises a foreign rejection so
 * the host's default crash-on-unhandled-rejection is preserved, and when the host has its own
 * listeners it defers to them.
 */
const trackedPromiseCtors = new Set<Function>();
let installed = false;

function isSandboxOrigin(promise: unknown): boolean {
	for (const ctor of trackedPromiseCtors) {
		try {
			if (promise instanceof (ctor as unknown as new () => unknown)) return true;
		} catch {
			// a throwing Symbol.hasInstance cannot make a foreign promise look like ours
		}
	}
	return false;
}

function onUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
	if (isSandboxOrigin(promise)) return;
	if (process.listenerCount("unhandledRejection") === 1) {
		setImmediate(() => {
			throw reason;
		});
	}
}

/**
 * Starts containing floating rejections from `context`. Returns a release function that
 * stops tracking the context and removes the shared process listener once no sandbox is
 * tracked any more; calling it more than once is a no-op.
 */
export function trackContextRejections(context: vm.Context): () => void {
	const ctor = vm.runInContext("Promise", context) as Function;
	trackedPromiseCtors.add(ctor);
	if (!installed) {
		process.on("unhandledRejection", onUnhandledRejection);
		installed = true;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		trackedPromiseCtors.delete(ctor);
		if (trackedPromiseCtors.size === 0 && installed) {
			process.off("unhandledRejection", onUnhandledRejection);
			installed = false;
		}
	};
}
