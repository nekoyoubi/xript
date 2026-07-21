/**
 * Declared execution intent: the `execution` block a host manifest puts on its bindings, hooks,
 * slots and top level, and a mod manifest puts on its exports and top level.
 *
 * Intent is advisory. It is not `limits` (which is enforcement) and it is not a capability
 * (no grant is consulted). A host routes on it; nothing in xript makes it true. A
 * `duration: instant` binding that takes ten seconds is a bug in the manifest, not a security
 * failure.
 */

export type Duration = "instant" | "brief" | "long" | "unbounded";
export type Affinity = "any" | "pinned" | "isolated";

export interface ExecutionIntent {
	duration?: Duration;
	affinity?: Affinity;
}

export interface ResolvedExecutionIntent {
	duration: Duration;
	affinity: Affinity;
}

/** Totally ordered by cost. `instant < brief < long < unbounded`. */
export const DURATION_ORDER: readonly Duration[] = ["instant", "brief", "long", "unbounded"];
/** Totally ordered by restrictiveness. `any < pinned < isolated`. */
export const AFFINITY_ORDER: readonly Affinity[] = ["any", "pinned", "isolated"];

export const DEFAULT_EXECUTION_INTENT: ResolvedExecutionIntent = { duration: "brief", affinity: "any" };

/**
 * The host-binding thread contract. Stated wherever a host author reads: the spec, the runtime
 * doc comments, the typegen routing table, docgen, and `xript describe`.
 */
export const HOST_BINDING_THREAD_CONTRACT =
	"Under a runtime pool, host bindings are invoked concurrently from multiple worker threads. A binding registered with a pool MUST be reentrant and thread-safe. xript does not and cannot serialize calls into host code; a binding that requires serialization must implement it itself, and must not do so with a lock that an interactive-lane call can contend against.";

/**
 * What `async` does and does not claim. Emitted on every async binding, unconditionally.
 */
export const ASYNC_SHAPE_REMARK =
	"`async` declares the SHAPE of the value this binding hands the runtime (a promise rather than a settled value), not the cost of the call. It may not yield: on most runtime configurations the interpreter is fully occupied for the duration of an async binding. Declare cost in `execution` and route on it. See the per-runtime table in the xript spec.";

/**
 * What xript's limits actually bound. Emitted on every `long`/`unbounded` binding,
 * unconditionally.
 */
export const LIMITS_REACH_REMARK =
	"xript's execution budget bounds SCRIPT execution, not host-binding execution. Once control enters this binding, no xript timeout, cancellation token, or drop-cancel will stop it — the interpreter is not running, so nothing observes them. Bounding a binding that may block is the host's own job.";

export const DURATION_PROSE: Record<Duration, string> = {
	instant: "completes in microseconds and touches no I/O; safe to call from anywhere, including a render pass",
	brief: "completes within the ambient execution budget; safe on an interactive lane, not in a render pass",
	long: "may exceed the ambient execution budget; the host should route this off its interactive lane",
	unbounded: "networked, streaming, or user-gated, with no meaningful upper bound; a host that cannot route it off its interactive lane should refuse to register it",
};

export const AFFINITY_PROSE: Record<Affinity, string> = {
	any: "stateless with respect to the sandbox; any runtime may serve it",
	pinned: "reads or writes per-runtime mod state, so it must land on the runtime where that state lives",
	isolated: "wants a runtime nobody else is using",
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asIntent(value: unknown): ExecutionIntent | undefined {
	if (!isObject(value)) return undefined;
	const intent: ExecutionIntent = {};
	if (typeof value.duration === "string" && (DURATION_ORDER as readonly string[]).includes(value.duration)) {
		intent.duration = value.duration as Duration;
	}
	if (typeof value.affinity === "string" && (AFFINITY_ORDER as readonly string[]).includes(value.affinity)) {
		intent.affinity = value.affinity as Affinity;
	}
	return intent;
}

/**
 * An axis a party is silent on counts as the schema default, not as "no opinion". Silence is a
 * claim of `brief`/`any` everywhere else in this module, and letting it read as no-opinion here
 * would let one party's explicit `instant` pull a silent party below the default — the one
 * direction widen must never move.
 */
function maxBy<T extends string>(order: readonly T[], a: T | undefined, b: T | undefined, fallback: T): T {
	const ai = order.indexOf(a ?? fallback);
	const bi = order.indexOf(b ?? fallback);
	return order[Math.max(ai, bi)];
}

/**
 * The interaction rule when two parties declare intent for the same call: the pairwise maximum
 * on each ordered lattice. Neither party can weaken the other, because the failure costs are
 * asymmetric — under-routing a long call freezes a UI, over-routing a brief one costs a thread
 * hop. A host that disagrees for a specific mod overrides it at the call site.
 */
export function widenExecutionIntent(
	a: ExecutionIntent | undefined,
	b: ExecutionIntent | undefined,
): ResolvedExecutionIntent {
	return {
		duration: maxBy(DURATION_ORDER, a?.duration, b?.duration, DEFAULT_EXECUTION_INTENT.duration),
		affinity: maxBy(AFFINITY_ORDER, a?.affinity, b?.affinity, DEFAULT_EXECUTION_INTENT.affinity),
	};
}

function bindingAt(manifest: Json, dotted: string): Json | undefined {
	const segments = dotted.split(".");
	let current: unknown = isObject(manifest.bindings) ? manifest.bindings : undefined;
	for (let i = 0; i < segments.length; i++) {
		if (!isObject(current)) return undefined;
		const next: unknown = current[segments[i]];
		if (!isObject(next)) return undefined;
		if (i === segments.length - 1) return next;
		current = isObject(next.members) ? next.members : undefined;
	}
	return undefined;
}

function slotAt(manifest: Json, id: string): Json | undefined {
	const slots = Array.isArray(manifest.slots) ? manifest.slots : [];
	return slots.find((slot) => isObject(slot) && slot.id === id) as Json | undefined;
}

function exportAt(manifest: Json, name: string): Json | undefined {
	const entry = manifest.entry;
	if (!isObject(entry) || !isObject(entry.exports)) return undefined;
	const def = entry.exports[name];
	return isObject(def) ? def : undefined;
}

function surfaceAt(manifest: Json, path: string): Json | undefined {
	const slash = path.indexOf("/");
	if (slash < 0) return undefined;
	const kind = path.slice(0, slash);
	const id = path.slice(slash + 1);
	if (kind === "bindings") return bindingAt(manifest, id);
	if (kind === "hooks") return isObject(manifest.hooks) && isObject(manifest.hooks[id]) ? (manifest.hooks[id] as Json) : undefined;
	if (kind === "slots") return slotAt(manifest, id);
	if (kind === "exports") return exportAt(manifest, id);
	return undefined;
}

/**
 * The `execution` a surface declares for itself, with nothing inherited. `undefined` means the
 * surface is silent, which is what the coverage signal and the `execution-missing-*` findings
 * turn on.
 *
 * `path` is `"bindings/<dotted name>"`, `"hooks/<id>"`, `"slots/<id>"`, `"exports/<name>"`, or
 * `""` for the manifest's own top-level declaration.
 */
export function declaredExecutionIntent(manifest: unknown, path: string): ExecutionIntent | undefined {
	if (!isObject(manifest)) return undefined;
	if (path === "" || path === "/") return asIntent(manifest.execution);
	const surface = surfaceAt(manifest, path);
	return surface ? asIntent(surface.execution) : undefined;
}

/**
 * The `execution` in force at a surface: its own declaration, else the manifest's top-level
 * default, else the schema defaults (`brief` / `any`). An unknown path resolves to the
 * manifest default rather than throwing, because tooling asks about paths a manifest may not
 * carry.
 */
export function resolveExecutionIntent(manifest: unknown, path: string): ResolvedExecutionIntent {
	if (!isObject(manifest)) return { ...DEFAULT_EXECUTION_INTENT };
	const own = declaredExecutionIntent(manifest, path);
	const fallback = path === "" || path === "/" ? undefined : asIntent(manifest.execution);
	const source = own ?? fallback ?? {};
	return {
		duration: source.duration ?? DEFAULT_EXECUTION_INTENT.duration,
		affinity: source.affinity ?? DEFAULT_EXECUTION_INTENT.affinity,
	};
}

export interface InvokeIntentOptions {
	/** The mod export being invoked. */
	export?: string;
	/** The host slot the export fills, when it fills one. */
	slot?: string;
	/** An explicit intent the host passed at the call site. Supplied, it wins alone. */
	callSite?: ExecutionIntent;
}

/**
 * The intent in force for a call into a mod export, per the host-versus-mod precedence rule:
 *
 * 1. An explicit call-site intent wins alone.
 * 2. Otherwise `widen(host side, mod side)` — the more expensive claim wins on each axis.
 * 3. The host side is the filled slot's resolved intent, or the host manifest's top-level
 *    intent when the export fills no declared slot.
 * 4. The mod side is the export's resolved intent, which falls back to the mod manifest's
 *    top-level intent when the export is undeclared (module-mode auto-registration).
 */
export function resolveInvokeIntent(host: unknown, mod: unknown, options: InvokeIntentOptions = {}): ResolvedExecutionIntent {
	if (options.callSite) {
		return {
			duration: options.callSite.duration ?? DEFAULT_EXECUTION_INTENT.duration,
			affinity: options.callSite.affinity ?? DEFAULT_EXECUTION_INTENT.affinity,
		};
	}
	const hostSide = options.slot ? resolveExecutionIntent(host, `slots/${options.slot}`) : resolveExecutionIntent(host, "");
	const modSide = options.export ? resolveExecutionIntent(mod, `exports/${options.export}`) : resolveExecutionIntent(mod, "");
	return widenExecutionIntent(hostSide, modSide);
}

export function isDefaultIntent(intent: ResolvedExecutionIntent): boolean {
	return intent.duration === DEFAULT_EXECUTION_INTENT.duration && intent.affinity === DEFAULT_EXECUTION_INTENT.affinity;
}

export function compareDuration(a: Duration, b: Duration): number {
	return DURATION_ORDER.indexOf(a) - DURATION_ORDER.indexOf(b);
}

export type SurfaceKind = "binding" | "hook" | "slot" | "export";

export interface ExecutionSurface {
	kind: SurfaceKind;
	/** The path `resolveExecutionIntent` takes. */
	path: string;
	/** The name a reader knows the surface by: a dotted binding name, a hook/slot id, an export name. */
	name: string;
	/** Whether the surface carries an `execution` of its own. */
	declared: boolean;
	resolved: ResolvedExecutionIntent;
	/** Set on bindings, so the async remark can be emitted without re-walking the manifest. */
	async?: boolean;
	capability?: string;
	/** Whether the surface carries a `limits` override of its own. */
	limits?: boolean;
	/** Whether the surface declares any parameters. */
	hasParams?: boolean;
}

function walkBindings(bindings: unknown, prefix: string, out: Array<{ name: string; def: Json }>): void {
	if (!isObject(bindings)) return;
	for (const [name, def] of Object.entries(bindings)) {
		if (!isObject(def)) continue;
		const qualified = prefix ? `${prefix}.${name}` : name;
		if (isObject(def.members)) {
			walkBindings(def.members, qualified, out);
		} else {
			out.push({ name: qualified, def });
		}
	}
}

/**
 * Every surface intent can be declared on, in a stable order: bindings (namespaces flattened to
 * dotted names), hooks, slots, then mod exports. The coverage signal, the routing table, the
 * docgen Execution column and `xript describe` all read this one list.
 */
export function executionSurfaces(manifest: unknown): ExecutionSurface[] {
	if (!isObject(manifest)) return [];
	const surfaces: ExecutionSurface[] = [];

	const functions: Array<{ name: string; def: Json }> = [];
	walkBindings(manifest.bindings, "", functions);
	for (const { name, def } of functions) {
		const path = `bindings/${name}`;
		surfaces.push({
			kind: "binding",
			path,
			name,
			declared: declaredExecutionIntent(manifest, path) !== undefined,
			resolved: resolveExecutionIntent(manifest, path),
			async: def.async === true,
			capability: typeof def.capability === "string" ? def.capability : undefined,
			limits: isObject(def.limits),
			hasParams: Array.isArray(def.params) && def.params.length > 0,
		});
	}

	if (isObject(manifest.hooks)) {
		for (const [name, def] of Object.entries(manifest.hooks)) {
			if (!isObject(def)) continue;
			const path = `hooks/${name}`;
			surfaces.push({
				kind: "hook",
				path,
				name,
				declared: declaredExecutionIntent(manifest, path) !== undefined,
				resolved: resolveExecutionIntent(manifest, path),
				async: def.async === true,
				capability: typeof def.capability === "string" ? def.capability : undefined,
				limits: isObject(def.limits),
				hasParams: Array.isArray(def.params) && def.params.length > 0,
			});
		}
	}

	if (Array.isArray(manifest.slots)) {
		for (const slot of manifest.slots) {
			if (!isObject(slot) || typeof slot.id !== "string") continue;
			const path = `slots/${slot.id}`;
			surfaces.push({
				kind: "slot",
				path,
				name: slot.id,
				declared: declaredExecutionIntent(manifest, path) !== undefined,
				resolved: resolveExecutionIntent(manifest, path),
				capability: typeof slot.capability === "string" ? slot.capability : undefined,
				limits: isObject(slot.limits),
			});
		}
	}

	const entry = manifest.entry;
	if (isObject(entry) && isObject(entry.exports)) {
		for (const [name, def] of Object.entries(entry.exports)) {
			if (!isObject(def)) continue;
			const path = `exports/${name}`;
			surfaces.push({
				kind: "export",
				path,
				name,
				declared: declaredExecutionIntent(manifest, path) !== undefined,
				resolved: resolveExecutionIntent(manifest, path),
				capability: typeof def.capability === "string" ? def.capability : undefined,
				hasParams: Array.isArray(def.params) && def.params.length > 0,
			});
		}
	}

	return surfaces;
}
