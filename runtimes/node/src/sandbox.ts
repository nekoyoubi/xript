import vm from "node:vm";
import { AmbiguousExportError, BindingError, CapabilityDeniedError, ExecutionLimitError, CancellationError, InvokeError, ModEntryError, ImportDeniedError, ModuleUnsupportedError, LibraryUnavailableError, LibraryRegistrationError } from "./errors.js";
import { findImportSpecifier, findImportSpecifiers, detectCommonJS } from "./module-support.js";
import type { DebugOptions, DebugSession } from "./debug-types.js";
import { createDebugController } from "./debug-session.js";
import { instrumentSource } from "./debug-instrument.js";
import { grantedSatisfies } from "./capabilities.js";
import type { NodeRef } from "./fragment.js";

interface Manifest {
	xript: string;
	name: string;
	version?: string;
	bindings?: Record<string, Binding>;
	hooks?: Record<string, HookDef>;
	slots?: Slot[];
	events?: EventDef[];
	capabilities?: Record<string, CapabilityDef>;
	libraries?: Record<string, LibraryDef>;
	limits?: ExecutionLimits;
}

interface LibraryDef {
	description: string;
	capability?: string;
	version?: string;
	deprecated?: string;
}

interface Slot {
	id: string;
	accepts: string[];
	description?: string;
	capability?: string;
	payload?: unknown;
}

const HOOK_SLOT_ACCEPT = "application/x-xript-hook";

function isHookSlot(slot: Slot): boolean {
	return Array.isArray(slot.accepts) && slot.accepts.includes(HOOK_SLOT_ACCEPT);
}

function effectiveHooks(manifest: Manifest): Record<string, HookDef> {
	const hooks: Record<string, HookDef> = { ...(manifest.hooks ?? {}) };
	for (const slot of manifest.slots ?? []) {
		if (!isHookSlot(slot)) continue;
		if (slot.id in hooks) continue;
		hooks[slot.id] = {
			description: slot.description ?? "",
			capability: slot.capability,
		};
	}
	return hooks;
}

interface EventDef {
	id: string;
	description: string;
	payload?: unknown;
	capability?: string;
}

interface HookDef {
	description: string;
	phases?: string[];
	params?: Parameter[];
	capability?: string;
	async?: boolean;
	limits?: ExecutionLimits;
	deprecated?: string;
}

type Binding = FunctionBinding | NamespaceBinding;

interface FunctionBinding {
	description: string;
	params?: Parameter[];
	returns?: unknown;
	async?: boolean;
	capability?: string;
	deprecated?: string;
}

interface NamespaceBinding {
	description: string;
	members: Record<string, Binding>;
}

interface Parameter {
	name: string;
	type: unknown;
	default?: unknown;
	required?: boolean;
}

interface CapabilityDef {
	description: string;
	risk?: string;
}

interface ExecutionLimits {
	timeout_ms?: number;
	memory_mb?: number;
	max_stack_depth?: number;
}

/**
 * A function a host supplies for a declared binding.
 *
 * Parameters are `any[]` rather than `unknown[]` on purpose. Under `strictFunctionTypes`
 * parameters are contravariant, so an idiomatic typed binding — `(message: string) => void` —
 * is *not* assignable to `(...args: unknown[]) => unknown`, and every host writing typed
 * bindings had to widen them to `unknown` and narrow again inside. The scaffolded app hit this
 * on its own generated code. `any[]` accepts both shapes and still rejects a non-function;
 * arguments arrive as JSON-derived values whatever the signature claims, so the stricter type
 * was never enforcing anything a host could rely on.
 */
export type HostFunction = (...args: any[]) => unknown;
export interface HostNamespace {
	[key: string]: HostFunction | HostNamespace;
}
export type HostBindings = Record<string, HostFunction | HostNamespace>;

export type LogSeverity = "trace" | "debug" | "info" | "warn" | "error";

export interface ConsoleHandler {
	log?: (...args: unknown[]) => void;
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
	debug?: (...args: unknown[]) => void;
	trace?: (...args: unknown[]) => void;
	onLog?: (severity: LogSeverity, ...args: unknown[]) => void;
}

export type AuditDecision = "invoke" | "denied";

export interface AuditEvent {
	binding: string;
	capability: string | null;
	at: number;
	/** `"invoke"` for an allowed host-binding call, `"denied"` for a refused capability decision. */
	decision?: AuditDecision;
	/** Mod that owns the refused export. Present only on denial records. */
	mod?: string;
	/** Hook whose fill was refused. Present only on denial records for hook fills. */
	hook?: string;
}

export interface HardLimits {
	timeout_ms?: number;
	memory_mb?: number;
	max_stack_depth?: number;
}

export class CancellationToken {
	private flag = { cancelled: false };

	cancel(): void {
		this.flag.cancelled = true;
	}

	get cancelled(): boolean {
		return this.flag.cancelled;
	}
}

export interface SandboxOptions {
	manifest: Manifest;
	hostBindings: HostBindings;
	capabilities?: string[];
	libraries?: Record<string, string>;
	console?: ConsoleHandler;
	audit?: (event: AuditEvent) => void;
	hardLimits?: HardLimits;
	cancellation?: CancellationToken;
	debug?: DebugOptions;
}

export interface ExecutionResult {
	value: unknown;
	duration_ms: number;
}

/**
 * Every binding the manifest declares that the host did not supply, fully qualified and sorted.
 * A declared-but-unsupplied binding installs as a stub that throws only when a mod calls it, so
 * without this the manifest and the host's wiring could disagree indefinitely.
 */
export function missingBindingNames(
	bindings: Record<string, Binding> | undefined,
	hostBindings: Record<string, unknown> | undefined,
	prefix = "",
): string[] {
	if (!bindings) return [];
	const missing: string[] = [];
	for (const [name, binding] of Object.entries(bindings)) {
		const qualified = prefix ? `${prefix}.${name}` : name;
		const supplied = hostBindings?.[name];
		if (isNamespace(binding)) {
			const nested = typeof supplied === "object" && supplied !== null ? (supplied as Record<string, unknown>) : undefined;
			missing.push(...missingBindingNames(binding.members, nested, qualified));
		} else if (typeof supplied !== "function") {
			missing.push(qualified);
		}
	}
	return missing.sort();
}

function isNamespace(binding: Binding): binding is NamespaceBinding {
	return "members" in binding;
}

const CONSOLE_METHOD_SEVERITY: Record<string, LogSeverity> = {
	log: "info",
	info: "info",
	warn: "warn",
	error: "error",
	debug: "debug",
	trace: "trace",
};

function dispatchConsole(
	handler: ConsoleHandler,
	method: string,
	severity: LogSeverity,
	args: unknown[],
): void {
	if (handler.onLog) {
		handler.onLog(severity, ...args);
		return;
	}
	const direct = handler[method as keyof ConsoleHandler] as ((...a: unknown[]) => void) | undefined;
	if (direct) {
		direct(...args);
		return;
	}
	const fallback = severity === "warn" ? handler.warn : severity === "error" ? handler.error : handler.log;
	if (fallback) fallback(...args);
}

function emitAudit(
	audit: ((event: AuditEvent) => void) | undefined,
	binding: string,
	capability: string | null,
): void {
	if (!audit) return;
	try {
		audit({ binding, capability, at: Date.now(), decision: "invoke" });
	} catch {
		// fire-and-forget: emit failures never break script execution
	}
}

function buildSandboxGlobal(options: SandboxOptions): Record<string, unknown> {
	const { manifest, hostBindings, capabilities = [] } = options;
	const grantedCapabilities = new Set(capabilities);
	const audit = options.audit;

	const sandboxConsole = options.console || {};

	const globals: Record<string, unknown> = {};

	const consoleObj: Record<string, unknown> = {};
	for (const method of Object.keys(CONSOLE_METHOD_SEVERITY)) {
		const severity = CONSOLE_METHOD_SEVERITY[method];
		consoleObj[method] = (...args: unknown[]) => dispatchConsole(sandboxConsole, method, severity, args);
	}
	globals.console = consoleObj;

	globals.JSON = { parse: JSON.parse, stringify: JSON.stringify };
	globals.Math = Math;
	globals.Date = Date;
	globals.Number = Number;
	globals.String = String;
	globals.Boolean = Boolean;
	globals.Array = Array;
	globals.Object = Object;
	globals.Map = Map;
	globals.Set = Set;
	globals.WeakMap = WeakMap;
	globals.WeakSet = WeakSet;
	globals.Promise = Promise;
	globals.Error = Error;
	globals.TypeError = TypeError;
	globals.RangeError = RangeError;
	globals.SyntaxError = SyntaxError;
	globals.ReferenceError = ReferenceError;
	globals.RegExp = RegExp;
	globals.Symbol = Symbol;
	globals.ArrayBuffer = ArrayBuffer;
	globals.DataView = DataView;
	globals.Int8Array = Int8Array;
	globals.Uint8Array = Uint8Array;
	globals.Int16Array = Int16Array;
	globals.Uint16Array = Uint16Array;
	globals.Int32Array = Int32Array;
	globals.Uint32Array = Uint32Array;
	globals.Float32Array = Float32Array;
	globals.Float64Array = Float64Array;
	globals.BigInt64Array = BigInt64Array;
	globals.BigUint64Array = BigUint64Array;
	globals.BigInt = BigInt;
	globals.Proxy = Proxy;
	globals.Reflect = Reflect;

	globals.isNaN = isNaN;
	globals.isFinite = isFinite;
	globals.parseInt = parseInt;
	globals.parseFloat = parseFloat;
	globals.undefined = undefined;
	globals.NaN = NaN;
	globals.Infinity = Infinity;

	globals.BindingError = BindingError;
	globals.CapabilityDeniedError = CapabilityDeniedError;

	globals.eval = () => {
		throw new TypeError("eval() is not permitted. Dynamic code generation is disabled in xript.");
	};
	globals.Function = new Proxy(Function, {
		construct() {
			throw new TypeError(
				"new Function() is not permitted. Dynamic code generation is disabled in xript.",
			);
		},
		apply() {
			throw new TypeError(
				"Function() is not permitted. Dynamic code generation is disabled in xript.",
			);
		},
	});

	if (manifest.bindings) {
		for (const [name, binding] of Object.entries(manifest.bindings)) {
			if (isNamespace(binding)) {
				globals[name] = buildNamespace(
					name,
					binding,
					hostBindings[name] as HostNamespace | undefined,
					grantedCapabilities,
					audit,
				);
			} else {
				globals[name] = buildFunction(
					name,
					binding,
					hostBindings[name] as HostFunction | undefined,
					grantedCapabilities,
					audit,
				);
			}
		}
	}

	return globals;
}

function buildFunction(
	qualifiedName: string,
	binding: FunctionBinding,
	hostFn: HostFunction | undefined,
	grantedCapabilities: Set<string>,
	audit?: (event: AuditEvent) => void,
): HostFunction {
	return (...args: unknown[]) => {
		if (binding.capability && !grantedSatisfies(grantedCapabilities, binding.capability)) {
			throw new CapabilityDeniedError(qualifiedName, binding.capability);
		}

		if (!hostFn) {
			throw new BindingError(qualifiedName, "not implemented by the app");
		}

		emitAudit(audit, qualifiedName, binding.capability ?? null);

		try {
			return hostFn(...args);
		} catch (e) {
			if (e instanceof CapabilityDeniedError || e instanceof BindingError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new BindingError(qualifiedName, message);
		}
	};
}

function buildNamespace(
	namespaceName: string,
	binding: NamespaceBinding,
	hostNs: HostNamespace | undefined,
	grantedCapabilities: Set<string>,
	audit?: (event: AuditEvent) => void,
): Record<string, unknown> {
	const ns: Record<string, unknown> = {};

	for (const [memberName, memberBinding] of Object.entries(binding.members)) {
		const qualifiedName = `${namespaceName}.${memberName}`;
		if (isNamespace(memberBinding)) {
			const nestedHostNs = hostNs ? (hostNs[memberName] as HostNamespace | undefined) : undefined;
			ns[memberName] = buildNamespace(qualifiedName, memberBinding, nestedHostNs, grantedCapabilities, audit);
		} else {
			const hostFn = hostNs ? (hostNs[memberName] as HostFunction | undefined) : undefined;
			ns[memberName] = buildFunction(qualifiedName, memberBinding, hostFn, grantedCapabilities, audit);
		}
	}

	return Object.freeze(ns);
}

export interface FireHookOptions {
	phase?: string;
	data?: unknown;
}

export type FragmentOpName =
	| "toggle"
	| "setText"
	| "replaceChildren"
	| "setProp"
	| "setAttr"
	| "addClass"
	| "removeClass";

/**
 * A command buffer entry. `selector` is the raw target string the mod passed and is always
 * populated: for an HTML-vocabulary fragment it is a working CSS selector, exactly as it
 * always was. `target` is that string parsed into a node reference, which resolves in any
 * vocabulary when it is an id.
 */
export interface FragmentOp {
	op: FragmentOpName;
	selector: string;
	target: NodeRef;
	/** `setProp` / `setAttr`. */
	prop?: string;
	/** @deprecated Alias of `prop`, populated only for `setAttr`. */
	attr?: string;
	value?: unknown;
}

/** An op as it leaves the sandbox, before the host-side pass parses and sanitizes it. */
export interface RawFragmentOp {
	op: FragmentOpName;
	selector: string;
	prop?: string;
	attr?: string;
	value?: unknown;
}

type HookHandlerEntry = { fn: (...args: unknown[]) => unknown };

interface HandlerRegistry {
	handlers: Map<string, HookHandlerEntry[]>;
	register(key: string, entry: HookHandlerEntry): void;
}

function createHandlerRegistry(): HandlerRegistry {
	const handlers = new Map<string, HookHandlerEntry[]>();
	return {
		handlers,
		register(key: string, entry: HookHandlerEntry) {
			let list = handlers.get(key);
			if (!list) {
				list = [];
				handlers.set(key, list);
			}
			list.push(entry);
		},
	};
}

function buildHooksGlobal(
	manifest: Manifest,
	grantedCapabilities: Set<string>,
	hookRegistry: HandlerRegistry,
	fragmentRegistry: HandlerRegistry,
): Record<string, unknown> {
	const hooksObj: Record<string, unknown> = {};

	const hooks = effectiveHooks(manifest);
	{
		for (const [hookName, hookDef] of Object.entries(hooks)) {
			if (hookDef.phases && hookDef.phases.length > 0) {
				const hookNs: Record<string, unknown> = {};

				for (const phase of hookDef.phases) {
					const registryKey = `${hookName}:${phase}`;
					hookNs[phase] = (handler: (...args: unknown[]) => unknown) => {
						if (hookDef.capability && !grantedSatisfies(grantedCapabilities, hookDef.capability)) {
							throw new CapabilityDeniedError(`hooks.${hookName}.${phase}`, hookDef.capability);
						}
						if (typeof handler !== "function") {
							throw new BindingError(`hooks.${hookName}.${phase}`, "expected a handler function");
						}
						hookRegistry.register(registryKey, { fn: handler });
					};
				}

				hooksObj[hookName] = Object.freeze(hookNs);
			} else {
				const registryKey = hookName;
				hooksObj[hookName] = (handler: (...args: unknown[]) => unknown) => {
					if (hookDef.capability && !grantedSatisfies(grantedCapabilities, hookDef.capability)) {
						throw new CapabilityDeniedError(`hooks.${hookName}`, hookDef.capability);
					}
					if (typeof handler !== "function") {
						throw new BindingError(`hooks.${hookName}`, "expected a handler function");
					}
					hookRegistry.register(registryKey, { fn: handler });
				};
			}
		}
	}

	const fragmentNs: Record<string, unknown> = {};
	const lifecycles = ["mount", "unmount", "update", "suspend", "resume"];
	for (const lifecycle of lifecycles) {
		fragmentNs[lifecycle] = (fragmentId: string, handler: (...args: unknown[]) => unknown) => {
			if (typeof handler !== "function") {
				throw new BindingError(`hooks.fragment.${lifecycle}`, "expected (fragmentId, handler)");
			}
			const registryKey = `fragment:${lifecycle}:${fragmentId}`;
			fragmentRegistry.register(registryKey, { fn: handler });
		};
	}
	hooksObj.fragment = Object.freeze(fragmentNs);

	return Object.freeze(hooksObj);
}

function buildEventsGlobal(
	manifest: Manifest,
	grantedCapabilities: Set<string>,
	eventRegistry: HandlerRegistry,
): Record<string, unknown> {
	const eventDefs = new Map<string, EventDef>();
	if (manifest.events) {
		for (const def of manifest.events) {
			eventDefs.set(def.id, def);
		}
	}

	function subscribe(eventId: string, handler: (...args: unknown[]) => unknown): void {
		const def = eventDefs.get(eventId);
		if (!def) {
			throw new BindingError(`events.on(${eventId})`, "event is not declared in the host manifest");
		}
		if (def.capability && !grantedSatisfies(grantedCapabilities, def.capability)) {
			throw new CapabilityDeniedError(`events.on(${eventId})`, def.capability);
		}
		if (typeof handler !== "function") {
			throw new BindingError(`events.on(${eventId})`, "expected a handler function");
		}
		eventRegistry.register(eventId, { fn: handler });
	}

	const eventsObj = {
		on: subscribe,
		subscribe,
	};

	return Object.freeze(eventsObj);
}

function emitFromRegistry(
	eventRegistry: HandlerRegistry,
	manifest: Manifest,
	eventId: string,
	payload?: unknown,
): unknown[] {
	const declared = manifest.events?.some((def) => def.id === eventId) ?? false;
	if (!declared) return [];

	const entries = eventRegistry.handlers.get(eventId);
	if (!entries || entries.length === 0) return [];

	const args = payload !== undefined
		? (typeof payload === "object" && payload !== null && !Array.isArray(payload)
			? Object.values(payload as Record<string, unknown>)
			: [payload])
		: [];

	const results: unknown[] = [];
	for (const entry of entries) {
		try {
			results.push(entry.fn(...args));
		} catch {
			results.push(undefined);
		}
	}
	return results;
}

function fireHookFromRegistry(
	hookRegistry: HandlerRegistry,
	manifest: Manifest,
	hookName: string,
	options?: FireHookOptions,
): unknown[] {
	const hookDef = effectiveHooks(manifest)[hookName];
	if (!hookDef) return [];

	let registryKey: string;
	if (options?.phase) {
		if (!hookDef.phases || !hookDef.phases.includes(options.phase)) {
			return [];
		}
		registryKey = `${hookName}:${options.phase}`;
	} else {
		registryKey = hookName;
	}

	const entries = hookRegistry.handlers.get(registryKey);
	if (!entries || entries.length === 0) return [];

	const data = options?.data;
	const args = data !== undefined
		? (typeof data === "object" && data !== null && !Array.isArray(data)
			? Object.values(data as Record<string, unknown>)
			: [data])
		: [];

	const results: unknown[] = [];
	for (const entry of entries) {
		try {
			results.push(entry.fn(...args));
		} catch {
			results.push(undefined);
		}
	}
	return results;
}

function fireFragmentHookFromRegistry(
	fragmentRegistry: HandlerRegistry,
	fragmentId: string,
	lifecycle: string,
	bindings?: Record<string, unknown>,
): RawFragmentOp[] {
	const registryKey = `fragment:${lifecycle}:${fragmentId}`;
	const entries = fragmentRegistry.handlers.get(registryKey);
	if (!entries || entries.length === 0) return [];

	const allOps: RawFragmentOp[] = [];
	for (const entry of entries) {
		const ops: RawFragmentOp[] = [];
		const fragmentProxy = {
			toggle(target: string, condition: unknown) { ops.push({ op: "toggle", selector: target, value: !!condition }); },
			addClass(target: string, className: string) { ops.push({ op: "addClass", selector: target, value: className }); },
			removeClass(target: string, className: string) { ops.push({ op: "removeClass", selector: target, value: className }); },
			setText(target: string, text: string) { ops.push({ op: "setText", selector: target, value: text }); },
			setProp(target: string, prop: string, value: unknown) { ops.push({ op: "setProp", selector: target, prop, value }); },
			setAttr(target: string, attr: string, value: unknown) { ops.push({ op: "setAttr", selector: target, attr, prop: attr, value }); },
			replaceChildren(target: string, content: unknown) {
				const value = Array.isArray(content) && content.every((c) => typeof c === "string")
					? content.join("")
					: content;
				ops.push({ op: "replaceChildren", selector: target, value });
			},
		};
		try {
			entry.fn(bindings, fragmentProxy);
		} catch {
			// swallow errors from individual handlers
		}
		allOps.push(...ops);
	}
	return allOps;
}

/**
 * The schema default deadline, applied where neither a slot nor the manifest
 * declares one. Pinned by `spec/slot-limit-tests.json`.
 */
export const DEFAULT_TIMEOUT_MS = 5000;

function clampLimit(requested: number | undefined, hard: number | undefined): number | undefined {
	if (requested === undefined) return hard;
	if (hard === undefined) return requested;
	return Math.min(requested, hard);
}

export interface SandboxResult {
	execute: (code: string) => ExecutionResult;
	executeAsync: (code: string) => Promise<ExecutionResult>;
	debugExecute: (code: string) => Promise<ExecutionResult>;
	evaluateModule: (modName: string, code: string) => Promise<string[]>;
	/**
	 * `timeoutOverrideMs` stands in for the manifest-wide budget for this one
	 * call — a slot's `limits.timeout_ms` arrives here, clamped to the
	 * embedder's ceiling.
	 */
	invokeExport: (name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number) => unknown;
	invokeExportAsync: (
		name: string,
		args: unknown[],
		owner?: string,
		timeoutOverrideMs?: number,
	) => Promise<unknown>;
	/**
	 * Scopes every subsequent `xript.exports.register` / module harvest to the named
	 * mod's own export namespace. Pass `null` to return to the host bucket.
	 */
	setExportOwner: (owner: string | null) => void;
	fireHook: (hookName: string, options?: FireHookOptions) => unknown[];
	emit: (eventId: string, payload?: unknown) => unknown[];
	fireFragmentHook: (fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>) => RawFragmentOp[];
	debugSession: () => DebugSession | null;
}

interface SourceTextModuleInstance {
	link(linker: (specifier: string) => SourceTextModuleInstance): Promise<void>;
	evaluate(): Promise<void>;
	readonly namespace: Record<string, unknown>;
	readonly status: string;
}

function validateLibraryRegistration(manifest: Manifest, libraries: Record<string, string> | undefined): void {
	for (const [specifier, source] of Object.entries(libraries ?? {})) {
		if (!manifest.libraries?.[specifier]) {
			throw new LibraryRegistrationError(specifier, "not declared in the host manifest's libraries map");
		}
		const artifact = detectCommonJS(source);
		if (artifact) {
			throw new LibraryRegistrationError(specifier, `CommonJS artifacts detected (found: ${artifact}); libraries must be pre-bundled ES modules`);
		}
		const nested = findImportSpecifier(source);
		if (nested !== null) {
			throw new LibraryRegistrationError(specifier, `not import-clean: contains an import of "${nested}"; libraries must be self-contained pre-bundled ES modules with no imports of their own`);
		}
	}
}

function makeLibraryResolver(
	manifest: Manifest,
	libraries: Record<string, string> | undefined,
	granted: Set<string>,
): (specifier: string) => string {
	return (specifier: string) => {
		const declaration = manifest.libraries?.[specifier];
		if (!declaration) throw new ImportDeniedError(specifier);
		if (declaration.capability && !grantedSatisfies(granted, declaration.capability)) {
			const error = new CapabilityDeniedError(specifier, declaration.capability);
			error.message = `import of "${specifier}" requires the "${declaration.capability}" capability, which hasn't been granted to this script. Ask the app developer to enable it.`;
			throw error;
		}
		const source = libraries?.[specifier];
		if (source === undefined) throw new LibraryUnavailableError(specifier);
		return source;
	};
}

interface SourceTextModuleCtor {
	new (code: string, options: { context: vm.Context; identifier?: string }): SourceTextModuleInstance;
}

function getSourceTextModule(): SourceTextModuleCtor | null {
	const ctor = (vm as unknown as { SourceTextModule?: SourceTextModuleCtor }).SourceTextModule;
	return ctor ?? null;
}

export function createSandbox(options: SandboxOptions): SandboxResult {
	const { manifest, capabilities = [], cancellation } = options;
	const grantedCapabilities = new Set(capabilities);
	validateLibraryRegistration(manifest, options.libraries);
	const resolveLibrary = makeLibraryResolver(manifest, options.libraries, grantedCapabilities);
	const libraryModules = new Map<string, SourceTextModuleInstance>();
	const limits = manifest.limits || {};
	const hard = options.hardLimits || {};
	const timeoutMs = clampLimit(limits.timeout_ms ?? 5000, hard.timeout_ms) ?? 5000;
	const hookRegistry = createHandlerRegistry();
	const fragmentRegistry = createHandlerRegistry();
	const eventRegistry = createHandlerRegistry();
	const exportRegistry = new Map<string, Map<string, HostFunction>>([["", new Map()]]);
	let exportOwner = "";

	function ownerBucket(owner: string): Map<string, HostFunction> {
		const existing = exportRegistry.get(owner);
		if (existing) return existing;
		const created = new Map<string, HostFunction>();
		exportRegistry.set(owner, created);
		return created;
	}

	function resolveExport(name: string, owner: string | undefined): HostFunction | undefined {
		if (owner !== undefined) return exportRegistry.get(owner)?.get(name);
		const owners: string[] = [];
		for (const [candidate, bucket] of exportRegistry) {
			if (bucket.has(name)) owners.push(candidate);
		}
		if (owners.length > 1) throw new AmbiguousExportError(name, owners);
		return owners.length === 1 ? exportRegistry.get(owners[0])!.get(name) : undefined;
	}

	function setExportOwner(owner: string | null): void {
		exportOwner = owner ?? "";
		ownerBucket(exportOwner);
	}

	const sandboxGlobals = buildSandboxGlobal(options);
	sandboxGlobals.hooks = buildHooksGlobal(manifest, grantedCapabilities, hookRegistry, fragmentRegistry);
	sandboxGlobals.events = buildEventsGlobal(manifest, grantedCapabilities, eventRegistry);

	const debugController = options.debug ? createDebugController(options.debug, "instrumented") : null;
	if (debugController) {
		sandboxGlobals[debugController.probeNames.shouldStop] = debugController.makeShouldStop();
		sandboxGlobals[debugController.probeNames.pause] = debugController.makePause();
	}

	const exportsApi = Object.freeze({
		register(name: string, fn: unknown) {
			if (typeof name !== "string" || name.length === 0) {
				throw new TypeError("xript.exports.register: name must be a non-empty string");
			}
			if (typeof fn !== "function") {
				throw new TypeError("xript.exports.register: fn must be a function");
			}
			ownerBucket(exportOwner).set(name, fn as HostFunction);
		},
	});
	sandboxGlobals.xript = Object.freeze({ exports: exportsApi });

	const context = vm.createContext(sandboxGlobals, {
		codeGeneration: {
			strings: false,
			wasm: false,
		},
	});

	sandboxGlobals.globalThis = context;

	function cleanStack(err: Error): void {
		if (!err.stack) return;
		err.stack = err.stack
			.split("\n")
			.filter((line) => !line.includes("node:vm") && !line.includes("node:internal"))
			.join("\n");
	}

	function isTimeoutError(e: unknown): boolean {
		if (typeof e !== "object" || e === null) return false;
		const err = e as Record<string, unknown>;
		if (err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return true;
		return typeof err.message === "string" && err.message.includes("Script execution timed out");
	}

	function wrapTimeoutError(e: unknown): never {
		if (isTimeoutError(e)) {
			throw new ExecutionLimitError(
				"timeout_ms",
				`Script timed out after ${timeoutMs}ms. Optimize your script or ask the app developer to increase the limit.`,
			);
		}
		if (e instanceof Error) cleanStack(e);
		throw e;
	}

	function execute(code: string): ExecutionResult {
		if (cancellation?.cancelled) throw new CancellationError();
		const start = performance.now();
		const script = new vm.Script(code, { filename: "xript-script.js" });
		try {
			const value = script.runInContext(context, { timeout: timeoutMs });
			const duration_ms = performance.now() - start;
			return { value, duration_ms };
		} catch (e) {
			return wrapTimeoutError(e);
		}
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		const start = performance.now();
		const wrappedCode = `(async () => { ${code} })()`;
		const script = new vm.Script(wrappedCode, { filename: "xript-script.js" });
		try {
			const promise = script.runInContext(context, { timeout: timeoutMs });
			const value = await promise;
			const duration_ms = performance.now() - start;
			return { value, duration_ms };
		} catch (e) {
			return wrapTimeoutError(e);
		}
	}

	/**
	 * The budget governing one call. An override (a slot's `limits.timeout_ms`)
	 * replaces the manifest's and is clamped to the embedder's ceiling rather
	 * than trusted, so a slot may widen only as far as the host allows.
	 */
	function callTimeoutMs(overrideMs?: number): number {
		if (overrideMs === undefined) return timeoutMs;
		return clampLimit(overrideMs, hard.timeout_ms) ?? timeoutMs;
	}

	const invokeScript = new vm.Script("__xript_call_fn.apply(undefined, __xript_call_args)", {
		filename: "xript-invoke.js",
	});

	/**
	 * Calls an export through `runInContext` rather than reaching into the
	 * context and calling the function handle directly. The direct call ran
	 * outside any deadline, so a handler could spin forever no matter what
	 * `limits` said; `vm`'s timeout only applies to code it is running. As with
	 * `execute`, the deadline bounds synchronous work — an `await` that never
	 * settles is not something `vm` can interrupt.
	 */
	function callWithBudget(fn: HostFunction, args: unknown[], budgetMs: number): unknown {
		const globals = sandboxGlobals as unknown as Record<string, unknown>;
		globals.__xript_call_fn = fn;
		globals.__xript_call_args = args;
		try {
			return invokeScript.runInContext(context, { timeout: budgetMs });
		} finally {
			delete globals.__xript_call_fn;
			delete globals.__xript_call_args;
		}
	}

	function invokeExport(name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		const fn = resolveExport(name, owner);
		if (!fn) throw new InvokeError(name, `export ${name} not found`);
		try {
			return callWithBudget(fn, args, callTimeoutMs(timeoutOverrideMs));
		} catch (e) {
			if (isTimeoutError(e)) return wrapTimeoutError(e);
			const message = e instanceof Error ? e.message : String(e);
			throw new InvokeError(name, message);
		}
	}

	async function invokeExportAsync(
		name: string,
		args: unknown[],
		owner?: string,
		timeoutOverrideMs?: number,
	): Promise<unknown> {
		if (cancellation?.cancelled) throw new CancellationError();
		const fn = resolveExport(name, owner);
		if (!fn) throw new InvokeError(name, `export ${name} not found`);
		try {
			return await callWithBudget(fn, args, callTimeoutMs(timeoutOverrideMs));
		} catch (e) {
			if (isTimeoutError(e)) return wrapTimeoutError(e);
			const message = e instanceof Error ? e.message : String(e);
			throw new InvokeError(name, message);
		}
	}

	async function debugExecute(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		if (!debugController) {
			throw new BindingError("debugExecute", "no debug session is attached to this runtime");
		}
		const { code: instrumented, breakableLines } = instrumentSource(code, debugController.probeNames);
		debugController.setBreakableLines("xript-script.js", breakableLines);
		const start = performance.now();
		const wrappedCode = `(async () => { ${instrumented} })()`;
		const script = new vm.Script(wrappedCode, { filename: "xript-script.js" });
		try {
			const promise = script.runInContext(context);
			const value = await promise;
			const duration_ms = performance.now() - start;
			debugController.session.resume();
			return { value, duration_ms };
		} catch (e) {
			return wrapTimeoutError(e);
		}
	}

	async function evaluateModule(modName: string, code: string): Promise<string[]> {
		if (cancellation?.cancelled) throw new CancellationError();

		for (const { specifier, dynamic } of findImportSpecifiers(code)) {
			if (dynamic) throw new ImportDeniedError(specifier);
			resolveLibrary(specifier);
		}

		const SourceTextModule = getSourceTextModule();
		if (!SourceTextModule) {
			throw new ModuleUnsupportedError(
				"module-format mods require Node's experimental vm modules; run node with --experimental-vm-modules",
			);
		}

		const ModuleCtor = SourceTextModule;
		function linkLibrary(spec: string): SourceTextModuleInstance {
			const cached = libraryModules.get(spec);
			if (cached) return cached;
			const library = new ModuleCtor(resolveLibrary(spec), { context, identifier: `xript-lib-${spec}` });
			libraryModules.set(spec, library);
			return library;
		}

		const mod = new SourceTextModule(code, { context, identifier: `xript-mod-${modName}` });
		try {
			await mod.link(linkLibrary);
			await mod.evaluate();
		} catch (e) {
			if (e instanceof ImportDeniedError || e instanceof CapabilityDeniedError || e instanceof LibraryUnavailableError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new ModEntryError(modName, message);
		}

		const namespace = mod.namespace;
		const harvested: string[] = [];
		for (const name of Object.keys(namespace)) {
			if (name === "default") continue;
			const value = namespace[name];
			if (typeof value !== "function") continue;
			const bucket = ownerBucket(exportOwner);
			if (bucket.has(name)) continue;
			bucket.set(name, value as HostFunction);
			harvested.push(name);
		}
		return harvested;
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		return fireHookFromRegistry(hookRegistry, manifest, hookName, opts);
	}

	function emit(eventId: string, payload?: unknown): unknown[] {
		return emitFromRegistry(eventRegistry, manifest, eventId, payload);
	}

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): RawFragmentOp[] {
		return fireFragmentHookFromRegistry(fragmentRegistry, fragmentId, lifecycle, bindings);
	}

	function debugSession(): DebugSession | null {
		return debugController ? debugController.session : null;
	}

	return { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, setExportOwner, fireHook, emit, fireFragmentHook, debugSession };
}
