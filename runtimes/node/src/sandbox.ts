import vm from "node:vm";
import { AmbiguousExportError, BindingError, CapabilityDeniedError, ExecutionLimitError, CancellationError, InvokeError, ModEntryError, ImportDeniedError, ModuleUnsupportedError, LibraryUnavailableError, LibraryRegistrationError, HostEventsError } from "./errors.js";
import { findImportSpecifier, findImportSpecifiers, detectCommonJS } from "./module-support.js";
import type { DebugOptions, DebugSession } from "./debug-types.js";
import { createDebugController } from "./debug-session.js";
import { instrumentSource } from "./debug-instrument.js";
import { grantedSatisfies } from "./capabilities.js";
import { LiveAccessor, RealmBridge } from "./realm.js";
import { CallbackScope, describeThrown, functionParamChecks, functionParamViolation, isThenable, resolveScopedProxy, type CallbackTracker } from "./callbacks.js";
import { CallerContext } from "./caller-context.js";
import { readConsoleArgument } from "./console-args.js";
import { CallbackError, CrossingRefusal } from "./errors.js";
import { DEFAULT_MAX_RETAINED_CALLBACKS, RetainedRegistry, retainPositions, type DeclaredTypes, type RetainedRecord } from "./retained.js";
import { trackContextRejections } from "./rejection-sink.js";
import type { NodeRef } from "./fragment.js";
import { resolveCallerAware } from "./with-caller.js";
import { installEventBus, type EmitResult } from "./event-bus.js";
import {
	DeprecationChannel,
	SHADOWING_BUILTINS,
	UNTIMED,
	reportShadowedBindings,
	unbudgetedHandlerClock,
	type DeprecationHandler,
	type HandlerClock,
} from "./deprecations.js";
import { hostAccessorFor, isAccessorBinding, omitsBinding, ownMember, presenceProbe, providedBindingPaths, type HostAccessor } from "./presence.js";

export { missingBindingNames } from "./presence.js";

/**
 * Refuses a dynamic `import(...)` from sandbox code with a branded error. The refusal is a
 * rejected promise rather than a synchronous throw: a throw here escapes a bare, un-awaited
 * `import(...)` as an uncaught exception, while a rejection makes the import's own promise
 * reject, so an awaited import throws a catchable `ImportDeniedError` and a floating one is a
 * sandbox-realm rejection the sink contains. Node honors the callback only under
 * `--experimental-vm-modules`; without the flag it refuses the import with its own error, and
 * the sink still keeps any floating rejection off the host process.
 */
function denyDynamicImport(specifier: string): Promise<never> {
	return Promise.reject(new ImportDeniedError(specifier));
}

const DENY_IMPORT = { importModuleDynamically: denyDynamicImport } as unknown as vm.ScriptOptions;

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
	types?: DeclaredTypes;
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
	limits?: { timeout_ms?: number };
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
			...(slot.limits?.timeout_ms !== undefined ? { limits: { timeout_ms: slot.limits.timeout_ms } } : {}),
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

type Binding = FunctionBinding | NamespaceBinding | AccessorBinding;

interface FunctionBinding {
	description: string;
	params?: Parameter[];
	returns?: unknown;
	async?: boolean;
	capability?: string;
	deprecated?: string;
	optional?: boolean;
}

interface NamespaceBinding {
	description: string;
	members: Record<string, Binding>;
	optional?: boolean;
}

interface AccessorBinding {
	description: string;
	accessor: "get" | "get-set";
	type?: unknown;
	capability?: string;
	deprecated?: string;
	optional?: boolean;
}

interface Parameter {
	name: string;
	type: unknown;
	default?: unknown;
	required?: boolean;
	optional?: boolean;
	variadic?: boolean;
	retain?: boolean;
}

interface CapabilityDef {
	description: string;
	risk?: string;
}

interface ExecutionLimits {
	timeout_ms?: number;
	memory_mb?: number;
	max_stack_depth?: number;
	max_retained_callbacks?: number;
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
	[key: string]: HostFunction | HostNamespace | HostAccessor;
}
export type HostBindings = Record<string, HostFunction | HostNamespace | HostAccessor>;
export type { HostAccessor };

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
	/** Receives deprecation notices; without it each code warns once on `console.warn`. */
	onDeprecation?: DeprecationHandler;
	/** Runs each hook and event fire under the script timeout, a fresh budget per fire. */
	budgetHandlers?: boolean;
	/** Installs the manifest's top-level `events` binding as the `events` global, in place of the built-in bus. */
	hostEvents?: boolean;
}

export interface ExecutionResult {
	value: unknown;
	duration_ms: number;
}

function isNamespace(binding: Binding): binding is NamespaceBinding {
	return "members" in binding;
}

function isAccessor(binding: Binding): binding is AccessorBinding {
	return isAccessorBinding(binding);
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

/**
 * Runs inside the context before any script. The context keeps its own realm's built-ins; this
 * defines the xript error classes in that realm, and refuses code generation everywhere a
 * script could reach a `Function` (the global, and the `.constructor` of every kind of function).
 */
const CONTEXT_PRELUDE = `"use strict";
(function () {
	var refuse = function () {
		throw new TypeError("Function() is not permitted. Dynamic code generation is disabled in xript.");
	};
	var prototypes = [
		Object.getPrototypeOf(function () {}),
		Object.getPrototypeOf(async function () {}),
		Object.getPrototypeOf(function* () {}),
		Object.getPrototypeOf(async function* () {}),
	];
	for (var i = 0; i < prototypes.length; i++) {
		Object.defineProperty(prototypes[i], "constructor", { value: refuse, writable: true, configurable: true });
	}
	globalThis.Function = refuse;
	globalThis.eval = function () {
		throw new TypeError("eval() is not permitted. Dynamic code generation is disabled in xript.");
	};
	var defineProperty = Object.defineProperty;
	function own(target, key, value) {
		defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
	}
	class BindingError extends Error {
		constructor(binding, message) {
			super(binding + "(): " + message);
			own(this, "name", "BindingError");
			own(this, "binding", binding);
		}
	}
	class CapabilityDeniedError extends Error {
		constructor(binding, capability) {
			super(binding + '() requires the "' + capability + '" capability, which hasn\\'t been granted to this script. Ask the app developer to enable it.');
			own(this, "name", "CapabilityDeniedError");
			own(this, "capability", capability);
			own(this, "binding", binding);
		}
	}
	globalThis.BindingError = BindingError;
	globalThis.CapabilityDeniedError = CapabilityDeniedError;
})();`;

/**
 * Defines `key` on `target` as an ordinary writable data property. Unlike an assignment it never
 * reaches a setter, so a name such as `__proto__` lands as a property instead of a prototype.
 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Locks every global the runtime installed for scripts, inside the context: each becomes a
 * non-writable, non-configurable property of `globalThis`, and `hooks`, `xript`, `console`, and
 * the error classes are frozen. A mod can then neither replace nor delete a binding another mod
 * calls.
 */
const SEAL_GLOBALS_SOURCE = `(function (names) {
	function deepFreeze(obj) {
		if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return obj;
		var keys = Object.getOwnPropertyNames(obj);
		for (var i = 0; i < keys.length; i++) {
			var descriptor = Object.getOwnPropertyDescriptor(obj, keys[i]);
			var value = descriptor && descriptor.value;
			if (value !== null && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
		}
		return Object.freeze(obj);
	}
	var frozenHolders = Object.create(null);
	frozenHolders.hooks = frozenHolders.xript = frozenHolders.console = true;
	frozenHolders.BindingError = frozenHolders.CapabilityDeniedError = true;
	for (var i = 0; i < names.length; i++) {
		var descriptor = Object.getOwnPropertyDescriptor(globalThis, names[i]);
		if (!descriptor) continue;
		if (descriptor.configurable) {
			if ("value" in descriptor) {
				Object.defineProperty(globalThis, names[i], { value: descriptor.value, writable: false, enumerable: descriptor.enumerable, configurable: false });
			} else {
				Object.defineProperty(globalThis, names[i], { get: descriptor.get, set: descriptor.set, enumerable: descriptor.enumerable, configurable: false });
			}
		}
		if (frozenHolders[names[i]] === true && "value" in descriptor) {
			deepFreeze(descriptor.value);
			if (typeof descriptor.value === "function" && descriptor.value.prototype) Object.freeze(descriptor.value.prototype);
		}
	}
})`;

function buildSandboxGlobal(options: SandboxOptions, tracker: CallbackTracker): Record<string, unknown> {
	const { manifest, hostBindings, capabilities = [] } = options;
	const grantedCapabilities = new Set(capabilities);
	const audit = options.audit;

	const sandboxConsole = options.console || {};

	const globals: Record<string, unknown> = {};

	const consoleObj: Record<string, unknown> = {};
	for (const method of Object.keys(CONSOLE_METHOD_SEVERITY)) {
		const severity = CONSOLE_METHOD_SEVERITY[method];
		consoleObj[method] = (...args: unknown[]) => dispatchConsole(sandboxConsole, method, severity, args.map(readConsoleArgument));
	}
	globals.console = consoleObj;

	if (manifest.bindings) {
		for (const [name, binding] of Object.entries(manifest.bindings)) {
			if (omitsBinding(binding, hostBindings, name)) {
				put(globals, name, undefined);
			} else if (isAccessor(binding)) {
				put(globals, name, buildAccessor(name, name, binding, hostBindings, grantedCapabilities, audit, tracker));
			} else if (isNamespace(binding)) {
				put(globals, name, buildNamespace(
					name,
					binding,
					ownMember(hostBindings, name) as HostNamespace | undefined,
					grantedCapabilities,
					audit,
					tracker,
				));
			} else {
				put(globals, name, buildFunction(
					name,
					binding,
					ownMember(hostBindings, name) as HostFunction | undefined,
					grantedCapabilities,
					audit,
					tracker,
				));
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
	tracker: CallbackTracker = { depth: 0, scopes: [] },
): HostFunction {
	const functionChecks = functionParamChecks(binding.params);
	const retainAt = retainPositions(binding.params, tracker.types);
	const gated = (...args: unknown[]) => {
		if (binding.capability && !grantedSatisfies(grantedCapabilities, binding.capability)) {
			throw new CapabilityDeniedError(qualifiedName, binding.capability);
		}

		if (!hostFn) {
			throw new BindingError(qualifiedName, "not implemented by the app");
		}

		const refusal = functionParamViolation(qualifiedName, functionChecks, args);
		if (refusal) throw new TypeError(refusal);

		if (binding.async && tracker.depth > 0) {
			throw new BindingError(qualifiedName, ASYNC_IN_CALLBACK_MESSAGE);
		}

		emitAudit(audit, qualifiedName, binding.capability ?? null);

		const hostFailure = (e: unknown): unknown => {
			if (e instanceof CapabilityDeniedError || e instanceof BindingError) return e;
			const message = e instanceof Error ? e.message : String(e);
			const prefix = `${qualifiedName}(): `;
			return new BindingError(qualifiedName, message.startsWith(prefix) ? message.slice(prefix.length) : message);
		};
		const scope = new CallbackScope(qualifiedName, tracker, retainAt);
		let wrapped: unknown[];
		try {
			wrapped = scope.wrapArgs(args);
		} catch (e) {
			scope.close();
			if (e instanceof CrossingRefusal) throw new BindingError(qualifiedName, e.message);
			throw e;
		}
		let result: unknown;
		tracker.scopes.push(scope);
		try {
			result = hostFn(...wrapped);
		} catch (e) {
			const original = scope.original(e);
			scope.close();
			if (original) throw original.value;
			throw hostFailure(e);
		} finally {
			const open = tracker.scopes.lastIndexOf(scope);
			if (open !== -1) tracker.scopes.splice(open, 1);
		}

		if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
			return (result as Promise<unknown>).then(
				(value) => {
					try {
						return scope.cross(value);
					} finally {
						scope.close();
					}
				},
				(e) => {
					const original = scope.original(e);
					scope.close();
					throw original ? original.value : hostFailure(e);
				},
			);
		}
		try {
			return scope.cross(result);
		} finally {
			scope.close();
		}
	};
	Object.defineProperty(gated, "name", { value: qualifiedName, configurable: true });
	return gated;
}

const ASYNC_IN_CALLBACK_MESSAGE =
	"cannot be called from inside a callback passed to a binding: it is async, and a callback runs synchronously";

/**
 * An accessor binding's getter and setter, built as ordinary binding wrappers so each access is
 * capability-gated, audited, and error-marshalled exactly as a function call. Without a setter,
 * assignment throws a `TypeError` in strict and sloppy code alike.
 */
function buildAccessor(
	qualifiedName: string,
	propName: string,
	binding: AccessorBinding,
	hostContainer: unknown,
	grantedCapabilities: Set<string>,
	audit?: (event: AuditEvent) => void,
	tracker: CallbackTracker = { depth: 0, scopes: [] },
): LiveAccessor {
	const supplied = hostAccessorFor(hostContainer, propName, binding.accessor);
	const gate: FunctionBinding = { description: binding.description, capability: binding.capability };
	const get = buildFunction(qualifiedName, gate, supplied?.get, grantedCapabilities, audit, tracker);
	const set =
		binding.accessor === "get-set"
			? buildFunction(qualifiedName, gate, supplied?.set, grantedCapabilities, audit, tracker)
			: () => {
					throw new TypeError(`${qualifiedName} is read-only: the host declares no setter`);
				};
	return new LiveAccessor(get, (value) => {
		set(value);
	});
}

function buildNamespace(
	namespaceName: string,
	binding: NamespaceBinding,
	hostNs: HostNamespace | undefined,
	grantedCapabilities: Set<string>,
	audit?: (event: AuditEvent) => void,
	tracker: CallbackTracker = { depth: 0, scopes: [] },
): Record<string, unknown> {
	const ns: Record<string, unknown> = {};

	for (const [memberName, memberBinding] of Object.entries(binding.members)) {
		const qualifiedName = `${namespaceName}.${memberName}`;
		if (omitsBinding(memberBinding, hostNs, memberName)) {
			put(ns, memberName, undefined);
		} else if (isAccessor(memberBinding)) {
			put(ns, memberName, buildAccessor(qualifiedName, memberName, memberBinding, hostNs, grantedCapabilities, audit, tracker));
		} else if (isNamespace(memberBinding)) {
			const nestedHostNs = ownMember(hostNs, memberName) as HostNamespace | undefined;
			put(ns, memberName, buildNamespace(qualifiedName, memberBinding, nestedHostNs, grantedCapabilities, audit, tracker));
		} else {
			const hostFn = ownMember(hostNs, memberName) as HostFunction | undefined;
			put(ns, memberName, buildFunction(qualifiedName, memberBinding, hostFn, grantedCapabilities, audit, tracker));
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
	| "removeAttr"
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
	/** `setProp` / `setAttr` / `removeAttr`. */
	prop?: string;
	/** @deprecated Alias of `prop`, populated only for `setAttr` and `removeAttr`. */
	attr?: string;
	/** Absent on `removeAttr`. */
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

type HookHandlerEntry = { fn: (...args: unknown[]) => unknown; owner?: string | null };

interface HandlerRegistry {
	handlers: Map<string, HookHandlerEntry[]>;
	register(key: string, entry: HookHandlerEntry): void;
	/** Runs `body` as the mod that registered `entry`. */
	dispatch<T>(entry: HookHandlerEntry, body: () => T): T;
}

/** A handler belongs to the mod running when it registered; dispatch runs it as that mod. */
function createHandlerRegistry(caller: CallerContext, clock: HandlerClock = UNTIMED): HandlerRegistry {
	const handlers = new Map<string, HookHandlerEntry[]>();
	return {
		handlers,
		dispatch: (entry, body) =>
			caller.run(entry.owner ?? null, () => {
				clock.start(caller.depth);
				try {
					return body();
				} finally {
					clock.stop(caller.depth);
				}
			}),
		register(key: string, entry: HookHandlerEntry) {
			entry.owner = caller.current();
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
					put(hookNs, phase, (handler: (...args: unknown[]) => unknown) => {
						if (hookDef.capability && !grantedSatisfies(grantedCapabilities, hookDef.capability)) {
							throw new CapabilityDeniedError(`hooks.${hookName}.${phase}`, hookDef.capability);
						}
						if (typeof handler !== "function") {
							throw new BindingError(`hooks.${hookName}.${phase}`, "expected a handler function");
						}
						hookRegistry.register(registryKey, { fn: handler });
					});
				}

				put(hooksObj, hookName, Object.freeze(hookNs));
			} else {
				const registryKey = hookName;
				put(hooksObj, hookName, (handler: (...args: unknown[]) => unknown) => {
					if (hookDef.capability && !grantedSatisfies(grantedCapabilities, hookDef.capability)) {
						throw new CapabilityDeniedError(`hooks.${hookName}`, hookDef.capability);
					}
					if (typeof handler !== "function") {
						throw new BindingError(`hooks.${hookName}`, "expected a handler function");
					}
					hookRegistry.register(registryKey, { fn: handler });
				});
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

function fireHookFromRegistry(
	hookRegistry: HandlerRegistry,
	manifest: Manifest,
	hookName: string,
	options: FireHookOptions | undefined,
	toContext: (value: unknown) => unknown,
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

	const data = options?.data;
	const args = data !== undefined
		? (typeof data === "object" && data !== null && !Array.isArray(data)
			? Object.values(data as Record<string, unknown>)
			: [data])
		: [];

	// A value that cannot cross into the sandbox (a released retained callback) fails the fire,
	// as it does in every other runtime, rather than being swallowed with a handler's throw.
	const prepared = args.map((arg) => toContext(arg));

	const entries = hookRegistry.handlers.get(registryKey);
	if (!entries || entries.length === 0) return [];

	const results: unknown[] = [];
	entries.forEach((entry, index) => {
		const handlerArgs = index === 0 ? prepared : args.map((arg) => toContext(arg));
		try {
			results.push(hookRegistry.dispatch(entry, () => entry.fn(...handlerArgs)));
		} catch {
			results.push(undefined);
		}
	});
	return results;
}

function fireFragmentHookFromRegistry(
	fragmentRegistry: HandlerRegistry,
	fragmentId: string,
	lifecycle: string,
	bindings: Record<string, unknown> | undefined,
	toContext: (value: unknown) => unknown,
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
			removeAttr(target: string, attr: string) { ops.push({ op: "removeAttr", selector: target, attr, prop: attr }); },
			replaceChildren(target: string, content: unknown) { ops.push({ op: "replaceChildren", selector: target, value: content }); },
		};
		try {
			fragmentRegistry.dispatch(entry, () => entry.fn(toContext(bindings), toContext(fragmentProxy)));
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
	/** {@link emit} with each result tagged by the mod that subscribed the handler. */
	emitTagged: (eventId: string, payload?: unknown) => EmitResult[];
	/** Cancels every subscription `owner` holds and returns how many there were. */
	cancelOwned: (owner: string | null) => number;
	/** Adds an event to the catalogue at runtime; returns the entry as stored. */
	declareEvent: (entry: unknown) => unknown;
	fireFragmentHook: (fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>) => RawFragmentOp[];
	debugSession: () => DebugSession | null;
	/** Releases every retained callback the named mod supplied, returning how many. */
	releaseRetained: (modName: string) => number;
	/** Which mod is running right now. */
	callerContext: CallerContext;
	/** Releases every retained callback and the process-level rejection containment this sandbox registered. */
	dispose: () => void;
}

interface SourceTextModuleInstance {
	link(linker: (specifier: string) => SourceTextModuleInstance): Promise<void>;
	evaluate(): Promise<void>;
	readonly namespace: Record<string, unknown>;
	readonly status: string;
}

/** The message for a host call into the built-in bus's API while the host's binding is `events`. */
function hostEventsRefusal(api: string): string {
	return `\`${api}\` is not available in host events mode: the host's own \`events\` binding is the bus mods see, so the built-in bus has no subscribers to reach`;
}

/**
 * Refuses construction in host events mode unless the manifest declares a top-level `events`
 * binding for the runtime to install. A manifest `events` catalogue is allowed; it documents the
 * host's events but is wired to no script-visible bus.
 */
function assertHostEventsManifest(manifest: Manifest, hostEvents: boolean | undefined): void {
	if (!hostEvents) return;
	if (!manifest.bindings || !Object.prototype.hasOwnProperty.call(manifest.bindings, "events")) {
		throw new HostEventsError("host events mode needs a top-level `events` binding in the manifest to install as the `events` global; declare one, or construct the runtime without host events mode to get the built-in bus");
	}
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
	new (code: string, options: { context: vm.Context; identifier?: string; importModuleDynamically?: unknown }): SourceTextModuleInstance;
}

function getSourceTextModule(): SourceTextModuleCtor | null {
	const ctor = (vm as unknown as { SourceTextModule?: SourceTextModuleCtor }).SourceTextModule;
	return ctor ?? null;
}

export function createSandbox(options: SandboxOptions): SandboxResult {
	const { manifest, capabilities = [], cancellation } = options;
	const grantedCapabilities = new Set(capabilities);
	validateLibraryRegistration(manifest, options.libraries);
	assertHostEventsManifest(manifest, options.hostEvents);
	const resolveLibrary = makeLibraryResolver(manifest, options.libraries, grantedCapabilities);
	const libraryModules = new Map<string, SourceTextModuleInstance>();
	const limits = manifest.limits || {};
	const hard = options.hardLimits || {};
	const timeoutMs = clampLimit(limits.timeout_ms ?? 5000, hard.timeout_ms) ?? 5000;
	const callerContext = new CallerContext();
	const deprecations = new DeprecationChannel(options.onDeprecation);
	const clock: HandlerClock = options.budgetHandlers ? UNTIMED : unbudgetedHandlerClock(timeoutMs, deprecations);
	const hookRegistry = createHandlerRegistry(callerContext, clock);
	const fragmentRegistry = createHandlerRegistry(callerContext);
	const exportRegistry = new Map<string, Map<string, HostFunction>>([["", new Map()]]);
	let exportOwner = "";

	function ownerBucket(owner: string): Map<string, HostFunction> {
		const existing = exportRegistry.get(owner);
		if (existing) return existing;
		const created = new Map<string, HostFunction>();
		exportRegistry.set(owner, created);
		return created;
	}

	/** The export and the mod that owns it (`null` for one a host-run script registered). */
	function resolveExport(name: string, owner: string | undefined): { fn: HostFunction; owner: string | null } | undefined {
		const found = (bucketOwner: string) => {
			const fn = exportRegistry.get(bucketOwner)?.get(name);
			return fn ? { fn, owner: bucketOwner === "" ? null : bucketOwner } : undefined;
		};
		if (owner !== undefined) return found(owner);
		const owners: string[] = [];
		for (const [candidate, bucket] of exportRegistry) {
			if (bucket.has(name)) owners.push(candidate);
		}
		if (owners.length > 1) throw new AmbiguousExportError(name, owners);
		return owners.length === 1 ? found(owners[0]) : undefined;
	}

	function setExportOwner(owner: string | null): void {
		exportOwner = owner ?? "";
		ownerBucket(exportOwner);
	}

	const tracker: CallbackTracker = { depth: 0, scopes: [], caller: callerContext, types: manifest.types };
	const retained = new RetainedRegistry(limits.max_retained_callbacks ?? DEFAULT_MAX_RETAINED_CALLBACKS, invokeRetained);
	tracker.retained = retained;
	const sandboxGlobals = buildSandboxGlobal(
		{ ...options, hostBindings: resolveCallerAware(options.hostBindings, callerContext) },
		tracker,
	);
	const shadowed = SHADOWING_BUILTINS.filter((name) => Object.prototype.hasOwnProperty.call(sandboxGlobals, name) && !(options.hostEvents && name === "events"));
	sandboxGlobals.hooks = buildHooksGlobal(manifest, grantedCapabilities, hookRegistry, fragmentRegistry);

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
	sandboxGlobals.xript = Object.freeze({
		exports: exportsApi,
		has: presenceProbe(providedBindingPaths(manifest.bindings, options.hostBindings)),
	});

	const contextGlobal: Record<string, unknown> = {};
	const context = vm.createContext(contextGlobal, {
		codeGeneration: {
			strings: false,
			wasm: false,
		},
	});
	const releaseRejectionSink = trackContextRejections(context);
	const realm = new RealmBridge(context);
	realm.resolveRetained = (value) => retained.resolve(value, callerContext.current());
	realm.resolveScoped = (fn) => resolveScopedProxy(fn, tracker);
	vm.runInContext(CONTEXT_PRELUDE, context, { filename: "xript-prelude.js" });
	const toContext = (value: unknown): unknown => realm.toContext(value);
	tracker.toContext = toContext;
	tracker.toHost = (value) => realm.toHost(value);
	const contextGlobalThis = vm.runInContext("globalThis", context) as object;
	for (const [name, value] of Object.entries(sandboxGlobals)) {
		if (value instanceof LiveAccessor) realm.defineAccessor(contextGlobalThis, name, value);
		else put(contextGlobal, name, realm.toContext(value));
	}
	const bus = installEventBus(context, realm, manifest.events, grantedCapabilities, callerContext, clock, !options.hostEvents);
	reportShadowedBindings(deprecations, shadowed);
	const sealGlobals = vm.runInContext(SEAL_GLOBALS_SOURCE, context, { filename: "xript-seal.js" }) as (names: string[]) => void;
	sealGlobals([...Object.keys(manifest.bindings ?? {}), "hooks", "events", "xript", "console", "BindingError", "CapabilityDeniedError", ...(debugController ? [debugController.probeNames.shouldStop, debugController.probeNames.pause] : [])]);

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
		throw toHostError(e);
	}

	/**
	 * Inside the sandbox the xript error classes are the context realm's own; an uncaught one
	 * leaving `execute` becomes the host's class again, so `instanceof` works for the host.
	 */
	function toHostError(e: unknown): unknown {
		if (e === null || typeof e !== "object" || e instanceof Error) return e;
		const err = e as { name?: unknown; message?: unknown; binding?: unknown; capability?: unknown };
		if (typeof err.binding !== "string") return e;
		let converted: Error | null = null;
		if (err.name === "CapabilityDeniedError" && typeof err.capability === "string") {
			converted = new CapabilityDeniedError(err.binding, err.capability);
		} else if (err.name === "BindingError") {
			converted = new BindingError(err.binding, "");
		}
		if (!converted) return e;
		converted.message = String(err.message);
		return converted;
	}

	/**
	 * A deadline stop terminates the script without running the `finally` blocks of the host
	 * code it was inside (binding calls, running callbacks, caller frames), so every
	 * `runInContext` marks that state first and puts it back when the run throws.
	 */
	function runGuarded<T>(run: () => T): T {
		const depth = tracker.depth;
		const scopes = tracker.scopes.length;
		const callers = callerContext.depth;
		try {
			return run();
		} catch (e) {
			tracker.depth = depth;
			tracker.scopes.length = scopes;
			callerContext.unwindTo(callers);
			throw e;
		}
	}

	function execute(code: string): ExecutionResult {
		if (cancellation?.cancelled) throw new CancellationError();
		const start = performance.now();
		const script = new vm.Script(code, { filename: "xript-script.js", ...DENY_IMPORT });
		try {
			const value = runGuarded(() => script.runInContext(context, { timeout: timeoutMs }));
			const duration_ms = performance.now() - start;
			return { value: realm.toHost(value), duration_ms };
		} catch (e) {
			return wrapTimeoutError(e);
		}
	}

	async function executeAsync(code: string): Promise<ExecutionResult> {
		if (cancellation?.cancelled) throw new CancellationError();
		const start = performance.now();
		const wrappedCode = `(async () => { ${code}\n})()`;
		const script = new vm.Script(wrappedCode, { filename: "xript-script.js", ...DENY_IMPORT });
		try {
			const promise = runGuarded(() => script.runInContext(context, { timeout: timeoutMs }));
			const value = await promise;
			const duration_ms = performance.now() - start;
			return { value: realm.toHost(value), duration_ms };
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
		...DENY_IMPORT,
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
		const globals = contextGlobal;
		globals.__xript_call_fn = fn;
		globals.__xript_call_args = toContext(args);
		try {
			return runGuarded(() => invokeScript.runInContext(context, { timeout: budgetMs }));
		} finally {
			delete globals.__xript_call_fn;
			delete globals.__xript_call_args;
		}
	}

	/**
	 * Calls a retained callback. Inside a running binding call it runs re-entrantly on that
	 * script call's budget, exactly as a call-scoped callback does; between script calls it gets
	 * a fresh budget of its own, and a stop fails only this call.
	 */
	function invokeRetained(record: RetainedRecord, args: unknown[]): unknown {
		const fn = record.fn as HostFunction;
		const inner = tracker.scopes[tracker.scopes.length - 1];
		if (inner) return callerContext.run(record.owner, () => inner.invoke(fn, args, record.binding));
		if (cancellation?.cancelled) throw new CancellationError();
		return callerContext.run(record.owner, () => {
			let result: unknown;
			tracker.depth++;
			try {
				result = callWithBudget(fn, args, timeoutMs);
			} catch (e) {
				if (isTimeoutError(e)) throw new CallbackError(record.binding, "limit");
				throw new CallbackError(record.binding, "threw", describeThrown(e));
			} finally {
				tracker.depth--;
			}
			if (isThenable(result)) throw new CallbackError(record.binding, "promise");
			return realm.toHost(result);
		});
	}

	function invokeExport(name: string, args: unknown[], owner?: string, timeoutOverrideMs?: number): unknown {
		if (cancellation?.cancelled) throw new CancellationError();
		const found = resolveExport(name, owner);
		if (!found) throw new InvokeError(name, `export ${name} not found`);
		try {
			return realm.toHost(callerContext.run(found.owner, () => callWithBudget(found.fn, args, callTimeoutMs(timeoutOverrideMs))));
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
		const found = resolveExport(name, owner);
		if (!found) throw new InvokeError(name, `export ${name} not found`);
		try {
			return realm.toHost(
				await callerContext.runAsync(found.owner, async () => callWithBudget(found.fn, args, callTimeoutMs(timeoutOverrideMs))),
			);
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
		const wrappedCode = `(async () => { ${instrumented}\n})()`;
		const script = new vm.Script(wrappedCode, { filename: "xript-script.js", ...DENY_IMPORT });
		try {
			const promise = script.runInContext(context);
			const value = await promise;
			const duration_ms = performance.now() - start;
			debugController.session.resume();
			return { value: realm.toHost(value), duration_ms };
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
			const library = new ModuleCtor(resolveLibrary(spec), { context, identifier: `xript-lib-${spec}`, ...DENY_IMPORT });
			libraryModules.set(spec, library);
			return library;
		}

		const mod = new SourceTextModule(code, { context, identifier: `xript-mod-${modName}`, ...DENY_IMPORT });
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
		const exported: Array<[string, unknown]> = [];
		try {
			for (const name of Object.keys(namespace)) {
				if (name !== "default") exported.push([name, namespace[name]]);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			throw new ModEntryError(modName, `could not read the module's exports: ${message}`);
		}
		for (const [name, value] of exported) {
			if (typeof value !== "function") continue;
			const bucket = ownerBucket(exportOwner);
			if (bucket.has(name)) continue;
			bucket.set(name, value as HostFunction);
			harvested.push(name);
		}
		return harvested;
	}

	const fireScript = new vm.Script("__xript_fire_fn()", { filename: "xript-fire.js", ...DENY_IMPORT });

	/**
	 * Runs one hook or event fire under `limitMs` when the host opted into handler budgets.
	 * `vm`'s timeout applies only to code it is running, so the fire is entered from a script;
	 * a failure from the fire itself is carried out of the realm untouched.
	 */
	function runFire<T>(limitMs: number | undefined, fire: () => T): T {
		if (limitMs === undefined) return fire();
		let value: T | undefined;
		let failure: { error: unknown } | undefined;
		contextGlobal.__xript_fire_fn = realm.toContext(() => {
			try {
				value = fire();
			} catch (error) {
				failure = { error };
			}
		});
		try {
			runGuarded(() => fireScript.runInContext(context, { timeout: limitMs }));
		} catch (e) {
			if (isTimeoutError(e)) {
				throw new ExecutionLimitError(
					"timeout_ms",
					`Script timed out after ${limitMs}ms. Optimize your script or ask the app developer to increase the limit.`,
				);
			}
			throw e;
		} finally {
			delete contextGlobal.__xript_fire_fn;
		}
		if (failure) throw failure.error;
		return value as T;
	}

	function hookLimitMs(hookName: string): number | undefined {
		if (!options.budgetHandlers) return undefined;
		const override = effectiveHooks(manifest)[hookName]?.limits?.timeout_ms;
		return override === undefined ? timeoutMs : (clampLimit(override, hard.timeout_ms) ?? timeoutMs);
	}

	function fireHook(hookName: string, opts?: FireHookOptions): unknown[] {
		return runFire(hookLimitMs(hookName), () => fireHookFromRegistry(hookRegistry, manifest, hookName, opts, toContext)).map(
			(result) => realm.toHost(result),
		);
	}

	function emitTagged(eventId: string, payload?: unknown): EmitResult[] {
		refuseInHostEvents("emit");
		return runFire(options.budgetHandlers ? timeoutMs : undefined, () => bus.emit(eventId, payload === undefined ? [] : [payload]));
	}

	function emit(eventId: string, payload?: unknown): unknown[] {
		return emitTagged(eventId, payload).map((result) => result.value);
	}

	function refuseInHostEvents(api: string): void {
		if (options.hostEvents) throw new HostEventsError(hostEventsRefusal(api));
	}

	const cancelOwned = (owner: string | null): number => {
		refuseInHostEvents("cancelOwned");
		return bus.cancelOwned(owner);
	};
	const declareEvent = (entry: unknown): unknown => {
		refuseInHostEvents("declareEvent");
		return bus.declare(entry);
	};

	function fireFragmentHook(fragmentId: string, lifecycle: string, bindings?: Record<string, unknown>): RawFragmentOp[] {
		return fireFragmentHookFromRegistry(fragmentRegistry, fragmentId, lifecycle, bindings, toContext);
	}

	function debugSession(): DebugSession | null {
		return debugController ? debugController.session : null;
	}

	function dispose(): void {
		retained.releaseAll();
		releaseRejectionSink();
	}

	function releaseRetained(modName: string): number {
		return retained.releaseOwner(modName);
	}

	return { execute, executeAsync, debugExecute, evaluateModule, invokeExport, invokeExportAsync, setExportOwner, fireHook, emit, emitTagged, cancelOwned, declareEvent, callerContext, fireFragmentHook, debugSession, releaseRetained, dispose };
}
