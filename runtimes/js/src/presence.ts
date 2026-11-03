/**
 * Which declared bindings a host actually provides, and what an omitted one becomes.
 *
 * A manifest can be shared by hosts that do not all provide the same surface: a binding that
 * needs a browser exists on one host and not another. Such a binding is declared `optional`,
 * and a host that omits it is still conforming. The binding reads as `undefined` in the sandbox,
 * and `xript.has(path)` answers whether it is there. Omitting a binding that is not optional is
 * drift, reported through `missingBindings` and installed as a stub that throws.
 */

/** The parts of a manifest binding that decide presence. */
export interface PresenceBinding {
	optional?: boolean;
	members?: Record<string, PresenceBinding>;
	accessor?: "get" | "get-set";
}

/**
 * A live value a host supplies for a declared accessor binding: `get` runs on every read,
 * `set` on every assignment. A host may instead define a native getter (and setter) on the
 * namespace object, which the runtime reads the same way.
 */
export interface HostAccessor {
	get: () => unknown;
	set?: (value: unknown) => unknown;
}

export function isOptionalBinding(binding: PresenceBinding): boolean {
	return binding.optional === true;
}

export function isAccessorBinding(binding: PresenceBinding): binding is PresenceBinding & { accessor: "get" | "get-set" } {
	return typeof binding.accessor === "string";
}

function isNamespaceBinding(binding: PresenceBinding): binding is PresenceBinding & { members: Record<string, PresenceBinding> } {
	return typeof binding.members === "object" && binding.members !== null;
}

function asContainer(value: unknown): Record<string, unknown> | undefined {
	return value !== null && (typeof value === "object" || typeof value === "function") ? (value as Record<string, unknown>) : undefined;
}

/**
 * The accessor a host supplies for `name` in `container`, or `undefined` when it supplies none
 * the declaration can use. A `get-set` declaration needs both halves; a host that can only read
 * declares `get`.
 */
export function hostAccessorFor(container: unknown, name: string, mode: "get" | "get-set"): HostAccessor | undefined {
	const holder = asContainer(container);
	if (!holder) return undefined;
	let accessor: HostAccessor | undefined;
	const descriptor = Object.getOwnPropertyDescriptor(holder, name);
	if (descriptor && typeof descriptor.get === "function") {
		const { get, set } = descriptor;
		accessor = { get: () => get.call(holder), set: set ? (value) => set.call(holder, value) : undefined };
	} else {
		const supplied = asContainer(holder[name]);
		if (supplied && typeof supplied.get === "function") {
			const get = supplied.get as () => unknown;
			const set = typeof supplied.set === "function" ? (supplied.set as (value: unknown) => unknown) : undefined;
			accessor = { get: () => get.call(supplied), set: set ? (value) => set.call(supplied, value) : undefined };
		}
	}
	if (!accessor) return undefined;
	if (mode === "get-set" && !accessor.set) return undefined;
	return accessor;
}

function supplies(binding: PresenceBinding, container: Record<string, unknown> | undefined, name: string): boolean {
	if (isNamespaceBinding(binding)) {
		const supplied = container?.[name];
		return typeof supplied === "object" && supplied !== null;
	}
	if (isAccessorBinding(binding)) return hostAccessorFor(container, name, binding.accessor) !== undefined;
	return typeof container?.[name] === "function";
}

/**
 * Whether a declared binding the host left out is bound to `undefined` instead of installed.
 */
export function omitsBinding(binding: PresenceBinding, container: unknown, name: string): boolean {
	return isOptionalBinding(binding) && !supplies(binding, asContainer(container), name);
}

/**
 * Every declared binding path this host provides, for `xript.has`. A namespace counts when the
 * host supplies it; its members count on their own.
 */
export function providedBindingPaths(
	bindings: Record<string, PresenceBinding> | undefined,
	hostBindings: unknown,
	prefix = "",
): string[] {
	if (!bindings) return [];
	const container = asContainer(hostBindings);
	const provided: string[] = [];
	for (const [name, binding] of Object.entries(bindings)) {
		if (!supplies(binding, container, name)) continue;
		const qualified = prefix ? `${prefix}.${name}` : name;
		provided.push(qualified);
		if (isNamespaceBinding(binding)) provided.push(...providedBindingPaths(binding.members, container?.[name], qualified));
	}
	return provided.sort();
}

/**
 * Every binding the manifest declares that the host did not supply, fully qualified and sorted.
 *
 * A declared-but-unsupplied binding still installs — as a stub that throws when a mod calls it —
 * so the manifest and the host's actual wiring could disagree indefinitely with nothing to catch
 * it. A mod author reads the manifest, ships against a binding that is documented and absent, and
 * the failure lands on a user. This is the drift, computed once at construction so a host can see
 * it before a mod does. An optional binding the host omits is not drift, and neither is anything
 * beneath an optional namespace the host omits.
 */
export function missingBindingNames(
	bindings: Record<string, PresenceBinding> | undefined,
	hostBindings: unknown,
	prefix = "",
): string[] {
	if (!bindings) return [];
	const container = asContainer(hostBindings);
	const missing: string[] = [];
	for (const [name, binding] of Object.entries(bindings)) {
		const qualified = prefix ? `${prefix}.${name}` : name;
		if (omitsBinding(binding, container, name)) continue;
		if (isNamespaceBinding(binding)) {
			const nested = container?.[name];
			missing.push(...missingBindingNames(binding.members, typeof nested === "object" ? nested : undefined, qualified));
		} else if (!supplies(binding, container, name)) {
			missing.push(qualified);
		}
	}
	return missing.sort();
}

/**
 * Installs `xript.has(path)` over a fixed set of provided paths. The set lives in a closure the
 * script cannot reach, and `has` is a non-writable property, so a mod can neither forge presence
 * nor replace the probe. The `xript` object is created if nothing has made it yet.
 */
export function presenceProbeSource(paths: readonly string[]): string {
	return `(function (paths) {
	var known = Object.create(null);
	for (var i = 0; i < paths.length; i++) known[paths[i]] = true;
	var has = function has(path) { return typeof path === "string" && known[path] === true; };
	var ns = globalThis.xript;
	if (ns === null || typeof ns !== "object") { ns = {}; globalThis.xript = ns; }
	Object.defineProperty(ns, "has", { value: has, enumerable: true, writable: false, configurable: false });
})(${JSON.stringify(paths)});`;
}

/**
 * Defines an accessor binding on a sandbox object. `get` and `set` are the runtime's ordinary
 * binding wrappers, so each access is capability-gated, audited, budgeted, and error-marshalled
 * exactly as a function call. Without a setter, assignment throws a `TypeError` in strict and
 * sloppy code alike, rather than being silently dropped in sloppy code.
 */
export const DEFINE_ACCESSOR_SOURCE = `(function (target, key, get, set, name) {
	Object.defineProperty(target, key, {
		get: function () { return get(); },
		set: set ? function (value) { set(value); } : function () { throw new TypeError(name + " is read-only: the host declares no setter"); },
		enumerable: true,
		configurable: false
	});
})`;
